const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { extractDocumentText, chunkText, scoreChunks } = require('../src/repo-indexer');

test('extractDocumentText decodes UTF-8 and UTF-16 BOM text formats cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-idx-doc-'));
  try {
    const mdPath = path.join(dir, 'notes.md');
    fs.writeFileSync(mdPath, '# Architecture\nBuilt an event queue with 99.95% delivery.\n', 'utf8');
    const mdRes = await extractDocumentText(mdPath);
    assert.match(mdRes.text, /99\.95% delivery/);
    assert.equal(mdRes.warning, undefined);

    const utf16Path = path.join(dir, 'utf16.txt');
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from('Senior AI Engineer experience', 'utf16le');
    fs.writeFileSync(utf16Path, Buffer.concat([bom, body]));
    const utf16Res = await extractDocumentText(utf16Path);
    assert.equal(utf16Res.text, 'Senior AI Engineer experience');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractDocumentText handles pdf, docx, and scanned zero-text pdf warnings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-idx-bin-'));
  const origLoad = Module._load;
  let pdfReturnText = 'Extracted PDF resume text';
  Module._load = function stubParsers(req, parent, isMain) {
    if (req === 'pdf-parse') {
      return async () => ({ text: pdfReturnText });
    }
    if (req === 'mammoth') {
      return { extractRawText: async () => ({ value: 'Extracted DOCX job description' }) };
    }
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    const pdfPath = path.join(dir, 'resume.pdf');
    const docxPath = path.join(dir, 'jd.docx');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake'));
    fs.writeFileSync(docxPath, Buffer.from('PK fake docx'));

    const okPdf = await extractDocumentText(pdfPath);
    assert.equal(okPdf.text, 'Extracted PDF resume text');
    assert.equal(okPdf.warning, undefined);

    pdfReturnText = '   \n  ';
    const scannedPdf = await extractDocumentText(pdfPath);
    assert.equal(scannedPdf.text, '');
    assert.match(scannedPdf.warning, /0 text characters|no extractable text/i);

    const okDocx = await extractDocumentText(docxPath);
    assert.equal(okDocx.text, 'Extracted DOCX job description');
  } finally {
    Module._load = origLoad;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chunkText builds unified bounded chunks with headings and line numbers', () => {
  const lines = [
    '# Experience',
    ...Array.from({ length: 25 }, (_, i) => `Line ${i + 1}: Built distributed worker pool handling ${i * 100} jobs per second.`),
    '## Projects',
    ...Array.from({ length: 20 }, (_, i) => `Project line ${i + 1}: Implemented resolveScopedPath security guard in Node.`)
  ];
  const chunks = chunkText(lines.join('\n'), {
    sourceId: 'doc_1',
    sourceLabel: 'resume.md',
    sourceKind: 'resume',
    relPath: '',
    maxChars: 600,
    overlapChars: 120
  });

  assert.ok(chunks.length >= 3, `expected >= 3 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.equal(c.sourceId, 'doc_1');
    assert.equal(c.sourceLabel, 'resume.md');
    assert.equal(c.sourceKind, 'resume');
    assert.ok(c.text.length <= 650, `chunk exceeded bound: ${c.text.length}`);
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
    assert.ok(Array.isArray(c.terms) && c.terms.length > 0);
  }
  assert.ok(chunks.some((c) => c.heading.includes('Experience')));
  assert.ok(chunks.some((c) => c.heading.includes('Projects')));
});

test('scoreChunks fuses BM25 + exact symbol matches via RRF and enforces maxPerSource', () => {
  const spamChunks = Array.from({ length: 5 }, (_, idx) => ({
    id: `spam_${idx}`,
    sourceId: 'repo_1',
    sourceLabel: 'repo/src/queue.js',
    sourceKind: 'repo',
    relPath: 'src/queue.js',
    heading: 'queue',
    startLine: idx * 20 + 1,
    endLine: (idx + 1) * 20,
    text: `Distributed queue retry backoff worker implementation block ${idx}.`,
    terms: ['distributed', 'queue', 'retry', 'backoff', 'worker', 'implementation']
  }));

  const symbolChunk = {
    id: 'sym_1',
    sourceId: 'repo_2',
    sourceLabel: 'pue/src/repo-tools.js',
    sourceKind: 'repo',
    relPath: 'src/repo-tools.js',
    heading: 'resolveScopedPath',
    startLine: 10,
    endLine: 35,
    text: 'function resolveScopedPath(requestedPath, allowedRoots) { return realTarget; }',
    terms: ['function', 'resolvescopedpath', 'requestedpath', 'allowedroots', 'realtarget']
  };

  const unrelatedChunk = {
    id: 'unrel_1',
    sourceId: 'doc_9',
    sourceLabel: 'notes.txt',
    sourceKind: 'notes',
    relPath: '',
    heading: '',
    startLine: 1,
    endLine: 5,
    text: 'Frontend color palette tokens and CSS border radius rules.',
    terms: ['frontend', 'color', 'palette', 'tokens', 'css', 'border', 'radius']
  };

  const all = [...spamChunks, symbolChunk, unrelatedChunk];

  const bySymbol = scoreChunks('How does resolveScopedPath guard paths?', all, { topK: 5, maxPerSource: 2 });
  assert.equal(bySymbol[0].id, 'sym_1');
  assert.equal(bySymbol.some((c) => c.id === 'unrel_1'), false);

  const byTopic = scoreChunks('distributed queue retry backoff', all, { topK: 5, maxPerSource: 2 });
  const queueHits = byTopic.filter((c) => c.sourceId === 'repo_1' && c.relPath === 'src/queue.js');
  assert.equal(queueHits.length, 2, 'maxPerSource=2 caps chunks per file');
});
