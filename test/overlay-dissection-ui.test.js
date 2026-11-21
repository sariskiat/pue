const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readSource, fnFrom } = require('./source-text');

const ROOT = path.resolve(__dirname, '..');

test('overlay HTML, CSS, and click-through selector wire workspace pill, drawers, and tool status', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

  for (const id of [
    'workspace-bar',
    'workspace-pill',
    'workspace-popover',
    'open-brief-btn',
    'open-dissection-btn',
    'end-round-btn',
    'tool-status-bar',
    'tool-status-text',
    'tool-cancel-btn',
    'prep-brief-scrim',
    'brief-generate-btn',
    'brief-content',
    'dissection-scrim',
    'dissection-round-select',
    'dissection-search-input',
    'dissection-copy-md-btn',
    'dissection-content',
    'journal-lessons-list'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id} in index.html`);
  }

  assert.match(css, /#prep-brief-scrim[^\n]*pointer-events:\s*auto/);
  assert.match(css, /#dissection-scrim[^\n]*pointer-events:\s*auto/);
  assert.match(js, /#prep-brief-scrim/);
  assert.match(js, /#dissection-scrim/);
});

function createBoundEl(tag = 'div') {
  const classes = new Set(['hidden']);
  return {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    children: [],
    listeners: {},
    classList: {
      add(c) {
        classes.add(c);
      },
      remove(c) {
        classes.delete(c);
      },
      toggle(c, force) {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c);
          else classes.add(c);
        } else if (force) classes.add(c);
        else classes.delete(c);
      },
      contains(c) {
        return classes.has(c);
      }
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    addEventListener(ev, fn) {
      this.listeners[ev] = fn;
    }
  };
}

test('Dissection & Failure Journal drawer renders XSS safely, wires lesson decisions, and clears tool status', async () => {
  const src = readSource('renderer/renderer.js');
  const fns = [
    '  function clearChildren(host) {',
    '  function showToolStatus(detail) {',
    '  function clearToolStatus() {',
    '  function renderWorkspaceOverlayBar() {',
    '  function appendBulletSection(host, heading, items) {',
    '  function renderDissectionBody(dissection, journal) {'
  ]
    .map((sig) => fnFrom(src, sig))
    .join('\n');

  const els = {
    '#workspace-pill': createBoundEl('button'),
    '#tool-status-bar': createBoundEl('div'),
    '#tool-status-text': createBoundEl('span'),
    '#dissection-content': createBoundEl('div'),
    '#journal-lessons-list': createBoundEl('div')
  };

  const decisions = [];
  const ctx = vm.createContext({
    $: (sel) => els[sel] || createBoundEl('div'),
    document: { createElement: (t) => createBoundEl(t) },
    workspaceState: {
      activeWorkspaceId: 'ws_1',
      activeWorkspace: {
        id: 'ws_1',
        company: 'Acme',
        role: 'Staff SWE',
        activeRoundId: 'rnd_1',
        rounds: [{ id: 'rnd_1', name: 'Round 2' }]
      }
    },
    cue: {
      workspaceDecideLesson: async (wsId, lessonId, decision) => {
        decisions.push({ wsId, lessonId, decision });
        return { journal: { lessons: [] } };
      }
    },
    showToast: () => {}
  });

  vm.runInContext(
    `${fns}\nthis.showToolStatus = showToolStatus;\nthis.clearToolStatus = clearToolStatus;\nthis.renderWorkspaceOverlayBar = renderWorkspaceOverlayBar;\nthis.renderDissectionBody = renderDissectionBody;`,
    ctx
  );

  ctx.renderWorkspaceOverlayBar();
  assert.equal(els['#workspace-pill'].textContent, 'Acme / Staff SWE · Round 2');

  ctx.showToolStatus('rust-queue/src/worker.rs');
  assert.equal(els['#tool-status-bar'].classList.contains('hidden'), false);
  assert.equal(els['#tool-status-text'].textContent, 'Checking rust-queue/src/worker.rs...');

  ctx.clearToolStatus();
  assert.equal(els['#tool-status-bar'].classList.contains('hidden'), true);

  ctx.renderDissectionBody(
    {
      roundSummary: 'Summary <script>alert(1)</script>',
      qaReview: [
        {
          question: 'How does <img src=x onerror=alert(2)> work?',
          spokenAnswer: 'Spoken',
          copilotSuggestion: 'Suggested',
          verdict: 'partial',
          gapWhy: 'Gap',
          citedSources: ['worker.rs:10']
        }
      ],
      missedOpportunities: ['Missed metric'],
      interviewerSignals: ['Signal'],
      nextRoundCheckpoint: { settledTopics: ['Basics'], openWeaknessesToRepair: ['DLQ cap'], promisedFollowUps: [] }
    },
    {
      lessons: [
        {
          id: 'cles_1',
          proposedFix: 'State 5-retry cap <svg onload=alert(3)>',
          failureType: 'missing_metric',
          status: 'proposed'
        }
      ]
    }
  );

  const dSerialized = JSON.stringify(els['#dissection-content']);
  assert.match(dSerialized, /<script>alert\(1\)<\/script>/);
  assert.equal('innerHTML' in els['#dissection-content'], false, 'no innerHTML used in dissection view');

  const lessonRow = els['#journal-lessons-list'].children[0];
  assert.ok(lessonRow);
  const actionsWrap = lessonRow.children.find((c) => c.className === 'journal-actions') || lessonRow;
  const buttons = actionsWrap.children.filter((c) => c.tagName === 'BUTTON');
  assert.equal(buttons.length, 3);
  await buttons[0].listeners.click();
  await buttons[1].listeners.click();
  await buttons[2].listeners.click();

  assert.deepEqual(decisions, [
    { wsId: 'ws_1', lessonId: 'cles_1', decision: 'accept_workspace' },
    { wsId: 'ws_1', lessonId: 'cles_1', decision: 'promote_global' },
    { wsId: 'ws_1', lessonId: 'cles_1', decision: 'dismiss' }
  ]);
});
