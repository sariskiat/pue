const fs = require('node:fs');
const path = require('node:path');
const { isProbablyBinary, isSensitiveFileName, decodeTextBuffer } = require('./repo-indexer');

const MAX_LIST_ENTRIES = 60;
const MAX_GREP_MATCHES = 25;
const MAX_READ_LINES = 200;
const MAX_READ_CHARS = 8000;
const MAX_GREP_FILES_SCANNED = 600;
const MAX_GREP_FILE_BYTES = 256 * 1024;

const SKIP_DIRS = new Set([
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
  '.vscode'
]);

const TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description: 'List files inside an attached repository or workspace test folder.',
    parameters: {
      type: 'object',
      properties: {
        rootName: { type: 'string', description: 'Optional attached root name to list; lists available roots when omitted and multiple exist.' },
        subpath: { type: 'string', description: 'Optional relative subdirectory inside rootName.' },
        maxEntries: { type: 'integer', description: 'Maximum entries to return (max 60).' }
      }
    }
  },
  {
    name: 'grep_files',
    description: 'Search text across attached repositories and workspace folders for a substring or identifier.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive text or code identifier to find.' },
        rootName: { type: 'string', description: 'Optional attached root name filter.' },
        subpath: { type: 'string', description: 'Optional relative subdirectory filter.' },
        maxMatches: { type: 'integer', description: 'Maximum matching lines to return (max 25).' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_file',
    description: 'Read a bounded line range (up to 200 lines) from a file inside an attached root.',
    parameters: {
      type: 'object',
      properties: {
        rootName: { type: 'string', description: 'Attached root name.' },
        relPath: { type: 'string', description: 'Relative file path inside rootName.' },
        startLine: { type: 'integer', description: '1-based start line (default 1).' },
        endLine: { type: 'integer', description: '1-based inclusive end line (max 200 lines per call).' }
      },
      required: ['rootName', 'relPath']
    }
  }
];

function sanitizeAttr(raw) {
  return String(raw || 'tool').replace(/["<>]/g, '');
}

function wrapToolContent(source, body) {
  const safeBody = String(body || '').replace(/<\/untrusted_context>/gi, '<\\/untrusted_context>');
  return `<untrusted_context source="${sanitizeAttr(source)}">\n${safeBody}\n</untrusted_context>`;
}

function hasForbiddenPathSegment(relOrSubpath) {
  const parts = String(relOrSubpath || '')
    .split(/[\\/]/)
    .filter(Boolean);
  for (const seg of parts) {
    if (SKIP_DIRS.has(seg.toLowerCase())) return true;
  }
  if (parts.length > 0 && isSensitiveFileName(parts[parts.length - 1])) return true;
  return false;
}

// Canonicalize the nearest existing ancestor so missing leaf files cannot bypass symlink checks.
function resolveExistingCanonical(targetPath) {
  const abs = path.resolve(targetPath);
  let probe = abs;
  const missingTail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missingTail.unshift(path.basename(probe));
    probe = parent;
  }
  const realBase = fs.realpathSync(probe);
  return missingTail.length ? path.join(realBase, ...missingTail) : realBase;
}

// Enforce canonical root containment and skip stale roots that were deleted on disk.
function resolveScopedPath(requestedPath, allowedRoots) {
  if (!requestedPath || !Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new Error(`Access denied outside attached roots: ${requestedPath}`);
  }
  const realTarget = resolveExistingCanonical(requestedPath);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const targetCmp = norm(realTarget);

  for (const rawRoot of allowedRoots) {
    const rootPath = typeof rawRoot === 'string' ? rawRoot : rawRoot && rawRoot.path;
    if (!rootPath || !fs.existsSync(rootPath)) continue;
    let realRoot;
    try {
      realRoot = fs.realpathSync(rootPath);
    } catch (_) {
      continue;
    }
    const rootCmp = norm(realRoot);
    if (targetCmp === rootCmp || targetCmp.startsWith(rootCmp + path.sep)) {
      return realTarget;
    }
  }
  throw new Error(`Access denied outside attached roots: ${requestedPath}`);
}

function normalizeRootEntries(allowedRoots) {
  const entries = [];
  const usedNames = new Map();
  for (const item of allowedRoots || []) {
    const rawPath = typeof item === 'string' ? item : item && item.path;
    if (!rawPath || !fs.existsSync(rawPath)) continue;
    let realRoot;
    try {
      realRoot = fs.realpathSync(rawPath);
    } catch (_) {
      continue;
    }
    const baseName = (typeof item === 'object' && item.name) || path.basename(realRoot);
    const count = usedNames.get(baseName) || 0;
    usedNames.set(baseName, count + 1);
    const uniqueName = count === 0 ? baseName : `${baseName}_${count + 1}`;
    entries.push({ name: uniqueName, path: realRoot });
  }
  return entries;
}

function createScopedToolbox(allowedRoots) {
  const roots = normalizeRootEntries(allowedRoots);
  const rootPathsOnly = roots.map((r) => r.path);

  function findRoot(rootName) {
    if (!roots.length) throw new Error('No repositories or test folders are attached.');
    if (!rootName) {
      if (roots.length === 1) return roots[0];
      return null;
    }
    const exact = roots.find((r) => r.name === rootName || r.name.toLowerCase() === String(rootName).toLowerCase());
    if (!exact) {
      throw new Error(`Unknown root "${rootName}". Attached roots: ${roots.map((r) => r.name).join(', ')}`);
    }
    return exact;
  }

  async function walkScopedFiles(rootEntry, subpath = '', cap = MAX_LIST_ENTRIES) {
    const startTarget = subpath ? path.join(rootEntry.path, subpath) : rootEntry.path;
    const canonicalStart = resolveScopedPath(startTarget, [rootEntry.path]);
    const visitedDirs = new Set([canonicalStart]);
    const collected = [];

    async function walk(absDir) {
      if (collected.length >= cap) return;
      let items;
      try {
        items = await fs.promises.readdir(absDir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const d of items) {
        if (collected.length >= cap) break;
        if (SKIP_DIRS.has(d.name.toLowerCase()) || isSensitiveFileName(d.name)) continue;
        const absChild = path.join(absDir, d.name);
        let realChild;
        try {
          realChild = resolveScopedPath(absChild, [rootEntry.path]);
        } catch (_) {
          continue;
        }
        let st;
        try {
          st = await fs.promises.stat(realChild);
        } catch (_) {
          continue;
        }
        if (st.isDirectory()) {
          if (visitedDirs.has(realChild)) continue;
          visitedDirs.add(realChild);
          await walk(realChild);
        } else if (st.isFile()) {
          const rel = path.relative(rootEntry.path, realChild).split(path.sep).join('/');
          collected.push({ relPath: rel, absPath: realChild, size: st.size });
        }
      }
    }

    await walk(canonicalStart);
    return collected;
  }

  async function runListFiles(args = {}) {
    const cap = Math.max(1, Math.min(MAX_LIST_ENTRIES, Number(args.maxEntries) || MAX_LIST_ENTRIES));
    const rootEntry = findRoot(args.rootName);
    if (!rootEntry) {
      const rootSummary = roots.map((r) => `- ${r.name}`).join('\n');
      return {
        content: wrapToolContent('list_files:roots', `Attached roots:\n${rootSummary}`),
        summary: 'Attached roots',
        isError: false
      };
    }
    const files = await walkScopedFiles(rootEntry, args.subpath || '', cap);
    const body = files.length ? files.map((f) => f.relPath).join('\n') : '(no files found)';
    return {
      content: wrapToolContent(`list_files:${rootEntry.name}`, body),
      summary: `${rootEntry.name}${args.subpath ? '/' + args.subpath : ''}`,
      isError: false
    };
  }

  async function runGrepFiles(args = {}) {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('grep_files requires a non-empty query.');
    const needle = query.toLowerCase();
    const maxMatches = Math.max(1, Math.min(MAX_GREP_MATCHES, Number(args.maxMatches) || MAX_GREP_MATCHES));
    const targetRoots = args.rootName ? [findRoot(args.rootName)] : roots;

    const matches = [];
    let scanned = 0;

    for (const r of targetRoots) {
      if (!r || matches.length >= maxMatches || scanned >= MAX_GREP_FILES_SCANNED) break;
      const files = await walkScopedFiles(r, args.subpath || '', MAX_GREP_FILES_SCANNED - scanned);
      for (const f of files) {
        if (matches.length >= maxMatches || scanned >= MAX_GREP_FILES_SCANNED) break;
        scanned++;
        if (f.size === 0 || f.size > MAX_GREP_FILE_BYTES) continue;
        let buf;
        try {
          buf = await fs.promises.readFile(f.absPath);
        } catch (_) {
          continue;
        }
        if (isProbablyBinary(buf)) continue;
        const lines = decodeTextBuffer(buf).split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx++) {
          if (lines[idx].toLowerCase().includes(needle)) {
            const snippet = lines[idx].trim().slice(0, 200);
            matches.push(`${r.name}/${f.relPath}:${idx + 1}: ${snippet}`);
            if (matches.length >= maxMatches) break;
          }
        }
      }
    }

    const body = matches.length ? matches.join('\n') : `No matches found for "${query}".`;
    return {
      content: wrapToolContent('grep_files', body),
      summary: `grep "${query.slice(0, 32)}"`,
      isError: false
    };
  }

  async function runReadFile(args = {}) {
    const rootEntry = findRoot(args.rootName);
    if (!rootEntry) {
      throw new Error(`Specify rootName from: ${roots.map((r) => r.name).join(', ')}`);
    }
    const relPath = String(args.relPath || '').trim();
    if (!relPath) throw new Error('read_file requires relPath.');

    const target = resolveScopedPath(path.join(rootEntry.path, relPath), rootPathsOnly);
    // Double-check target stays inside the requested rootEntry as well
    resolveScopedPath(target, [rootEntry.path]);
    const normRelCheck = path.relative(rootEntry.path, target).split(path.sep).join('/');
    if (hasForbiddenPathSegment(normRelCheck)) {
      throw new Error(`Access denied to excluded or sensitive file: ${rootEntry.name}/${normRelCheck}`);
    }

    if (!fs.existsSync(target)) {
      throw new Error(`File not found: ${rootEntry.name}/${relPath}`);
    }
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${rootEntry.name}/${relPath}`);
    }
    if (stat.size > MAX_GREP_FILE_BYTES) {
      throw new Error(`File exceeds 256 KB read limit: ${rootEntry.name}/${relPath}`);
    }
    const buf = await fs.promises.readFile(target);
    if (isProbablyBinary(buf)) {
      throw new Error(`Binary file cannot be read as text: ${rootEntry.name}/${relPath}`);
    }

    const lines = decodeTextBuffer(buf).replace(/\r\n/g, '\n').split('\n');
    const totalLines = lines.length;
    const startLine = Math.max(1, Number(args.startLine) || 1);
    const requestedEnd = Number(args.endLine) ? Math.max(startLine, Number(args.endLine)) : startLine + MAX_READ_LINES - 1;
    const endLine = Math.min(totalLines, startLine + MAX_READ_LINES - 1, requestedEnd);

    let body = lines
      .slice(startLine - 1, endLine)
      .map((l, idx) => `${startLine + idx}: ${l}`)
      .join('\n');

    let truncatedNote = '';
    if (body.length > MAX_READ_CHARS) {
      body = body.slice(0, MAX_READ_CHARS);
      truncatedNote = `\n[Truncated at ${MAX_READ_CHARS} chars; request a narrower startLine..endLine range]`;
    } else if (endLine < totalLines) {
      truncatedNote = `\n[Truncated: showing lines ${startLine}-${endLine} of ${totalLines}; call read_file with startLine=${endLine + 1} for more]`;
    }

    const normRel = path.relative(rootEntry.path, target).split(path.sep).join('/');
    const sourceHandle = `${rootEntry.name}/${normRel}:${startLine}-${endLine}`;
    return {
      content: wrapToolContent(sourceHandle, body + truncatedNote),
      summary: sourceHandle,
      sourceHandle,
      isError: false
    };
  }

  async function executeTool(name, args = {}) {
    try {
      if (name === 'list_files') return await runListFiles(args);
      if (name === 'grep_files') return await runGrepFiles(args);
      if (name === 'read_file') return await runReadFile(args);
      return {
        content: wrapToolContent('tool_error', `Unknown tool: ${name}`),
        summary: name,
        isError: true
      };
    } catch (err) {
      return {
        content: wrapToolContent('tool_error', (err && err.message) || String(err)),
        summary: name,
        isError: true
      };
    }
  }

  return {
    roots,
    hasRoots: roots.length > 0,
    executeTool
  };
}

module.exports = {
  TOOL_DEFINITIONS,
  resolveExistingCanonical,
  resolveScopedPath,
  normalizeRootEntries,
  createScopedToolbox
};
