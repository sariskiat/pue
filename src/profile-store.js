const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createFileStore } = require('./settings-store-core');
const { extractDocumentText, chunkText, indexRepository } = require('./repo-indexer');

const EMPTY_PROFILE = {
  version: 1,
  legacySeeded: false,
  documents: [],
  repos: [],
  promotedLessons: []
};

function createProfileStore(resolveUserDataDir) {
  const fileStore = createFileStore(resolveUserDataDir, 'profile-index.json');
  let state = null;

  function load() {
    if (state) return state;
    const loaded = fileStore.load();
    const raw = (loaded && loaded.data) || {};
    state = {
      version: 1,
      legacySeeded: !!raw.legacySeeded,
      documents: Array.isArray(raw.documents) ? raw.documents : [],
      repos: Array.isArray(raw.repos) ? raw.repos : [],
      promotedLessons: Array.isArray(raw.promotedLessons) ? raw.promotedLessons : []
    };
    if (loaded && loaded.recoveredFromBackup) save();
    return state;
  }

  function save() {
    fileStore.persist(state);
  }

  function getProfile() {
    return load();
  }

  function getProfileSummary() {
    const p = load();
    return {
      version: p.version,
      documents: p.documents.map((d) => ({
        id: d.id,
        path: d.path,
        label: d.label,
        kind: d.kind,
        status: d.status,
        error: d.error || '',
        mtimeMs: d.mtimeMs,
        charCount: d.charCount,
        chunkCount: Array.isArray(d.chunks) ? d.chunks.length : 0
      })),
      repos: p.repos.map((r) => ({
        id: r.id,
        rootPath: r.rootPath,
        name: r.name,
        status: r.status,
        error: r.error || '',
        indexedAt: r.indexedAt,
        headSha: r.headSha,
        fileCount: r.fileCount,
        chunkCount: Array.isArray(r.chunks) ? r.chunks.length : 0,
        card: r.card
      })),
      promotedLessons: p.promotedLessons
    };
  }

  async function addDocument(filePath, kind = 'experience') {
    const p = load();
    let canonical = path.resolve(filePath);
    try {
      canonical = await fs.promises.realpath(filePath);
    } catch (_) {
      // Keep resolved path so missing-file status is recorded cleanly.
    }

    const existing = p.documents.find((d) => d.path === canonical);
    const docId = existing ? existing.id : `doc_${crypto.randomBytes(6).toString('hex')}`;
    const label = path.basename(canonical);

    let record;
    try {
      const stat = await fs.promises.stat(canonical);
      const extracted = await extractDocumentText(canonical);
      const text = extracted.text || '';
      const chunks = text
        ? chunkText(text, {
            sourceId: docId,
            sourceLabel: label,
            sourceKind: kind,
            relPath: ''
          })
        : [];
      record = {
        id: docId,
        path: canonical,
        label,
        kind,
        status: extracted.warning ? 'warning' : 'ok',
        error: extracted.warning || '',
        mtimeMs: Math.trunc(stat.mtimeMs),
        charCount: text.length,
        chunks
      };
    } catch (err) {
      record = {
        id: docId,
        path: canonical,
        label,
        kind,
        status: 'error',
        error: (err && err.message) || String(err),
        mtimeMs: 0,
        charCount: 0,
        chunks: []
      };
    }

    if (existing) {
      Object.assign(existing, record);
    } else {
      p.documents.push(record);
    }
    save();
    return record;
  }

  async function addRepo(rootPath) {
    const p = load();
    let canonical = path.resolve(rootPath);
    try {
      canonical = await fs.promises.realpath(rootPath);
    } catch (_) {
      // Fall back to resolved path when target is missing.
    }
    const existing = p.repos.find((r) => r.rootPath === canonical);
    const indexed = await indexRepository(canonical, existing || null, {
      id: existing ? existing.id : undefined
    });
    if (existing) {
      Object.assign(existing, indexed);
    } else {
      p.repos.push(indexed);
    }
    save();
    return indexed;
  }

  function removeDocument(id) {
    const p = load();
    const before = p.documents.length;
    p.documents = p.documents.filter((d) => d.id !== id);
    if (p.documents.length !== before) save();
    return p.documents.length !== before;
  }

  function removeRepo(id) {
    const p = load();
    const before = p.repos.length;
    p.repos = p.repos.filter((r) => r.id !== id);
    if (p.repos.length !== before) save();
    return p.repos.length !== before;
  }

  function removeItem(id) {
    return removeDocument(id) || removeRepo(id);
  }

  async function reindexAll() {
    const p = load();
    for (let i = 0; i < p.documents.length; i++) {
      const d = p.documents[i];
      p.documents[i] = await addDocument(d.path, d.kind);
    }
    for (let i = 0; i < p.repos.length; i++) {
      const r = p.repos[i];
      p.repos[i] = await indexRepository(r.rootPath, r, { id: r.id, name: r.name });
    }
    save();
    return getProfileSummary();
  }

  function listAllowedRoots() {
    const p = load();
    const roots = [];
    for (const r of p.repos) {
      if (r.rootPath && fs.existsSync(r.rootPath)) {
        try {
          roots.push(fs.realpathSync(r.rootPath));
        } catch (_) {
          // Skip stale roots that disappeared on disk.
        }
      }
    }
    return Array.from(new Set(roots));
  }

  function listAllowedRootEntries() {
    const p = load();
    const out = [];
    for (const r of p.repos) {
      if (!r.rootPath || !fs.existsSync(r.rootPath)) continue;
      try {
        out.push({ name: r.name || path.basename(r.rootPath), path: fs.realpathSync(r.rootPath) });
      } catch (_) {
        // Ignore unreadable roots.
      }
    }
    return out;
  }

  function getAllChunks() {
    const p = load();
    const out = [];
    for (const d of p.documents) {
      if (Array.isArray(d.chunks)) out.push(...d.chunks);
    }
    for (const r of p.repos) {
      if (Array.isArray(r.chunks)) out.push(...r.chunks);
    }
    return out;
  }

  async function seedFromLegacy(seed) {
    const p = load();
    if (p.legacySeeded || !seed) return false;
    const sections = [];
    if (seed.resumeText && seed.resumeText.trim()) {
      sections.push(`# Legacy Resume\n${seed.resumeText.trim()}`);
    }
    if (seed.starStories && seed.starStories.trim()) {
      sections.push(`# STAR Stories\n${seed.starStories.trim()}`);
    }
    if (seed.workStyle && seed.workStyle.trim()) {
      sections.push(`# Work Style\n${seed.workStyle.trim()}`);
    }
    p.legacySeeded = true;
    if (!sections.length) {
      save();
      return false;
    }
    const seedFile = path.join(resolveUserDataDir(), 'migrated-profile-background.md');
    await fs.promises.mkdir(path.dirname(seedFile), { recursive: true });
    await fs.promises.writeFile(seedFile, sections.join('\n\n') + '\n', { mode: 0o600 });
    await addDocument(seedFile, 'resume');
    return true;
  }

  function promoteGlobalLesson(input = {}) {
    const p = load();
    const guidance = String(input.guidance || '').trim();
    if (!guidance) throw new Error('Lesson guidance cannot be empty.');
    const supersedesId = input.supersedesId || null;
    let nextVersion = 1;
    if (supersedesId) {
      const prev = p.promotedLessons.find((l) => l.id === supersedesId);
      if (prev) {
        prev.status = 'superseded';
        nextVersion = (prev.version || 1) + 1;
      }
    }
    const lesson = {
      id: `les_${crypto.randomBytes(6).toString('hex')}`,
      topic: String(input.topic || 'general').trim(),
      guidance,
      sourceWorkspaceId: input.sourceWorkspaceId || null,
      admittedAt: Date.now(),
      version: nextVersion,
      status: 'accepted',
      supersedesId
    };
    p.promotedLessons.push(lesson);
    save();
    return lesson;
  }

  function deprecateGlobalLesson(id) {
    const p = load();
    const target = p.promotedLessons.find((l) => l.id === id);
    if (!target) return false;
    target.status = 'deprecated';
    save();
    return true;
  }

  function getActiveLessons() {
    return load().promotedLessons.filter((l) => l.status === 'accepted');
  }

  return {
    getProfile,
    getProfileSummary,
    addDocument,
    addRepo,
    removeDocument,
    removeRepo,
    removeItem,
    reindexAll,
    listAllowedRoots,
    listAllowedRootEntries,
    getAllChunks,
    seedFromLegacy,
    promoteGlobalLesson,
    deprecateGlobalLesson,
    getActiveLessons
  };
}

module.exports = { EMPTY_PROFILE, createProfileStore };
