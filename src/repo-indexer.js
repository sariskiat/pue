const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEXT_DOC_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.rst', '.csv']);
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are',
  'was', 'were', 'have', 'has', 'had', 'not', 'but', 'what', 'when', 'where',
  'who', 'why', 'how', 'can', 'will', 'into', 'about', 'they', 'them', 'their',
  'our', 'out', 'use', 'used', 'using', 'all', 'any', 'each', 'more', 'most',
  'other', 'some', 'such', 'than', 'then', 'too', 'very', 'just', 'also'
]);

const RRF_K = 60;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const idfCache = new WeakMap();

// Decode UTF-8 and UTF-16 BOM buffers without leaving BOM markers in chunks.
function decodeTextBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le').replace(/\uFEFF/g, '');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le').replace(/\uFEFF/g, '');
  }
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

async function extractDocumentText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.promises.readFile(filePath);
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buf);
    const text = String((parsed && parsed.text) || '').trim();
    if (!text) {
      return {
        text: '',
        kind: 'pdf',
        warning: 'Scanned PDF yielded 0 text characters (no extractable text layer).'
      };
    }
    return { text, kind: 'pdf' };
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const parsed = await mammoth.extractRawText({ buffer: buf });
    const text = String((parsed && parsed.value) || '').trim();
    if (!text) {
      return { text: '', kind: 'docx', warning: 'DOCX file contained 0 text characters.' };
    }
    return { text, kind: 'docx' };
  }
  if (TEXT_DOC_EXTS.has(ext) || !isProbablyBinary(buf)) {
    const text = decodeTextBuffer(buf).trim();
    return { text, kind: ext.slice(1) || 'text' };
  }
  throw new Error(`Unsupported or binary file type: ${ext || '(none)'}`);
}

function isProbablyBinary(buf) {
  const limit = Math.min(buf.length, 4096);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// Split camelCase and snake_case alongside whole identifiers so both forms match.
function tokenizeTerms(text, { dedupe = true } = {}) {
  if (!text) return [];
  const rawMatches = String(text).match(/[A-Za-z0-9_+#.-]{2,}/g) || [];
  const out = [];
  for (const token of rawMatches) {
    const clean = token.replace(/^[.-]+|[.-]+$/g, '');
    if (clean.length < 2) continue;
    const lower = clean.toLowerCase();
    if (!STOPWORDS.has(lower)) out.push(lower);
    const parts = clean
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s./-]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2 && !STOPWORDS.has(p));
    for (const part of parts) {
      if (part !== lower) out.push(part);
    }
  }
  return dedupe ? Array.from(new Set(out)) : out;
}

function detectHeading(line) {
  const trimmed = line.trim();
  if (/^#{1,6}\s+/.test(trimmed)) return trimmed.replace(/^#{1,6}\s+/, '').slice(0, 80);
  const fnMatch = /^(?:export\s+)?(?:async\s+)?(?:function|class|def|interface|type)\s+([A-Za-z0-9_]+)/.exec(trimmed);
  if (fnMatch) return fnMatch[1];
  return '';
}

function makeChunkId(sourceId, relPath, startLine, endLine) {
  const digest = crypto
    .createHash('sha1')
    .update(`${sourceId}:${relPath}:${startLine}:${endLine}`)
    .digest('hex')
    .slice(0, 12);
  return `chk_${digest}`;
}

function chunkText(text, meta = {}) {
  const cleanText = String(text || '').replace(/\r\n/g, '\n');
  if (!cleanText.trim()) return [];

  const sourceId = meta.sourceId || 'src';
  const sourceLabel = meta.sourceLabel || '';
  const sourceKind = meta.sourceKind || 'notes';
  const relPath = meta.relPath || '';
  const maxChars = meta.maxChars || 900;
  const overlapChars = meta.overlapChars || 150;

  const lines = cleanText.split('\n');
  const chunks = [];
  let currentHeading = meta.heading || '';
  let startIdx = 0;

  while (startIdx < lines.length) {
    let charLen = 0;
    let endIdx = startIdx;
    let chunkHeading = currentHeading;

    while (endIdx < lines.length) {
      const line = lines[endIdx];
      const h = detectHeading(line);
      if (h) {
        currentHeading = h;
        if (endIdx === startIdx || !chunkHeading) chunkHeading = h;
      }
      const added = line.length + (endIdx > startIdx ? 1 : 0);
      if (endIdx > startIdx && charLen + added > maxChars) break;
      charLen += added;
      endIdx++;
    }

    const sliceLines = lines.slice(startIdx, endIdx);
    const body = sliceLines.map((l) => (l.length > maxChars ? l.slice(0, maxChars) : l)).join('\n').trim();
    if (body) {
      const startLine = startIdx + 1;
      const endLine = endIdx;
      chunks.push({
        id: makeChunkId(sourceId, relPath, startLine, endLine),
        sourceId,
        sourceLabel,
        sourceKind,
        relPath,
        heading: chunkHeading,
        startLine,
        endLine,
        text: body,
        terms: tokenizeTerms(`${chunkHeading} ${relPath} ${body}`, { dedupe: true })
      });
    }

    if (endIdx >= lines.length) break;

    let backChars = 0;
    let nextStart = endIdx;
    while (nextStart > startIdx + 1 && backChars < overlapChars) {
      nextStart--;
      backChars += lines[nextStart].length + 1;
    }
    startIdx = nextStart > startIdx ? nextStart : endIdx;
  }

  return chunks;
}

function getCorpusStats(chunks) {
  const cached = idfCache.get(chunks);
  if (cached && cached.length === chunks.length) return cached;

  const docFreq = new Map();
  let totalTerms = 0;
  for (const c of chunks) {
    const terms = Array.isArray(c.terms) ? c.terms : [];
    totalTerms += terms.length;
    const seen = new Set(terms);
    for (const t of seen) {
      docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
  }
  const stats = {
    length: chunks.length,
    avgLen: chunks.length > 0 ? Math.max(1, totalTerms / chunks.length) : 1,
    docFreq
  };
  idfCache.set(chunks, stats);
  return stats;
}

function extractExactIdentifiers(query) {
  const raw = String(query || '').match(/[A-Za-z0-9_./-]{3,}/g) || [];
  const symbols = new Set();
  for (const token of raw) {
    const hasCodeShape = /[A-Z].*[a-z]|[a-z].*[A-Z]|[_./-]|\d/.test(token);
    if (hasCodeShape || token.length >= 8) {
      symbols.add(token.toLowerCase());
    }
  }
  return Array.from(symbols);
}

// Fuse BM25 lexical ranking with exact identifier ranking via Reciprocal Rank Fusion.
function scoreChunks(query, chunks, opts = {}) {
  if (!query || !Array.isArray(chunks) || chunks.length === 0) return [];
  const topK = opts.topK || 5;
  const maxPerSource = opts.maxPerSource || 2;

  const queryTerms = tokenizeTerms(query, { dedupe: true });
  const exactSymbols = extractExactIdentifiers(query);
  if (queryTerms.length === 0 && exactSymbols.length === 0) return [];

  const { length: nDocs, avgLen, docFreq } = getCorpusStats(chunks);
  const bm25Scores = new Map();
  const exactScores = new Map();

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const terms = Array.isArray(c.terms) ? c.terms : [];
    const termSet = new Set(terms);
    const haystackLower = `${c.sourceLabel || ''} ${c.relPath || ''} ${c.heading || ''}\n${c.text || ''}`.toLowerCase();

    let bm25 = 0;
    for (const qt of queryTerms) {
      if (!termSet.has(qt)) continue;
      const df = docFreq.get(qt) || 0;
      const idf = Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
      let tf = 0;
      let pos = haystackLower.indexOf(qt);
      while (pos !== -1 && tf < 8) {
        tf++;
        pos = haystackLower.indexOf(qt, pos + qt.length);
      }
      if (tf === 0) tf = 1;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (terms.length / avgLen));
      bm25 += idf * ((tf * (BM25_K1 + 1)) / denom);
    }
    if (bm25 > 0) bm25Scores.set(i, bm25);

    let exactHits = 0;
    for (const sym of exactSymbols) {
      if (haystackLower.includes(sym)) exactHits++;
    }
    if (exactHits > 0) exactScores.set(i, exactHits);
  }

  const bm25Order = Array.from(bm25Scores.entries()).sort((a, b) => b[1] - a[1]);
  const exactOrder = Array.from(exactScores.entries()).sort((a, b) => b[1] - a[1]);

  const rrfScores = new Map();
  bm25Order.forEach(([idx], rankIdx) => {
    rrfScores.set(idx, (rrfScores.get(idx) || 0) + 1 / (RRF_K + rankIdx + 1));
  });
  exactOrder.forEach(([idx], rankIdx) => {
    rrfScores.set(idx, (rrfScores.get(idx) || 0) + 1 / (RRF_K + rankIdx + 1));
  });

  const ranked = Array.from(rrfScores.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (bm25Scores.get(b[0]) || 0) - (bm25Scores.get(a[0]) || 0);
  });

  const selected = [];
  const perSourceCounts = new Map();
  for (const [idx, score] of ranked) {
    if (selected.length >= topK) break;
    const chunk = chunks[idx];
    const sourceKey = `${chunk.sourceId || ''}::${chunk.relPath || ''}`;
    const used = perSourceCounts.get(sourceKey) || 0;
    if (used >= maxPerSource) continue;
    perSourceCounts.set(sourceKey, used + 1);
    selected.push({ ...chunk, score });
  }

  return selected;
}

module.exports = {
  TEXT_DOC_EXTS,
  isProbablyBinary,
  decodeTextBuffer,
  extractDocumentText,
  tokenizeTerms,
  chunkText,
  scoreChunks
};
