const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createFileStore } = require('./settings-store-core');
const { extractDocumentText, chunkText, indexRepository } = require('./repo-indexer');
const { buildDissectionPrompt, parseDissection } = require('./round-dissector');

const MAX_SCAN_ENTRIES = 2000;
const MAX_QA_TURNS_IN_RAM = 20;
const MIN_TURNS_FOR_DISSECTION = 4;
const RESUME_WINDOW_MS = 30 * 60 * 1000;

function defaultAppendLine(filePath, content, isNew) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (isNew) {
    fs.writeFileSync(filePath, content, { mode: 0o600 });
  } else {
    fs.appendFileSync(filePath, content, { mode: 0o600 });
  }
}

function emptyPrepBrief() {
  return {
    generatedAt: null,
    summary: '',
    repoMatches: [],
    testPlan: [],
    likelyQuestions: [],
    priorRoundFocus: []
  };
}

function createWorkspaceStore(resolveUserDataDir, opts = {}) {
  const debounceMs = opts.debounceMs !== undefined ? opts.debounceMs : 1500;
  const now = opts.now || Date.now;
  const appendLineFn = opts.appendLineFn || defaultAppendLine;

  function workspacesRoot() {
    return path.join(resolveUserDataDir(), 'workspaces');
  }

  const indexFileStore = createFileStore(workspacesRoot, 'index.json');
  const wsFileStores = new Map();
  const wsCache = new Map();
  const wsTimers = new Map();
  const ledgerCache = new Map();
  let indexData = null;

  function ensureWorkspacesDir() {
    fs.mkdirSync(workspacesRoot(), { recursive: true, mode: 0o700 });
  }

  function wsStoreFor(wsId) {
    let fsStore = wsFileStores.get(wsId);
    if (!fsStore) {
      fsStore = createFileStore(workspacesRoot, `${wsId}.json`);
      wsFileStores.set(wsId, fsStore);
    }
    return fsStore;
  }

  function saveIndex() {
    ensureWorkspacesDir();
    indexFileStore.persist(indexData);
  }

  function persistWorkspaceNow(wsId) {
    const timer = wsTimers.get(wsId);
    if (timer) {
      clearTimeout(timer);
      wsTimers.delete(wsId);
    }
    const ws = wsCache.get(wsId);
    if (!ws) return;
    ensureWorkspacesDir();
    wsStoreFor(wsId).persist(ws);
    if (indexData) {
      const idxEntry = indexData.items.find((it) => it.id === wsId);
      if (idxEntry) {
        idxEntry.company = ws.company;
        idxEntry.role = ws.role;
        idxEntry.updatedAt = ws.updatedAt;
      }
      saveIndex();
    }
  }

  function scheduleWorkspaceSave(wsId, immediate = false) {
    if (immediate || debounceMs <= 0) {
      persistWorkspaceNow(wsId);
      return;
    }
    if (wsTimers.has(wsId)) return;
    const t = setTimeout(() => {
      wsTimers.delete(wsId);
      persistWorkspaceNow(wsId);
    }, debounceMs);
    wsTimers.set(wsId, t);
  }

  function flushAll() {
    for (const wsId of Array.from(wsTimers.keys())) {
      persistWorkspaceNow(wsId);
    }
    if (indexData) saveIndex();
  }

  function loadIndex() {
    if (indexData) return indexData;
    ensureWorkspacesDir();
    const loaded = indexFileStore.load();
    const raw = (loaded && loaded.data) || {};
    indexData = {
      version: 1,
      activeWorkspaceId: raw.activeWorkspaceId || null,
      items: Array.isArray(raw.items) ? raw.items : []
    };
    if (indexData.items.length === 0) {
      const def = createWorkspaceInternal({ company: 'Default', role: 'General Interview' });
      indexData.activeWorkspaceId = def.id;
      saveIndex();
    } else if (!indexData.items.some((it) => it.id === indexData.activeWorkspaceId)) {
      indexData.activeWorkspaceId = indexData.items[0].id;
      saveIndex();
    }
    return indexData;
  }

  function loadWorkspace(wsId) {
    if (!wsId) return null;
    if (wsCache.has(wsId)) return wsCache.get(wsId);
    const loaded = wsStoreFor(wsId).load();
    if (!loaded || !loaded.data) return null;
    const raw = loaded.data;
    const ws = {
      id: raw.id || wsId,
      company: raw.company || 'Default',
      role: raw.role || 'Interview',
      createdAt: raw.createdAt || now(),
      updatedAt: raw.updatedAt || now(),
      activeRoundId: raw.activeRoundId || null,
      files: Array.isArray(raw.files) ? raw.files : [],
      notes: typeof raw.notes === 'string' ? raw.notes : '',
      admittedLessons: Array.isArray(raw.admittedLessons) ? raw.admittedLessons : [],
      prepBrief: raw.prepBrief ? { ...emptyPrepBrief(), ...raw.prepBrief } : emptyPrepBrief(),
      rounds: Array.isArray(raw.rounds) ? raw.rounds : []
    };
    wsCache.set(wsId, ws);
    return ws;
  }

  function makeRoundRecord(name, ts) {
    return {
      id: `rnd_${crypto.randomBytes(6).toString('hex')}`,
      name: name || 'Round 1',
      startedAt: ts,
      endedAt: null,
      status: 'open',
      turnCount: 0,
      dissection: null
    };
  }

  function createWorkspaceInternal({ company, role, notes = '' }) {
    const ts = now();
    const id = `ws_${crypto.randomBytes(6).toString('hex')}`;
    const firstRound = makeRoundRecord('Round 1', ts);
    const ws = {
      id,
      company: String(company || 'Untitled Company').trim(),
      role: String(role || 'Candidate Role').trim(),
      createdAt: ts,
      updatedAt: ts,
      activeRoundId: firstRound.id,
      files: [],
      notes: String(notes || ''),
      admittedLessons: [],
      prepBrief: emptyPrepBrief(),
      rounds: [firstRound]
    };
    wsCache.set(id, ws);
    if (!indexData) {
      indexData = { version: 1, activeWorkspaceId: id, items: [] };
    }
    indexData.items.push({ id, company: ws.company, role: ws.role, updatedAt: ts });
    indexData.activeWorkspaceId = id;
    persistWorkspaceNow(id);
    return ws;
  }

  function createWorkspace(payload = {}) {
    loadIndex();
    return createWorkspaceInternal(payload);
  }

  function listWorkspaces() {
    const idx = loadIndex();
    return {
      activeWorkspaceId: idx.activeWorkspaceId,
      items: idx.items.slice()
    };
  }

  function getWorkspace(wsId) {
    loadIndex();
    return loadWorkspace(wsId);
  }

  function getActiveWorkspace() {
    const idx = loadIndex();
    return loadWorkspace(idx.activeWorkspaceId);
  }

  function getWorkspaceSummary(wsId) {
    const ws = getWorkspace(wsId);
    if (!ws) return null;
    return {
      id: ws.id,
      company: ws.company,
      role: ws.role,
      createdAt: ws.createdAt,
      updatedAt: ws.updatedAt,
      activeRoundId: ws.activeRoundId,
      notes: ws.notes,
      admittedLessons: ws.admittedLessons,
      prepBrief: ws.prepBrief,
      files: ws.files.map((f) => ({
        id: f.id,
        path: f.path,
        label: f.label,
        role: f.role,
        isDirectory: !!f.isDirectory,
        status: f.status,
        error: f.error || '',
        chunkCount: Array.isArray(f.chunks) ? f.chunks.length : 0
      })),
      rounds: ws.rounds.slice()
    };
  }

  function setActiveWorkspace(wsId) {
    const idx = loadIndex();
    const target = loadWorkspace(wsId);
    if (!target) throw new Error(`Workspace not found: ${wsId}`);
    flushAll();
    idx.activeWorkspaceId = wsId;
    saveIndex();
    return target;
  }

  function updateWorkspace(wsId, patch = {}) {
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error(`Workspace not found: ${wsId}`);
    if (typeof patch.company === 'string' && patch.company.trim()) ws.company = patch.company.trim();
    if (typeof patch.role === 'string' && patch.role.trim()) ws.role = patch.role.trim();
    if (typeof patch.notes === 'string') ws.notes = patch.notes;
    if (patch.prepBrief && typeof patch.prepBrief === 'object') {
      ws.prepBrief = { ...emptyPrepBrief(), ...ws.prepBrief, ...patch.prepBrief };
    }
    ws.updatedAt = now();
    scheduleWorkspaceSave(wsId, true);
    return ws;
  }

  function deleteWorkspace(wsId) {
    const idx = loadIndex();
    const timer = wsTimers.get(wsId);
    if (timer) {
      clearTimeout(timer);
      wsTimers.delete(wsId);
    }
    wsCache.delete(wsId);
    wsFileStores.delete(wsId);
    for (const key of Array.from(ledgerCache.keys())) {
      if (key.startsWith(`${wsId}:`)) ledgerCache.delete(key);
    }
    idx.items = idx.items.filter((it) => it.id !== wsId);
    const jsonPath = path.join(workspacesRoot(), `${wsId}.json`);
    const bakPath = `${jsonPath}.bak`;
    const dirPath = path.join(workspacesRoot(), wsId);
    fs.rmSync(jsonPath, { force: true });
    fs.rmSync(bakPath, { force: true });
    fs.rmSync(dirPath, { recursive: true, force: true });

    if (idx.items.length === 0) {
      const def = createWorkspaceInternal({ company: 'Default', role: 'General Interview' });
      idx.activeWorkspaceId = def.id;
    } else if (idx.activeWorkspaceId === wsId) {
      idx.activeWorkspaceId = idx.items[0].id;
    }
    saveIndex();
    return getActiveWorkspace();
  }

  async function attachWorkspaceFile(wsId, targetPath, role = 'jd') {
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error(`Workspace not found: ${wsId}`);
    let canonical = path.resolve(targetPath);
    try {
      canonical = await fs.promises.realpath(targetPath);
    } catch (_) {
      // Preserve resolved path to surface error record cleanly.
    }

    const existing = ws.files.find((f) => f.path === canonical && f.role === role);
    const fileId = existing ? existing.id : `wf_${crypto.randomBytes(6).toString('hex')}`;
    const label = path.basename(canonical);

    let record;
    try {
      const stat = await fs.promises.stat(canonical);
      if (stat.isDirectory()) {
        const repoRec = await indexRepository(canonical, null, { id: fileId, name: label });
        const chunks = (repoRec.chunks || []).map((c) => ({ ...c, sourceKind: role }));
        record = {
          id: fileId,
          path: canonical,
          label,
          role,
          isDirectory: true,
          status: repoRec.status,
          error: repoRec.error || '',
          mtimeMs: Math.trunc(stat.mtimeMs),
          chunks
        };
      } else {
        const extracted = await extractDocumentText(canonical);
        const chunks = extracted.text
          ? chunkText(extracted.text, {
              sourceId: fileId,
              sourceLabel: label,
              sourceKind: role,
              relPath: ''
            })
          : [];
        record = {
          id: fileId,
          path: canonical,
          label,
          role,
          isDirectory: false,
          status: extracted.warning ? 'warning' : 'ok',
          error: extracted.warning || '',
          mtimeMs: Math.trunc(stat.mtimeMs),
          chunks
        };
      }
    } catch (err) {
      record = {
        id: fileId,
        path: canonical,
        label,
        role,
        isDirectory: false,
        status: 'error',
        error: (err && err.message) || String(err),
        mtimeMs: 0,
        chunks: []
      };
    }

    if (existing) Object.assign(existing, record);
    else ws.files.push(record);
    ws.updatedAt = now();
    scheduleWorkspaceSave(wsId, true);
    return record;
  }

  function removeWorkspaceFile(wsId, fileId) {
    const ws = getWorkspace(wsId);
    if (!ws) return false;
    const before = ws.files.length;
    ws.files = ws.files.filter((f) => f.id !== fileId);
    if (ws.files.length !== before) {
      ws.updatedAt = now();
      scheduleWorkspaceSave(wsId, true);
      return true;
    }
    return false;
  }

  function roundLedgerPath(wsId, roundId) {
    return path.join(workspacesRoot(), wsId, 'rounds', `${roundId}.jsonl`);
  }

  function loadLedger(wsId, roundId) {
    const key = `${wsId}:${roundId}`;
    if (ledgerCache.has(key)) return ledgerCache.get(key);
    const filePath = roundLedgerPath(wsId, roundId);
    const entries = [];
    let leafId = null;
    let persisted = false;

    if (fs.existsSync(filePath)) {
      persisted = true;
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.type !== 'round_header' && parsed.id) {
            entries.push(parsed);
            leafId = parsed.id;
          }
        } catch (_) {
          // Skip malformed trailing line after an interrupted write.
        }
      }
    }

    const ledger = { filePath, entries, leafId, persisted };
    ledgerCache.set(key, ledger);
    return ledger;
  }

  // Write to disk before advancing leafId so failed writes never corrupt parent pointers.
  function appendRoundEvent(wsId, roundId, event) {
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error(`Workspace not found: ${wsId}`);
    const round = ws.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error(`Round not found: ${roundId}`);

    const ledger = loadLedger(wsId, roundId);
    const ts = event.ts || now();
    const entry = {
      ...event,
      id: event.id || crypto.randomBytes(4).toString('hex'),
      parentId: ledger.leafId,
      ts
    };

    const isNew = !ledger.persisted && !fs.existsSync(ledger.filePath);
    const payload = isNew
      ? JSON.stringify({ type: 'round_header', version: 1, workspaceId: wsId, roundId, startedAt: round.startedAt }) +
        '\n' +
        JSON.stringify(entry) +
        '\n'
      : JSON.stringify(entry) + '\n';

    appendLineFn(ledger.filePath, payload, isNew);

    ledger.persisted = true;
    ledger.entries.push(entry);
    ledger.leafId = entry.id;

    if (entry.type === 'transcript_turn') {
      round.turnCount = (round.turnCount || 0) + 1;
      ws.updatedAt = ts;
      scheduleWorkspaceSave(wsId, false);
    }
    return entry;
  }

  function buildRoundProjection(wsId, roundId, maxScan = MAX_SCAN_ENTRIES) {
    const ledger = loadLedger(wsId, roundId);
    const tail = ledger.entries.length > maxScan ? ledger.entries.slice(-maxScan) : ledger.entries;

    let latestCompactionIdx = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i].type === 'compaction') {
        latestCompactionIdx = i;
        break;
      }
    }

    let rollingSummary = '';
    let startTranscriptIdx = 0;
    if (latestCompactionIdx >= 0) {
      const comp = tail[latestCompactionIdx];
      rollingSummary = comp.summary || '';
      if (comp.firstKeptEntryId) {
        const foundIdx = tail.findIndex((e) => e.id === comp.firstKeptEntryId);
        startTranscriptIdx = foundIdx >= 0 ? foundIdx : latestCompactionIdx + 1;
      } else {
        startTranscriptIdx = latestCompactionIdx + 1;
      }
    }

    const transcript = [];
    const rawTranscript = [];
    const qaTurns = [];
    const perceptionTraces = [];

    for (let i = 0; i < tail.length; i++) {
      const e = tail[i];
      if (e.type === 'transcript_turn') {
        const turn = { id: e.id, channel: e.channel, text: e.text, ts: e.ts };
        rawTranscript.push(turn);
        if (i >= startTranscriptIdx) transcript.push(turn);
      } else if (e.type === 'qa_turn') {
        qaTurns.push({
          id: e.id,
          mode: e.mode,
          userText: e.userText || '',
          category: e.category || 'general',
          answer: e.answer || '',
          citedSources: e.citedSources || [],
          ts: e.ts
        });
      } else if (e.type === 'perception_trace') {
        perceptionTraces.push(e);
      }
    }

    return {
      transcript,
      rawTranscript,
      rollingSummary,
      qaTurns: qaTurns.slice(-MAX_QA_TURNS_IN_RAM),
      perceptionTraces: perceptionTraces.slice(-20)
    };
  }

  function createRound(wsId, name) {
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error(`Workspace not found: ${wsId}`);
    const nextNumber = ws.rounds.length + 1;
    const round = makeRoundRecord(name || `Round ${nextNumber}`, now());
    ws.rounds.push(round);
    ws.activeRoundId = round.id;
    ws.updatedAt = now();
    scheduleWorkspaceSave(wsId, true);
    return round;
  }

  function setActiveRound(wsId, roundId) {
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error(`Workspace not found: ${wsId}`);
    const round = ws.rounds.find((r) => r.id === roundId);
    if (!round) throw new Error(`Round not found: ${roundId}`);
    ws.activeRoundId = round.id;
    ws.updatedAt = now();
    scheduleWorkspaceSave(wsId, true);
    return round;
  }

  function updateRoundMeta(wsId, roundId, patch) {
    const ws = getWorkspace(wsId);
    if (!ws) return null;
    const round = ws.rounds.find((r) => r.id === roundId);
    if (!round) return null;
    Object.assign(round, patch);
    ws.updatedAt = now();
    scheduleWorkspaceSave(wsId, true);
    return round;
  }

  function clearRoundTranscript(wsId, roundId) {
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error(`Workspace not found: ${wsId}`);
    const targetId = roundId || ws.activeRoundId;
    const round = ws.rounds.find((r) => r.id === targetId);
    if (round && (round.turnCount || 0) > 0 && !round.endedAt) {
      round.endedAt = now();
      round.status = round.dissection ? 'dissected' : 'ended';
    }
    return createRound(wsId, `Round ${ws.rounds.length + 1}`);
  }

  // Return prior completed round summaries strictly from the same workspace.
  function workspaceMemoryBlock(wsId, currentRoundId, maxRounds = 3) {
    const ws = getWorkspace(wsId);
    if (!ws) return '';
    const prior = ws.rounds
      .filter((r) => r.id !== currentRoundId && r.dissection && r.dissection.roundSummary)
      .slice(-maxRounds);
    if (!prior.length) return '';

    const lines = prior.map((r) => {
      const cp = r.dissection.nextRoundCheckpoint;
      const focus =
        cp && Array.isArray(cp.openWeaknessesToRepair) && cp.openWeaknessesToRepair.length
          ? ` | Repair next: ${cp.openWeaknessesToRepair.join('; ')}`
          : '';
      return `- ${r.name}: ${r.dissection.roundSummary}${focus}`;
    });
    return `Earlier rounds in this workspace (${ws.company} - ${ws.role}):\n${lines.join('\n')}`;
  }

  function searchWorkspaceRounds(wsId, query) {
    const ws = getWorkspace(wsId);
    if (!ws || !query || !String(query).trim()) return [];
    const needle = String(query).trim().toLowerCase();
    const hits = [];
    for (const r of ws.rounds) {
      const proj = buildRoundProjection(wsId, r.id);
      const summaryText = (r.dissection && r.dissection.roundSummary) || '';
      const txMatch = proj.rawTranscript.filter((t) => (t.text || '').toLowerCase().includes(needle));
      if (r.name.toLowerCase().includes(needle) || summaryText.toLowerCase().includes(needle) || txMatch.length > 0) {
        hits.push({
          roundId: r.id,
          name: r.name,
          status: r.status,
          matchCount: txMatch.length + (summaryText.toLowerCase().includes(needle) ? 1 : 0),
          sample: txMatch[0] ? txMatch[0].text : summaryText
        });
      }
    }
    return hits;
  }

  function allowedRootsForWorkspace(wsId) {
    const ws = getWorkspace(wsId);
    if (!ws) return [];
    const roots = [];
    for (const f of ws.files) {
      if (f.isDirectory && f.path && fs.existsSync(f.path)) {
        try {
          roots.push(fs.realpathSync(f.path));
        } catch (_) {
          // Ignore deleted folder.
        }
      }
    }
    return Array.from(new Set(roots));
  }

  function allowedRootEntriesForWorkspace(wsId) {
    const ws = getWorkspace(wsId);
    if (!ws) return [];
    const out = [];
    for (const f of ws.files) {
      if (f.isDirectory && f.path && fs.existsSync(f.path)) {
        try {
          out.push({ name: f.label || path.basename(f.path), path: fs.realpathSync(f.path) });
        } catch (_) {
          // Ignore deleted folder.
        }
      }
    }
    return out;
  }

  function getWorkspaceChunks(wsId) {
    const ws = getWorkspace(wsId);
    if (!ws) return [];
    const out = [];
    for (const f of ws.files) {
      if (Array.isArray(f.chunks)) out.push(...f.chunks);
    }
    return out;
  }

  async function seedFromLegacy(seed) {
    loadIndex();
    if (!seed) return false;
    const hasWsData = [seed.jobDescription, seed.whyCompany, seed.salaryTarget, seed.questionsToAsk].some(
      (s) => s && s.trim()
    );
    if (!hasWsData) return false;
    const active = getActiveWorkspace();
    const notesParts = [];
    if (seed.whyCompany) notesParts.push(`Why this company: ${seed.whyCompany}`);
    if (seed.salaryTarget) notesParts.push(`Salary target: ${seed.salaryTarget}`);
    if (seed.questionsToAsk) notesParts.push(`Questions to ask: ${seed.questionsToAsk}`);
    if (notesParts.length) {
      updateWorkspace(active.id, { notes: notesParts.join('\n') });
    }
    if (seed.jobDescription && seed.jobDescription.trim()) {
      const jdFile = path.join(workspacesRoot(), 'migrated-job-description.md');
      await fs.promises.writeFile(jdFile, `# Migrated Job Description\n${seed.jobDescription.trim()}\n`, { mode: 0o600 });
      await attachWorkspaceFile(active.id, jdFile, 'jd');
    }
    return true;
  }

  function failureJournalPath(wsId) {
    return path.join(workspacesRoot(), wsId, 'failure-journal.jsonl');
  }

  function appendJournalEntry(wsId, record) {
    const filePath = failureJournalPath(wsId);
    const isNew = !fs.existsSync(filePath);
    appendLineFn(filePath, JSON.stringify(record) + '\n', isNew);
  }

  function listFailureJournal(wsId) {
    const filePath = failureJournalPath(wsId);
    const facts = [];
    const lessonsById = new Map();
    const decisions = [];
    if (!fs.existsSync(filePath)) return { facts, lessons: [], decisions };

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'failure_fact') {
          facts.push(entry);
        } else if (entry.type === 'candidate_lesson') {
          lessonsById.set(entry.id, { ...entry });
        } else if (entry.type === 'lesson_decision') {
          decisions.push(entry);
          const target = lessonsById.get(entry.targetLessonId);
          if (target) {
            if (entry.decision === 'accept_workspace') target.status = 'accepted';
            else if (entry.decision === 'promote_global') target.status = 'promoted';
            else if (entry.decision === 'dismiss') target.status = 'dismissed';
            else if (entry.decision === 'supersede') target.status = 'superseded';
          }
        }
      } catch (_) {
        // Ignore truncated trailing line.
      }
    }
    return { facts, lessons: Array.from(lessonsById.values()), decisions };
  }

  // Gate all L1 candidate lessons behind explicit human decision before prompt admission.
  function decideCandidateLesson(wsId, lessonId, decision, { profileStore, supersedesId = null } = {}) {
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error(`Workspace not found: ${wsId}`);
    const journal = listFailureJournal(wsId);
    const lesson = journal.lessons.find((l) => l.id === lessonId);
    if (!lesson) throw new Error(`Candidate lesson not found: ${lessonId}`);

    const ts = now();
    appendJournalEntry(wsId, {
      type: 'lesson_decision',
      targetLessonId: lessonId,
      decision,
      supersedesId,
      ts
    });

    if (decision === 'accept_workspace') {
      if (supersedesId) {
        const old = ws.admittedLessons.find((l) => l.id === supersedesId);
        if (old) old.status = 'superseded';
      }
      const admitted = {
        id: `wles_${crypto.randomBytes(6).toString('hex')}`,
        lessonId: lesson.id,
        factId: lesson.factId || null,
        guidance: lesson.proposedFix,
        admittedAt: ts,
        status: 'accepted',
        supersedesId
      };
      ws.admittedLessons.push(admitted);
      ws.updatedAt = ts;
      scheduleWorkspaceSave(wsId, true);
      return admitted;
    }

    if (decision === 'promote_global') {
      if (!profileStore || typeof profileStore.promoteGlobalLesson !== 'function') {
        throw new Error('profileStore is required to promote a global lesson.');
      }
      return profileStore.promoteGlobalLesson({
        topic: lesson.failureType || 'interview_lesson',
        guidance: lesson.proposedFix,
        sourceWorkspaceId: wsId,
        supersedesId
      });
    }

    return null;
  }

  async function generateRoundDissection(wsId, roundId, { llmFactory, profile } = {}) {
    const ws = getWorkspace(wsId);
    if (!ws) return null;
    const round = ws.rounds.find((r) => r.id === roundId);
    if (!round) return null;

    const proj = buildRoundProjection(wsId, roundId);
    if (proj.rawTranscript.length < MIN_TURNS_FOR_DISSECTION) return null;
    const llm = typeof llmFactory === 'function' ? llmFactory() : null;
    if (!llm || !llm.ready) return null;

    const { system, user } = buildDissectionPrompt({
      roundProjection: proj,
      workspace: ws,
      profile: profile || { repos: [], documents: [] }
    });

    const rawText = await llm.stream({
      system,
      turns: [{ role: 'user', text: user }],
      maxTokens: 1200,
      lengthCut: 'ellipsis',
      onToken: () => {}
    });

    const dissection = parseDissection(rawText);
    const ts = now();

    const createdFactIds = [];
    for (const item of dissection.qaReview) {
      if (item.verdict === 'strong') continue;
      const factId = `fact_${crypto.randomBytes(6).toString('hex')}`;
      createdFactIds.push(factId);
      appendJournalEntry(wsId, {
        type: 'failure_fact',
        id: factId,
        roundId,
        ts,
        question: item.question,
        spokenExcerpt: item.spokenAnswer,
        copilotExcerpt: item.copilotSuggestion,
        interviewerPushback: item.gapWhy,
        failureType: item.verdict === 'unverified_claim' ? 'unverified_claim' : 'technical_gap'
      });
    }

    for (let i = 0; i < dissection.proposedLessons.length; i++) {
      const prop = dissection.proposedLessons[i];
      appendJournalEntry(wsId, {
        type: 'candidate_lesson',
        id: `cles_${crypto.randomBytes(6).toString('hex')}`,
        factId: createdFactIds[i] || createdFactIds[0] || null,
        roundId,
        ts,
        failureType: prop.failureType,
        proposedFix: prop.proposedFix,
        suggestedScope: prop.suggestedScope,
        status: 'proposed'
      });
    }

    appendRoundEvent(wsId, roundId, { type: 'dissection', dissection, ts });
    round.dissection = dissection;
    round.status = 'dissected';
    if (
      dissection.nextRoundCheckpoint &&
      Array.isArray(dissection.nextRoundCheckpoint.openWeaknessesToRepair) &&
      dissection.nextRoundCheckpoint.openWeaknessesToRepair.length
    ) {
      ws.prepBrief = {
        ...emptyPrepBrief(),
        ...ws.prepBrief,
        priorRoundFocus: dissection.nextRoundCheckpoint.openWeaknessesToRepair.slice()
      };
    }
    ws.updatedAt = ts;
    scheduleWorkspaceSave(wsId, true);
    return dissection;
  }

  async function endRound(wsId, roundId, { llmFactory, profile } = {}) {
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error(`Workspace not found: ${wsId}`);
    const targetId = roundId || ws.activeRoundId;
    const round = ws.rounds.find((r) => r.id === targetId);
    if (!round) throw new Error(`Round not found: ${targetId}`);

    if (!round.endedAt) {
      round.endedAt = now();
    }
    if (round.status === 'open') {
      round.status = 'ended';
    }
    ws.updatedAt = now();
    scheduleWorkspaceSave(wsId, true);

    try {
      await generateRoundDissection(wsId, targetId, { llmFactory, profile });
    } catch (_) {
      // Keep ended status so catchUpPendingRounds can retry later.
    }
    return round;
  }

  async function catchUpPendingRounds({ llmFactory, profile } = {}) {
    const idx = loadIndex();
    let count = 0;
    const currentNow = now();

    for (const item of idx.items) {
      const ws = loadWorkspace(item.id);
      if (!ws) continue;
      for (const round of ws.rounds) {
        const proj = buildRoundProjection(ws.id, round.id);
        const lastTurnTs = proj.rawTranscript.length
          ? proj.rawTranscript[proj.rawTranscript.length - 1].ts
          : round.startedAt;

        if (!round.endedAt && proj.rawTranscript.length > 0 && currentNow - lastTurnTs > RESUME_WINDOW_MS) {
          round.endedAt = lastTurnTs;
          round.status = 'ended';
          scheduleWorkspaceSave(ws.id, true);
        }

        if (round.endedAt && !round.dissection && proj.rawTranscript.length >= MIN_TURNS_FOR_DISSECTION) {
          try {
            const d = await generateRoundDissection(ws.id, round.id, { llmFactory, profile });
            if (d) count++;
          } catch (_) {
            // Best-effort startup recovery.
          }
        }
      }
    }
    return count;
  }

  return {
    listWorkspaces,
    getWorkspace,
    getActiveWorkspace,
    getWorkspaceSummary,
    createWorkspace,
    updateWorkspace,
    setActiveWorkspace,
    deleteWorkspace,
    attachWorkspaceFile,
    removeWorkspaceFile,
    createRound,
    setActiveRound,
    updateRoundMeta,
    clearRoundTranscript,
    endRound,
    generateRoundDissection,
    catchUpPendingRounds,
    listFailureJournal,
    decideCandidateLesson,
    appendRoundEvent,
    buildRoundProjection,
    workspaceMemoryBlock,
    searchWorkspaceRounds,
    allowedRootsForWorkspace,
    allowedRootEntriesForWorkspace,
    getWorkspaceChunks,
    seedFromLegacy,
    flushAll,
    workspacesRoot
  };
}

module.exports = { emptyPrepBrief, createWorkspaceStore };
