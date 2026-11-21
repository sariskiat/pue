const { detectCategory } = require('./interview-context');
const { scoreChunks } = require('./repo-indexer');
const { wrapUntrustedChunk } = require('./prep-brief');
const { MODES } = require('./prompts');

const PUSHBACK_RE =
  /\b(wait|are you sure|not quite|disagree|why didn't|why not|but what if|deadlock|bottleneck|doesn't that|actually|missing|push back)\b/i;

function clip(text, limit) {
  if (!text) return '';
  const str = String(text).trim();
  if (str.length <= limit) return str;
  return str.slice(0, Math.max(0, limit - 3)).trimEnd() + '...';
}

function isPushbackTurn(turn) {
  return Boolean(turn && turn.channel === 'them' && PUSHBACK_RE.test(turn.text || ''));
}

// Bound live transcript size while keeping recent exchanges and interviewer pushbacks verbatim.
function transformContext({ mode = 'say', transcript = [], rollingSummary = '' }) {
  const isRecap = mode === 'recap';
  const maxTurns = isRecap ? 60 : 30;
  const maxChars = isRecap ? 10000 : 6000;

  if (!Array.isArray(transcript) || transcript.length === 0) {
    return {
      formattedTranscript: rollingSummary ? `[Earlier summary: ${clip(rollingSummary, 1000)}]` : '',
      keptTurns: [],
      compactionCandidate: null
    };
  }

  const tail = transcript.slice(-maxTurns);
  const overflow = transcript.length > maxTurns ? transcript.slice(0, transcript.length - maxTurns) : [];

  const preservedPushbacks = overflow.filter(isPushbackTurn).slice(-4);
  let overflowNote = '';
  if (overflow.length > 0) {
    const sampleTopics = overflow
      .filter((t) => t.channel === 'them')
      .slice(-4)
      .map((t) => clip(t.text, 90));
    overflowNote = sampleTopics.length
      ? `Compacted ${overflow.length} earlier turns. Earlier questions: ${sampleTopics.join(' | ')}`
      : `Compacted ${overflow.length} earlier turns.`;
  }

  const summaryParts = [rollingSummary ? clip(rollingSummary, 900) : '', overflowNote].filter(Boolean);
  const summaryHeader = summaryParts.length ? `[Earlier conversation summary: ${summaryParts.join(' ')}]\n` : '';
  const pushbackHeader = preservedPushbacks.length
    ? `[Key earlier interviewer pushbacks]\n${preservedPushbacks.map((t) => `Them: ${clip(t.text, 220)}`).join('\n')}\n`
    : '';

  const tailLines = [];
  let usedChars = summaryHeader.length + pushbackHeader.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tail[i];
    const line = `${t.channel === 'them' ? 'Them' : 'You'}: ${clip(t.text, 400)}`;
    if (tailLines.length > 0 && usedChars + line.length + 1 > maxChars) break;
    tailLines.unshift(line);
    usedChars += line.length + 1;
  }

  let compactionCandidate = null;
  if (overflow.length > 0 && tail.length > 0 && tail[0].id) {
    const pushbackSummary = preservedPushbacks.length
      ? ` Key pushbacks: ${preservedPushbacks.map((t) => clip(t.text, 180)).join(' | ')}`
      : '';
    compactionCandidate = {
      firstKeptEntryId: tail[0].id,
      summary: (summaryParts.join(' ') + pushbackSummary).trim()
    };
  }

  return {
    formattedTranscript: (summaryHeader + pushbackHeader + tailLines.join('\n')).trim(),
    keptTurns: tail,
    compactionCandidate
  };
}

function buildPrepBriefSection(prepBrief) {
  if (!prepBrief) return '';
  const lines = [];
  if (prepBrief.summary) lines.push(`Role Brief: ${prepBrief.summary}`);
  if (Array.isArray(prepBrief.repoMatches) && prepBrief.repoMatches.length) {
    const matches = prepBrief.repoMatches
      .slice(0, 4)
      .map((m) => `- ${m.repoName}: ${m.whyRelevant}${m.talkingPoints ? ` (${m.talkingPoints})` : ''}`);
    lines.push(`Matched Projects:\n${matches.join('\n')}`);
  }
  if (Array.isArray(prepBrief.testPlan) && prepBrief.testPlan.length) {
    lines.push(`Test Focus:\n${prepBrief.testPlan.slice(0, 3).map((t) => `- ${t}`).join('\n')}`);
  }
  if (Array.isArray(prepBrief.priorRoundFocus) && prepBrief.priorRoundFocus.length) {
    lines.push(`Repair From Earlier Rounds:\n${prepBrief.priorRoundFocus.slice(0, 4).map((f) => `- ${f}`).join('\n')}`);
  }
  return clip(lines.join('\n'), 1500);
}

// Expand anaphoric follow-ups ("how did you test that?") with prior Q&A subject terms.
function buildRetrievalQuery({ transcript = [], userText = '', workspace = {}, qaTurns = [] }) {
  const recentThem = transcript
    .filter((t) => t.channel === 'them')
    .slice(-3)
    .map((t) => t.text || '')
    .join(' ');
  const lastQa = Array.isArray(qaTurns) && qaTurns.length ? qaTurns[qaTurns.length - 1] : null;
  const lastQaHint = lastQa ? `${lastQa.userText || ''} ${(lastQa.answer || '').slice(0, 160)}` : '';
  const roleHint = [workspace.company || '', workspace.role || ''].filter(Boolean).join(' ');
  return [recentThem, userText || '', lastQaHint, roleHint].filter(Boolean).join(' ').trim();
}

function buildQaHistoryTurns(qaTurns = [], maxPairs = 6, maxChars = 2400) {
  if (!Array.isArray(qaTurns) || !qaTurns.length) return [];
  const slice = qaTurns.slice(-maxPairs);
  const pairs = [];
  let used = 0;

  for (let i = slice.length - 1; i >= 0; i--) {
    const q = slice[i];
    if (!q || !q.answer) continue;
    const uText = clip(q.userText || `[${q.mode || 'assist'} request]`, 260);
    const aText = clip(q.answer, 480);
    const cost = uText.length + aText.length;
    if (pairs.length > 0 && used + cost > maxChars) break;
    pairs.unshift(
      { role: 'user', text: uText },
      { role: 'assistant', text: aText }
    );
    used += cost;
  }
  return pairs;
}

// Assemble U-shaped 4-tier context (P0 start -> P2 middle -> P1 end) and PerceptionTrace.
function triageContext({
  mode = 'say',
  transcript = [],
  rollingSummary = '',
  userText = '',
  workspace = null,
  workspaceMemory = '',
  profile = null,
  allChunks = null,
  qaTurns = [],
  slides = [],
  aiRules = '',
  topK = 5,
  p1BudgetChars = 4500
}) {
  const def = MODES[mode] || MODES.assist;

  if (mode === 'leetcode') {
    const systemPrompt = def.buildSystem('', aiRules);
    return {
      category: 'technical',
      systemContext: '',
      systemPrompt,
      conversationTurns: [{ role: 'user', text: def.build({}) }],
      matchedChunks: [],
      compactionCandidate: null,
      perceptionTrace: {
        mode,
        chunksConsidered: 0,
        chunksSelected: 0,
        droppedChunks: [],
        selectivity: 0
      }
    };
  }

  const category = detectCategory(transcript);
  const ws = workspace || {};
  const prof = profile || {};

  // P0 Critical (High-Attention Start)
  const p0Blocks = [];
  const roleHeaderLines = [];
  if (ws.company || ws.role) {
    roleHeaderLines.push(`Active Job Workspace: ${[ws.company, ws.role].filter(Boolean).join(' - ')}`);
  }
  roleHeaderLines.push(`Detected Question Category: ${category}`);
  if (ws.notes && ws.notes.trim()) {
    roleHeaderLines.push(`Candidate Workspace Notes:\n${ws.notes.trim()}`);
  }
  p0Blocks.push(clip(roleHeaderLines.join('\n'), 1000));

  const briefBlock = buildPrepBriefSection(ws.prepBrief);
  if (briefBlock) p0Blocks.push(briefBlock);

  const wsLessons = (ws.admittedLessons || []).filter((l) => l.status === 'accepted').map((l) => `- [Job] ${l.guidance}`);
  const globalLessons = (prof.promotedLessons || []).filter((l) => l.status === 'accepted').map((l) => `- [Global] ${l.guidance}`);
  const combinedLessons = [...wsLessons, ...globalLessons];
  if (combinedLessons.length) {
    p0Blocks.push(clip(`Approved Coaching Lessons:\n${combinedLessons.join('\n')}`, 800));
  }

  // P2 Supporting (Middle Zone)
  const p2Blocks = [];
  if (workspaceMemory && workspaceMemory.trim()) {
    p2Blocks.push(clip(workspaceMemory.trim(), 1200));
  }
  if (Array.isArray(prof.repos) && prof.repos.length) {
    const cards = prof.repos
      .slice(0, 8)
      .map((r) => (r.card && r.card.summary ? r.card.summary : `${r.name}: ${r.rootPath || ''}`));
    p2Blocks.push(
      wrapUntrustedChunk({
        sourceLabel: 'repo_directory',
        text: clip(cards.join('\n---\n'), 1400)
      })
    );
  }
  if (def.needsScreen && Array.isArray(slides) && slides.length) {
    const slideText = slides
      .slice(-4)
      .map((s, idx) => `Slide ${s.index || idx + 1}: ${s.caption || ''}`)
      .join('\n');
    if (slideText.trim()) {
      p2Blocks.push(wrapUntrustedChunk({ sourceLabel: 'screen_slides', text: clip(slideText, 750) }));
    }
  }

  // P1 Retrieved Evidence (High-Attention End)
  const pool =
    Array.isArray(allChunks)
      ? allChunks
      : [
          ...((ws.files || []).flatMap((f) => f.chunks || [])),
          ...((prof.documents || []).flatMap((d) => d.chunks || [])),
          ...((prof.repos || []).flatMap((r) => r.chunks || []))
        ];

  const query = buildRetrievalQuery({ transcript, userText, workspace: ws, qaTurns });
  const candidateMatches = scoreChunks(query, pool, { topK: Math.max(topK + 5, 10), maxPerSource: 2 });

  const matchedChunks = [];
  const droppedChunks = [];
  let p1Used = 0;

  for (let i = 0; i < candidateMatches.length; i++) {
    const c = candidateMatches[i];
    if (matchedChunks.length >= topK) {
      droppedChunks.push({ id: c.id, sourceLabel: c.sourceLabel, reason: 'rank_cutoff' });
      continue;
    }
    const wrapped = wrapUntrustedChunk(c);
    if (p1Used + wrapped.length > p1BudgetChars) {
      droppedChunks.push({ id: c.id, sourceLabel: c.sourceLabel, reason: 'budget_exceeded' });
      continue;
    }
    matchedChunks.push({ chunk: c, wrapped });
    p1Used += wrapped.length + 2;
  }

  const p1Blocks = matchedChunks.length
    ? [`Retrieved Evidence Chunks (cite these facts accurately):\n${matchedChunks.map((m) => m.wrapped).join('\n\n')}`]
    : [];

  const systemContext = [...p0Blocks, ...p2Blocks, ...p1Blocks].filter(Boolean).join('\n\n');
  const systemPrompt = def.buildSystem(systemContext, aiRules);

  const compacted = transformContext({ mode, transcript, rollingSummary });
  const currentUserTurn = def.build({
    transcript: compacted.keptTurns,
    formattedTranscript: compacted.formattedTranscript,
    userText: userText || ''
  });

  const historyTurns = mode === 'answerThis' ? [] : buildQaHistoryTurns(qaTurns, 6, 2400);
  const conversationTurns = [...historyTurns, { role: 'user', text: currentUserTurn }];

  return {
    category,
    query,
    systemContext,
    systemPrompt,
    conversationTurns,
    matchedChunks: matchedChunks.map((m) => m.chunk),
    compactionCandidate: compacted.compactionCandidate,
    perceptionTrace: {
      mode,
      chunksConsidered: pool.length,
      chunksSelected: matchedChunks.length,
      droppedChunks,
      selectivity: pool.length > 0 ? Number((matchedChunks.length / pool.length).toFixed(4)) : 0
    }
  };
}

module.exports = {
  transformContext,
  buildRetrievalQuery,
  buildQaHistoryTurns,
  triageContext
};
