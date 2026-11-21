const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMeetingStore } = require('../src/meetings');
const { createMeetingMemory } = require('../src/meeting-memory');
const { readSource, fnFrom } = require('./source-text');

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function notesHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-notes-race-'));
  const store = createMeetingStore({ file: path.join(dir, 'meetings.json') });
  const calls = [];
  const llmFactory = () => ({ ready: true, stream: (params) => new Promise((resolve) => calls.push({ params, resolve })) });
  const memory = createMeetingMemory({ store, llmFactory, now: () => 1_000_000, log: () => {}, minTurnsForNotes: 2 });
  for (let i = 1; i <= 13; i++) memory.onTurn({ channel: i % 2 ? 'them' : 'you', text: `turn ${i}`, ts: 1_000_000 + i });
  return { store, memory, calls, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const NOTES = 'Meeting Summary:\nThe team agreed to ship on Tuesday.\n\nKey Points:\n- Ship Tuesday\n\nDecisions:\n- Ship\n\nAction Items:\n- You: send the runbook\n\nFollow-Up:\n- None\n';

test('meeting memory: a refresh while a notes call runs, with a new turn, gets notes written from every turn', async () => {
  const h = notesHarness();
  const first = h.memory.refreshNotes();
  await settle();
  assert.equal(h.calls.length, 1);
  h.memory.onTurn({ channel: 'them', text: 'the last turn', ts: 1_000_100 });
  const second = h.memory.refreshNotes();
  h.calls[0].resolve(NOTES);
  const a = await first;
  assert.equal(a.turns, 13);
  assert.equal(h.store.get(h.memory.current.id).notesTurns, 13);
  await settle();
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].params.turns[0].text, /the last turn/);
  h.calls[1].resolve(NOTES);
  const b = await second;
  assert.equal(b.turns, 14);
  assert.equal(h.store.get(h.memory.current.id).notesTurns, 14);
  h.done();
});

test('meeting memory: a refresh while a notes call runs, with no new turn, waits for that call', async () => {
  const h = notesHarness();
  const first = h.memory.refreshNotes();
  const again = h.memory.refreshNotes();
  await settle();
  h.calls[0].resolve(NOTES);
  assert.equal(await again, await first);
  await settle();
  assert.equal(h.calls.length, 1);
  h.done();
});

test('main.js: Stop, Start and Stop again while notes call runs reports "Meeting notes saved" once', async () => {
  const src = readSource('main.js');
  const m = /^function notesAfterStop\(.*$/m.exec(src);
  assert.ok(m);
  const decl = (/^let notesStatusFor = .*;$/m.exec(src) || [''])[0];
  const statuses = [];
  const ctx = vm.createContext({ send: (ch, p) => { if (ch === 'status') statuses.push(p.message); }, Promise });
  vm.runInContext(`${decl}\n${fnFrom(src, m[0])}\nthis.notesAfterStop = notesAfterStop;`, ctx);
  const h = notesHarness();
  const stop1 = ctx.notesAfterStop(h.memory, Promise.resolve());
  await settle();
  h.memory.onTurn({ channel: 'them', text: 'the last turn', ts: 1_000_100 });
  const stop2 = ctx.notesAfterStop(h.memory, Promise.resolve());
  await settle();
  h.calls[0].resolve(NOTES);
  await settle();
  h.calls[1].resolve(NOTES);
  await Promise.all([stop1, stop2]);
  assert.deepEqual(statuses, ['Meeting notes saved (14 turns).']);
  h.done();
});
