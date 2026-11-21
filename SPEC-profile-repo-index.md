# Module Spec: `profile-repo-index`

Parent spec: [SPEC.md](SPEC.md)
Depends on: `core-byok-fork`

## 1. Objective

Give `pue` a persistent **Global Candidate Profile** (`<userData>/profile-index.json`) that compiles your experience documents, local code repositories, and human-promoted interview lessons into unified, provenance-tracked chunks and compact repo cards (*Designing AI Agents* Ch. 3.4 Progressive Discovery and Ch. 4.3 Compile-Side RAG).

## 2. Unified Schema (`<userData>/profile-index.json`)

Persisted atomically via `settings-store-core.js` (`0600` permissions):

```javascript
// Unified Chunk shape shared across profile documents, repos, and workspace files
// {
//   id: 'chk_...',
//   sourceId: 'doc_...' | 'repo_...' | 'wf_...',
//   sourceLabel: 'resume.pdf' | 'my-agent/src/loop.py',
//   sourceKind: 'resume' | 'experience' | 'notes' | 'repo' | 'jd' | 'test',
//   relPath: 'src/loop.py', // '' for single documents
//   heading: 'Experience',  // section or symbol header when detected
//   startLine: 1,
//   endLine: 72,
//   text: '...',
//   terms: ['agent', 'loop', 'compaction']
// }

{
  version: 1,
  documents: [
    {
      id: 'doc_...',
      path: '/abs/path/to/resume.pdf',
      label: 'resume.pdf',
      kind: 'resume' | 'experience' | 'notes',
      status: 'ok' | 'warning' | 'error',
      error: '', // e.g. 'Scanned PDF yielded 0 text characters'
      mtimeMs: 1730000000000,
      charCount: 8420,
      chunks: [ /* Unified Chunk[] */ ]
    }
  ],
  repos: [
    {
      id: 'repo_...',
      rootPath: '/abs/path/to/repo',
      name: 'my-agent-project',
      status: 'ok' | 'warning' | 'error',
      error: '',
      indexedAt: 1730000000000,
      headSha: 'a1b2c3d', // null if not a git repo
      fileCount: 84,
      fileMtimes: { 'README.md': 1730000000000, 'src/index.js': 1730000001000 },
      card: {
        summary: 'Manifest + README summary (<= 1200 chars)',
        languages: ['JavaScript', 'Python'],
        keyFiles: ['README.md', 'package.json', 'src/index.js']
      },
      chunks: [ /* Unified Chunk[] */ ]
    }
  ],
  // Human-promoted cross-interview lessons from Failure Journals (Ch. 4.5)
  promotedLessons: [
    {
      id: 'les_...',
      topic: 'system_design_metrics',
      guidance: 'Always state P95 latency and throughput numbers from load tests.',
      sourceWorkspaceId: 'ws_...',
      admittedAt: 1730000000000,
      version: 1,
      status: 'accepted' | 'deprecated' | 'superseded',
      supersedesId: null
    }
  ]
}
```

## 3. Hardened Indexing Rules & Retrieval Scoring

- **Supported documents:** `.pdf` (`pdf-parse`), `.docx` (`mammoth`), `.md`, `.txt`, `.json`, `.yaml`, `.yml` (UTF-8 and UTF-16 BOM supported). If `.pdf` extraction yields `0` characters, record `status: 'warning'` and a clear message explaining text-layer absence instead of failing silently.
- **Async bounded repo walker (`indexRepository`):**
  - Yields to the event loop every `50` files so indexing never freezes Electron's main process.
  - Pre-sort discovery cap of `5,000` filesystem entries and indexed file cap of `500` source files per repo.
  - Tracks a `Set` of canonical `fs.realpathSync` directories to prevent symlink cycles and blocks any symlink resolving outside the canonical repo root.
  - Skips `.git`, `node_modules`, `dist`, `build`, `.next`, `.venv`, `venv`, `__pycache__`, `target`, `vendor`, lockfiles, minified bundles (`*.min.js`, `*.min.css`, `*.map`), `.svg`, `.csv`, binary files (null byte in first `4 KB`), and files over `256 KB`. Respects top-level `.gitignore` directory and extension globs.
  - **Forage priority (*Designing AI Agents* Ch. 3.4.2):** Prioritizes `README*`, `AGENTS.md`, `CLAUDE.md`, `SPEC*`, manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`), and `src/` / `lib/` / `app/` before secondary folders when building the `<= 1,200`-char `RepoCard` and selecting the `500` files.
- **Incremental refresh:** Compares git `HEAD` SHA (if `.git/HEAD` exists) and per-file `fileMtimes`; re-parses only added or modified files and prunes deleted files.
- **Hybrid RRF Scoring (`scoreChunks`):**
  - Computes two rankings per chunk: (1) BM25 lexical score over `terms` (caching corpus IDF in memory until index mutation) and (2) exact identifier/substring match count for camelCase, snake_case, and dotted code symbols.
  - Fuses both rankings with Reciprocal Rank Fusion: `score = 1 / (60 + rank_bm25) + 1 / (60 + rank_exact)`.
  - Enforces source diversity: at most `2` chunks per `(sourceId, relPath)` pair within `topK`.

## 4. Interfaces & Contracts

- `src/repo-indexer.js`:
  - `extractDocumentText(filePath) -> Promise<{ text, kind, warning? }>`
  - `chunkText(text, meta) -> Array<Chunk>`
  - `indexRepository(rootPath, prevRepoRecord?, opts?) -> Promise<RepoIndexRecord>`
  - `scoreChunks(query, chunks, { topK, maxPerSource }) -> Array<ScoredChunk>`
- `src/profile-store.js`:
  - `getProfile()`, `seedFromLegacy(seed)`, `addDocument(filePath, kind)`, `removeDocument(id)`, `addRepo(rootPath)`, `removeRepo(id)`, `reindexAll()`, `listAllowedRoots() -> string[]`
  - `promoteGlobalLesson(lessonInput)`, `deprecateGlobalLesson(id)`
- IPC handlers in `main.js` and `preload.js`:
  - `profile:get`, `profile:pick-doc`, `profile:pick-repo`, `profile:remove-item`, `profile:reindex`, `profile:deprecate-lesson`.

## 5. Boundaries

- **Always:** Skip binaries, minified bundles, and out-of-root symlinks; yield during directory walks; record `status` and `error` on unreadable or empty items without crashing.
- **Ask first:** Adding native C++ indexing dependencies.
- **Never:** Execute scripts or git hooks inside attached repos, or let an LLM write to `promotedLessons` without an explicit user IPC call.

## 6. Success Criteria

1. Indexing a repo containing `node_modules/`, `.git/`, minified `.min.js`, binary images, and a symlink pointing outside the repo skips all excluded items, prevents symlink escape/cycles, and builds a valid `card` and `Chunk[]`.
2. Re-indexing an unchanged repo reuses `fileMtimes` and completes in `< 100ms` without re-chunking unchanged files.
3. Attaching a zero-text scanned PDF sets `status: 'warning'` with a non-empty `error` string and `0` chunks without throwing.
4. `scoreChunks` with RRF ranks exact symbol matches (`resolveScopedPath`) alongside BM25 prose matches and enforces `maxPerSource = 2`.
