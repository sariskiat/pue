const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readSource, fnFrom } = require('./source-text');

const ROOT = path.resolve(__dirname, '..');

test('index.html defines Profile & Repos and Job Workspaces Settings tabs and controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  assert.match(html, /data-tab="profile"/);
  assert.match(html, /data-pane="profile"/);
  assert.match(html, /data-tab="workspaces"/);
  assert.match(html, /data-pane="workspaces"/);

  for (const id of [
    'profile-add-doc',
    'profile-add-repo',
    'profile-reindex',
    'profile-docs-list',
    'profile-repos-list',
    'profile-lessons-list',
    'ws-select',
    'ws-new-btn',
    'ws-delete-btn',
    'ws-company',
    'ws-role',
    'ws-notes',
    'ws-save-meta',
    'ws-add-jd',
    'ws-add-test-file',
    'ws-add-test-folder',
    'ws-files-list'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id} in index.html`);
  }
});

function makeFakeElement(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    title: '',
    type: '',
    disabled: false,
    children: [],
    dataset: {},
    listeners: {},
    classList: {
      add() {},
      remove() {},
      toggle() {}
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

test('renderProfileSettings and deleteSelectedWorkspace escape XSS labels and confirm before deleting recorded rounds', async () => {
  const rendererSrc = readSource('renderer/renderer.js');
  const clearFn = fnFrom(rendererSrc, '  function clearChildren(host) {');
  const renderProfFn = fnFrom(rendererSrc, '  function renderProfileSettings() {');
  const deleteWsFn = fnFrom(rendererSrc, '  async function deleteSelectedWorkspace(confirmFn) {');

  const elements = {
    '#profile-docs-list': makeFakeElement(),
    '#profile-repos-list': makeFakeElement(),
    '#profile-lessons-list': makeFakeElement()
  };

  let deletedIds = [];
  const ctx = vm.createContext({
    $: (sel) => elements[sel] || makeFakeElement(),
    document: { createElement: (t) => makeFakeElement(t) },
    profileState: {
      documents: [
        {
          id: 'doc_xss',
          label: '<img src=x onerror=alert(1)>.pdf',
          kind: 'resume',
          status: 'ok',
          error: '',
          chunkCount: 4
        }
      ],
      repos: [
        {
          id: 'repo_1',
          name: '<b>agent-repo</b>',
          status: 'ok',
          error: '',
          fileCount: 12,
          chunkCount: 38
        }
      ],
      promotedLessons: []
    },
    workspaceState: {
      activeWorkspaceId: 'ws_busy',
      items: [{ id: 'ws_busy', company: 'Acme', role: 'SWE' }],
      activeWorkspace: {
        id: 'ws_busy',
        company: 'Acme',
        role: 'SWE',
        rounds: [{ id: 'r1', name: 'Round 1', turnCount: 6 }]
      }
    },
    pue: {
      profileRemoveItem: async () => {},
      profileDeprecateLesson: async () => {},
      workspaceDelete: async (id) => {
        deletedIds.push(id);
        return { activeWorkspaceId: 'ws_def', items: [], activeWorkspace: null };
      }
    },
    applyWorkspaceSnapshot: () => {}
  });

  vm.runInContext(`${clearFn}\n${renderProfFn}\n${deleteWsFn}\nthis.renderProfileSettings = renderProfileSettings;\nthis.deleteSelectedWorkspace = deleteSelectedWorkspace;`, ctx);

  ctx.renderProfileSettings();
  const docRow = elements['#profile-docs-list'].children[0];
  assert.ok(docRow, 'doc row created via DOM nodes');
  const serializedTexts = JSON.stringify(docRow);
  assert.match(serializedTexts, /<img src=x onerror=alert\(1\)>\.pdf/);
  assert.equal('innerHTML' in docRow, false, 'must use textContent / DOM nodes rather than innerHTML');

  // Cancel confirmation blocks deletion when workspace has recorded turns
  await ctx.deleteSelectedWorkspace(() => false);
  assert.deepEqual(deletedIds, []);

  // Confirming proceeds with workspaceDelete
  await ctx.deleteSelectedWorkspace(() => true);
  assert.deepEqual(deletedIds, ['ws_busy']);
});
