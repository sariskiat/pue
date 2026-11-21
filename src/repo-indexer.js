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

const MAX_DISCOVERED_ENTRIES = 5000;
const MAX_REPO_FILES = 500;
const MAX_REPO_FILE_BYTES = 256 * 1024;
const WALK_YIELD_EVERY = 50;

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.cache',
  '.idea',
  '.vscode',
  'coverage'
]);

const EXCLUDED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'poetry.lock',
  'gemfile.lock',
  'composer.lock',
  '.ds_store'
]);

const EXCLUDED_REPO_EXTS = new Set([
  '.svg',
  '.csv',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin'
]);

const EXT_LANGUAGES = {
  '.js': 'JavaScript',
  '.cjs': 'JavaScript',
  '.mjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.cpp': 'C++',
  '.c': 'C',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.sql': 'SQL'
};

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

function parseTopGitignore(rootPath) {
  const ignoreDirs = new Set();
  const ignoreExts = new Set();
  const ignoreNames = new Set();
  const gitignorePath = path.join(rootPath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return { ignoreDirs, ignoreExts, ignoreNames };
  try {
    const raw = fs.readFileSync(gitignorePath, 'utf8');
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const clean = line.replace(/^\/+/, '');
      if (clean.endsWith('/')) {
        ignoreDirs.add(clean.replace(/\/+$/, ''));
      } else if (/^\*\.[A-Za-z0-9_.-]+$/.test(clean)) {
        ignoreExts.add(clean.slice(1).toLowerCase());
      } else if (!clean.includes('*')) {
        ignoreNames.add(clean);
      }
    }
  } catch (_) {
    // Ignore unreadable .gitignore and rely on built-in exclusions.
  }
  return { ignoreDirs, ignoreExts, ignoreNames };
}

function readGitHeadSha(rootPath) {
  try {
    const headFile = path.join(rootPath, '.git', 'HEAD');
    if (!fs.existsSync(headFile)) return null;
    const headRaw = fs.readFileSync(headFile, 'utf8').trim();
    if (!headRaw) return null;
    if (!headRaw.startsWith('ref:')) return headRaw.slice(0, 7);
    const refRel = headRaw.replace(/^ref:\s*/, '').trim();
    const refFile = path.join(rootPath, '.git', refRel);
    if (fs.existsSync(refFile)) {
      return fs.readFileSync(refFile, 'utf8').trim().slice(0, 7) || null;
    }
    const packedFile = path.join(rootPath, '.git', 'packed-refs');
    if (fs.existsSync(packedFile)) {
      const lines = fs.readFileSync(packedFile, 'utf8').split(/\r?\n/);
      for (const l of lines) {
        if (l.endsWith(' ' + refRel)) return l.split(' ')[0].slice(0, 7);
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

function isInsideCanonicalRoot(realCandidate, realRoot) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const cand = norm(realCandidate);
  const root = norm(realRoot);
  return cand === root || cand.startsWith(root + path.sep);
}

// Rank manifests and primary source trees first so the 500-file cap keeps high-ROI files.
function foragePriority(relPath) {
  const base = path.basename(relPath).toLowerCase();
  if (/^(readme|agents|claude|spec)/i.test(base)) return 0;
  if (['package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml', 'makefile'].includes(base)) return 1;
  if (/^(src|lib|app|packages|services|cmd)\//i.test(relPath)) return 2;
  return 3;
}

function buildRepoCard(repoName, filesWithContent, languages, keyFiles) {
  const parts = [`Repository: ${repoName}`];
  if (languages.length) parts.push(`Languages: ${languages.join(', ')}`);
  if (keyFiles.length) parts.push(`Key files: ${keyFiles.slice(0, 12).join(', ')}`);

  const readme = filesWithContent.find((f) => /^readme/i.test(path.basename(f.relPath)));
  if (readme && readme.text) {
    const cleaned = readme.text.replace(/\s+/g, ' ').trim();
    if (cleaned) parts.push(`Overview: ${cleaned}`);
  }
  const pkgFile = filesWithContent.find((f) => path.basename(f.relPath).toLowerCase() === 'package.json');
  if (pkgFile && pkgFile.text) {
    try {
      const pkg = JSON.parse(pkgFile.text);
      const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).slice(0, 12);
      if (deps.length) parts.push(`Dependencies: ${deps.join(', ')}`);
    } catch (_) {
      // Malformed package.json does not block card assembly.
    }
  }

  let summary = parts.join('\n');
  if (summary.length > 1200) {
    summary = summary.slice(0, 1197).trimEnd() + '...';
  }
  return {
    summary,
    languages,
    keyFiles: keyFiles.slice(0, 12)
  };
}

async function indexRepository(rootPath, prevRepoRecord = null, opts = {}) {
  const repoId = opts.id || (prevRepoRecord && prevRepoRecord.id) || `repo_${crypto.randomBytes(6).toString('hex')}`;
  const repoName = opts.name || path.basename(rootPath);
  const maxDiscovery = opts.maxDiscoveredEntries || MAX_DISCOVERED_ENTRIES;
  const maxFiles = opts.maxFiles || MAX_REPO_FILES;

  if (!rootPath || !fs.existsSync(rootPath)) {
    return {
      id: repoId,
      rootPath,
      name: repoName,
      status: 'error',
      error: `Repository path not found: ${rootPath}`,
      indexedAt: Date.now(),
      headSha: null,
      fileCount: 0,
      fileMtimes: {},
      card: { summary: '', languages: [], keyFiles: [] },
      chunks: []
    };
  }

  const realRoot = await fs.promises.realpath(rootPath);
  const visitedRealDirs = new Set([realRoot]);
  const { ignoreDirs, ignoreExts, ignoreNames } = parseTopGitignore(realRoot);
  const headSha = readGitHeadSha(realRoot);

  const discovered = [];
  let visitedEntries = 0;

  async function walk(relDir) {
    if (discovered.length >= maxDiscovery) return;
    const absDir = relDir ? path.join(realRoot, relDir) : realRoot;
    let entries;
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (discovered.length >= maxDiscovery) break;
      visitedEntries++;
      if (visitedEntries % WALK_YIELD_EVERY === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const name = entry.name;
      const lowerName = name.toLowerCase();
      const relPosix = relDir ? `${relDir}/${name}` : name;

      if (EXCLUDED_DIRS.has(lowerName) || ignoreDirs.has(name) || ignoreDirs.has(relPosix)) continue;
      if (EXCLUDED_FILES.has(lowerName) || ignoreNames.has(name) || ignoreNames.has(relPosix)) continue;
      if (lowerName.endsWith('.min.js') || lowerName.endsWith('.min.css')) continue;

      const absEntry = path.join(absDir, name);
      let realEntry;
      try {
        realEntry = await fs.promises.realpath(absEntry);
      } catch (_) {
        continue;
      }
      if (!isInsideCanonicalRoot(realEntry, realRoot)) continue;

      let stat;
      try {
        stat = await fs.promises.stat(realEntry);
      } catch (_) {
        continue;
      }

      if (stat.isDirectory()) {
        if (visitedRealDirs.has(realEntry)) continue;
        visitedRealDirs.add(realEntry);
        await walk(relPosix);
      } else if (stat.isFile()) {
        if (stat.size === 0 || stat.size > MAX_REPO_FILE_BYTES) continue;
        const ext = path.extname(lowerName);
        if (EXCLUDED_REPO_EXTS.has(ext) || ignoreExts.has(ext)) continue;
        discovered.push({ relPath: relPosix, absPath: realEntry, mtimeMs: Math.trunc(stat.mtimeMs) });
      }
    }
  }

  await walk('');

  discovered.sort((a, b) => {
    const pa = foragePriority(a.relPath);
    const pb = foragePriority(b.relPath);
    if (pa !== pb) return pa - pb;
    return a.relPath.localeCompare(b.relPath);
  });

  const selectedFiles = discovered.slice(0, maxFiles);
  const prevMtimes = (prevRepoRecord && prevRepoRecord.fileMtimes) || {};
  const prevChunksByPath = new Map();
  if (prevRepoRecord && Array.isArray(prevRepoRecord.chunks)) {
    for (const c of prevRepoRecord.chunks) {
      if (!c.relPath) continue;
      let list = prevChunksByPath.get(c.relPath);
      if (!list) {
        list = [];
        prevChunksByPath.set(c.relPath, list);
      }
      list.push(c);
    }
  }

  const nextMtimes = {};
  const allChunks = [];
  const languageSet = new Set();
  const cardTextSamples = [];
  let indexedCount = 0;

  for (let i = 0; i < selectedFiles.length; i++) {
    if (i > 0 && i % WALK_YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const item = selectedFiles[i];
    const ext = path.extname(item.relPath).toLowerCase();
    if (EXT_LANGUAGES[ext]) languageSet.add(EXT_LANGUAGES[ext]);

    if (prevMtimes[item.relPath] === item.mtimeMs && prevChunksByPath.has(item.relPath)) {
      const reused = prevChunksByPath.get(item.relPath);
      nextMtimes[item.relPath] = item.mtimeMs;
      indexedCount++;
      allChunks.push(...reused);
      if (foragePriority(item.relPath) <= 1 && reused.length) {
        cardTextSamples.push({ relPath: item.relPath, text: reused.map((r) => r.text).join('\n') });
      }
      continue;
    }

    let buf;
    try {
      buf = await fs.promises.readFile(item.absPath);
    } catch (_) {
      continue;
    }
    if (isProbablyBinary(buf)) continue;
    const text = decodeTextBuffer(buf).trim();
    if (!text) continue;

    nextMtimes[item.relPath] = item.mtimeMs;
    indexedCount++;
    if (foragePriority(item.relPath) <= 1) {
      cardTextSamples.push({ relPath: item.relPath, text });
    }
    const fileChunks = chunkText(text, {
      sourceId: repoId,
      sourceLabel: `${repoName}/${item.relPath}`,
      sourceKind: 'repo',
      relPath: item.relPath
    });
    allChunks.push(...fileChunks);
  }

  const languages = Array.from(languageSet);
  const keyFiles = selectedFiles.slice(0, 12).map((f) => f.relPath);
  const card =
    prevRepoRecord &&
    prevRepoRecord.card &&
    prevRepoRecord.fileCount === indexedCount &&
    Object.keys(prevMtimes).length === Object.keys(nextMtimes).length &&
    Object.keys(nextMtimes).every((k) => prevMtimes[k] === nextMtimes[k])
      ? prevRepoRecord.card
      : buildRepoCard(repoName, cardTextSamples, languages, keyFiles);

  return {
    id: repoId,
    rootPath: realRoot,
    name: repoName,
    status: indexedCount > 0 ? 'ok' : 'warning',
    error: indexedCount > 0 ? '' : 'No indexable text or source files found in repository.',
    indexedAt: Date.now(),
    headSha,
    fileCount: indexedCount,
    fileMtimes: nextMtimes,
    card,
    chunks: allChunks
  };
}

module.exports = {
  TEXT_DOC_EXTS,
  isProbablyBinary,
  decodeTextBuffer,
  extractDocumentText,
  tokenizeTerms,
  chunkText,
  scoreChunks,
  indexRepository
};
