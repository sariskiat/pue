// Render every screen, tab, popover, and drawer of pue in real Electron,
// capture PNG screenshots, and report DOM geometry / overflow clipping metrics.
// Run with: PUE_SKIP_PERMISSIONS=1 CUE_NO_PROTECT=1 ./node_modules/.bin/electron scripts/ui-audit/capture-screens.cjs

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT_DIR = process.env.PUE_UI_AUDIT_OUT || path.join(os.tmpdir(), 'pue-ui-audit');
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pue-ui-profile-'));
app.setPath('userData', profileDir);

// Seed realistic profile + workspace + brief + dissection + journal data before main.js boots
const { createProfileStore } = require('../../src/profile-store');
const { createWorkspaceStore } = require('../../src/workspace-store');

async function seedSampleData() {
  const sampleDocsDir = path.join(profileDir, 'sample-inputs');
  const sampleRepoDir = path.join(profileDir, 'rust-queue-engine');
  fs.mkdirSync(sampleDocsDir, { recursive: true });
  fs.mkdirSync(path.join(sampleRepoDir, 'src'), { recursive: true });

  const resumeMd = path.join(sampleDocsDir, 'saris-resume-2026.md');
  const jdMd = path.join(sampleDocsDir, 'anthropic-staff-systems-jd.md');
  const testMd = path.join(sampleDocsDir, 'takehome-distributed-queue.md');

  fs.writeFileSync(resumeMd, '# Candidate Resume\nLed distributed inference queue handling 50k RPS at p99 4.2ms.\n', 'utf8');
  fs.writeFileSync(jdMd, '# Staff AI Systems Engineer\nBuild low-latency agent runtimes and fault-tolerant queues.\n', 'utf8');
  fs.writeFileSync(testMd, '# Take-Home Prompt\nImplement bounded retry worker with dead-letter queue and idempotency keys.\n', 'utf8');
  fs.writeFileSync(path.join(sampleRepoDir, 'README.md'), '# rust-queue-engine\nBounded async worker pool.\n', 'utf8');
  fs.writeFileSync(path.join(sampleRepoDir, 'src', 'worker.rs'), 'pub fn process_batch() -> usize { 64 }\n', 'utf8');

  const pStore = createProfileStore(() => profileDir);
  await pStore.addDocument(resumeMd, 'resume');
  await pStore.addRepo(sampleRepoDir);
  pStore.promoteGlobalLesson({
    topic: 'metrics',
    guidance: 'Always state P50/P95/P99 latency and core count together when citing throughput.'
  });

  const wStore = createWorkspaceStore(() => profileDir, { debounceMs: 0 });
  const ws = wStore.createWorkspace({
    company: 'Anthropic',
    role: 'Staff AI Systems Engineer',
    notes: 'Target: $260k base + equity.\nAsk about inference batching scheduler.'
  });
  await wStore.attachWorkspaceFile(ws.id, jdMd, 'jd');
  await wStore.attachWorkspaceFile(ws.id, testMd, 'test');

  wStore.updateWorkspace(ws.id, {
    prepBrief: {
      generatedAt: Date.now(),
      summary: 'Role focuses on bounded agent harnesses, streaming backpressure, and deterministic recovery.',
      repoMatches: [
        {
          repoName: 'rust-queue-engine',
          whyRelevant: 'Direct match for fault-tolerant worker pool requirement',
          talkingPoints: '50k msgs/sec on 4 cores, 5-retry dead-letter threshold'
        }
      ],
      testPlan: [
        'Walk through idempotency key deduplication table',
        'Explain poison-message isolation and exponential backoff jitter'
      ],
      likelyQuestions: [
        'How do you prevent head-of-line blocking when one tenant spikes?',
        'What happens when a worker crashes mid-commit?'
      ],
      priorRoundFocus: ['State exact 5-retry DLQ cap upfront']
    }
  });

  const r1 = ws.activeRoundId;
  const sampleTurns = [
    { channel: 'them', text: 'Can you walk me through how your queue handles poison messages without stalling workers?' },
    { channel: 'you', text: 'We isolate failing jobs after five retries into a dead-letter stream and alert on-call.' },
    { channel: 'them', text: 'How did you verify throughput under contention?' },
    { channel: 'you', text: 'We benchmarked 50,000 messages per second on four cores with 4.2ms p99 latency.' }
  ];
  for (const t of sampleTurns) {
    wStore.appendRoundEvent(ws.id, r1, { type: 'transcript_turn', ...t });
  }
  await wStore.endRound(ws.id, r1, {
    llmFactory: () => ({
      ready: true,
      stream: async () =>
        [
          'Round Summary:',
          'Covered poison-message isolation and 4-core load benchmarks on rust-queue-engine.',
          '',
          'Q&A Review:',
          '- How does your queue handle poison messages? | Cite 5-retry DLQ cap and idempotency key check | Mentioned 5 retries to DLQ | partial | Omitted idempotency key deduplication on replay | rust-queue-engine/src/worker.rs:1',
          '- How did you verify throughput? | Cite 50k msgs/sec at 4.2ms p99 | Stated 50k msgs/sec on 4 cores at 4.2ms p99 | strong | Exact metric match | saris-resume-2026.md:2',
          '',
          'Missed Opportunities:',
          '- Did not mention zero-drop graceful shutdown drain timer',
          '',
          'Interviewer Signals:',
          '- Interviewer cared strongly about replay idempotency',
          '',
          'Settled Topics:',
          '- Load test throughput numbers',
          '',
          'Weaknesses to Repair:',
          '- Replay idempotency key storage trade-offs',
          '',
          'Promised Follow-Ups:',
          '- Share architecture diagram in Round 2',
          '',
          'Candidate Lessons:',
          '- technical_gap | Pair every DLQ retry answer with idempotency key guarantees on replay | workspace',
          '- missing_metric | Mention graceful shutdown drain window alongside p99 latency | global'
        ].join('\n')
    }),
    profile: pStore.getProfile()
  });

  wStore.flushAll();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inspectDomMetrics(contents, label) {
  return contents.executeJavaScript(`(() => {
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const issues = [];
    function checkBox(sel, name) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      if (r.bottom > winH + 1) issues.push(name + ' overflows bottom (' + Math.round(r.bottom) + ' > ' + winH + ')');
      if (r.top < -1) issues.push(name + ' clipped at top (' + Math.round(r.top) + ' < 0)');
      if (r.right > winW + 1) issues.push(name + ' overflows right (' + Math.round(r.right) + ' > ' + winW + ')');
      if (r.left < -1) issues.push(name + ' clipped at left (' + Math.round(r.left) + ' < 0)');
      if (el.scrollWidth > el.clientWidth + 2 && st.overflowX !== 'hidden') {
        issues.push(name + ' horizontal scroll (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
      }
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    // Check tab overlap and button clipping
    const tabs = Array.from(document.querySelectorAll('.s-tab')).filter((t) => t.offsetParent !== null);
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i].scrollWidth > tabs[i].clientWidth + 2) {
        issues.push('tab "' + tabs[i].textContent.trim() + '" overflows width (' + tabs[i].scrollWidth + ' > ' + tabs[i].clientWidth + ')');
      }
      if (i > 0) {
        const prev = tabs[i - 1].getBoundingClientRect();
        const cur = tabs[i].getBoundingClientRect();
        if (Math.abs(prev.top - cur.top) < 6 && prev.right > cur.left + 1) {
          issues.push('tabs overlap horizontally');
        }
      }
    }
    const wsNotes = document.querySelector('#ws-notes');
    if (wsNotes && wsNotes.offsetParent !== null && wsNotes.clientHeight < 60) {
      issues.push('#ws-notes squashed (' + wsNotes.clientHeight + 'px)');
    }
    const boxes = {
      toolbar: checkBox('#toolbar', '#toolbar'),
      panel: checkBox('#panel', '#panel'),
      workspaceBar: checkBox('#workspace-bar', '#workspace-bar'),
      workspacePopover: checkBox('#workspace-popover', '#workspace-popover'),
      composer: checkBox('#composer', '#composer'),
      settings: checkBox('#settings', '#settings'),
      sTabs: checkBox('.s-tabs', '.s-tabs'),
      providerSeg: checkBox('#provider-seg', '#provider-seg'),
      prepDrawer: checkBox('#prep-brief-drawer', '#prep-brief-drawer'),
      dissDrawer: checkBox('#dissection-drawer', '#dissection-drawer'),
      sidebar: checkBox('#transcript-sidebar', '#transcript-sidebar')
    };
    return { label: ${JSON.stringify(label)}, viewport: { w: winW, h: winH }, issues, boxes };
  })()`);
}

async function capture(win, name, report) {
  await sleep(180);
  const image = await win.webContents.capturePage();
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  const metrics = await inspectDomMetrics(win.webContents, name);
  report.push(metrics);
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    const report = [];
    try {
      await sleep(350);
      // 1. Onboarding
      await capture(win, '01-onboarding', report);

      // Dismiss onboarding
      await win.webContents.executeJavaScript(`document.querySelector('#ob-skip').click()`);
      await sleep(200);
      await capture(win, '02-main-overlay', report);

      // 3. Long response + tool status + sidebar open (stress vertical height!)
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#history-btn').click();
        document.querySelector('#tool-status-bar').classList.remove('hidden');
        document.querySelector('#tool-status-text').textContent = 'Checking rust-queue-engine/src/worker.rs...';
        const msgs = document.querySelector('#messages');
        for (let i = 0; i < 6; i++) {
          const d = document.createElement('div');
          d.className = 'ai-text';
          d.textContent = 'Paragraph ' + (i + 1) + ': Explain how bounded retry queues isolate poison messages after 5 retries while keeping p99 under 5ms.';
          msgs.appendChild(d);
        }
      })()`);
      await capture(win, '03-long-overlay-sidebar', report);

      // Reset tool status & sidebar, open workspace popover
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#history-btn').click();
        document.querySelector('#tool-status-bar').classList.add('hidden');
        document.querySelector('#workspace-pill').click();
      })()`);
      await capture(win, '04-workspace-popover', report);

      await win.webContents.executeJavaScript(`document.querySelector('#workspace-popover').classList.add('hidden')`);

      // 5. Settings -> API Keys
      await win.webContents.executeJavaScript(`document.querySelector('#tb-settings-btn').click()`);
      await sleep(200);
      await capture(win, '05-settings-keys', report);

      // 6. Settings -> Profile & Repos
      await win.webContents.executeJavaScript(`document.querySelector('.s-tab[data-tab="profile"]').click()`);
      await sleep(200);
      await capture(win, '06-settings-profile', report);

      // 7. Settings -> Job Workspaces
      await win.webContents.executeJavaScript(`document.querySelector('.s-tab[data-tab="workspaces"]').click()`);
      await sleep(200);
      await capture(win, '07-settings-workspaces', report);

      // 8. Settings -> Audio (OpenAI selected + Local selected)
      await win.webContents.executeJavaScript(`document.querySelector('.s-tab[data-tab="transcription"]').click()`);
      await sleep(200);
      await win.webContents.executeJavaScript(`document.querySelector('#stt-provider-seg button[data-stt-provider="openai"]').click()`);
      await capture(win, '08-settings-audio-openai', report);
      await win.webContents.executeJavaScript(`document.querySelector('#stt-provider-seg button[data-stt-provider="local"]').click()`);
      await capture(win, '08b-settings-audio-local', report);

      // Close settings
      await win.webContents.executeJavaScript(`document.querySelector('#s-close').click()`);
      await sleep(200);

      // 9. Prep Brief Drawer
      await win.webContents.executeJavaScript(`document.querySelector('#open-brief-btn').click()`);
      await sleep(200);
      await capture(win, '09-prep-brief-drawer', report);
      await win.webContents.executeJavaScript(`document.querySelector('#brief-close-btn').click()`);

      // 10. Dissection & Failure Journal Drawer (top + scrolled to journal)
      await win.webContents.executeJavaScript(`document.querySelector('#open-dissection-btn').click()`);
      await sleep(250);
      await capture(win, '10-dissection-drawer', report);
      await win.webContents.executeJavaScript(`(() => {
        const body = document.querySelector('#dissection-drawer .pue-drawer-body');
        if (body) body.scrollTop = body.scrollHeight;
      })()`);
      await capture(win, '11-dissection-journal-scrolled', report);

      fs.writeFileSync(path.join(OUT_DIR, 'layout-report.json'), JSON.stringify(report, null, 2));
      console.log('UI_AUDIT_OUT=' + OUT_DIR);
      let totalIssues = 0;
      for (const r of report) {
        totalIssues += r.issues.length;
        console.log(`[${r.label}] issues=${r.issues.length ? r.issues.join(' ; ') : 'none'}`);
      }
      if (totalIssues > 0) process.exitCode = 1;
      app.exit(totalIssues > 0 ? 1 : 0);
    } catch (err) {
      console.error('Audit error:', err);
      app.exit(1);
    }
  });
});

seedSampleData().then(() => {
  require('../../main.js');
});
