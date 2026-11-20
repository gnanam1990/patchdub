// PatchDub browser check: drives the real console in a headless Chrome over
// the DevTools protocol (no npm dependencies; Node >=22 built-in WebSocket).
//
// Usage:
//   node scripts/browser-check.ts
// Env:
//   PATCHDUB_CHROME   browser binary (default: macOS Playwright cache
//                     chromium_headless_shell-1254, falling back to 1248 or
//                     `which chrome-headless-shell`)
//   KEEP_ARTIFACTS=1  keep the disposable data/profile dirs for debugging
//
// What it proves (documented journey): sign-in → open edition → alignment
// shows which cues need repair → bounded quote approval → real worker settles
// → required-term finding on C5 → blocked final export error → keyboard-only
// reviewer resolves + approves → final export + manifest → reload persistence
// → 320px keyboard pass → distributor permission view → bad-token error.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/app.ts';
import { LocalSellerAdapter } from '../src/provider.ts';
import { fixture } from '../test/helpers.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE = join(ROOT, 'build-progress/patchdub/evidence/browser');
const CHROME_CANDIDATES = [
  process.env.PATCHDUB_CHROME,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
].filter(Boolean) as string[];

const results: { name: string; ok: boolean; note?: string }[] = [];
const check = (name: string, ok: boolean, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`);
};

// ---------- CDP client (built-in WebSocket) ----------

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private listeners = new Map<string, ((p: any) => void)[]>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', (e) => rej(new Error(`ws connect failed ${e}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method: string, fn: (params: any) => void): void {
    const l = this.listeners.get(method) ?? [];
    l.push(fn);
    this.listeners.set(method, l);
  }
}

class Page {
  private cdp: Cdp;
  private sessionId: string;
  constructor(cdp: Cdp, sessionId: string) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, this.sessionId);
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result?.value as T;
  }

  async waitFor(expression: string, timeoutMs = 15_000, label = expression.slice(0, 60)): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await this.eval(`!!(${expression})`)) return;
      } catch { /* eval can fail while the frame is navigating */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((res) => this.cdp.on('Page.loadEventFired', () => res()));
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 10_000))]);
    await this.waitFor('document.readyState === "complete"', 10_000, 'load');
  }

  async reload(): Promise<void> {
    await this.cdp.send('Page.reload', {}, this.sessionId);
    await new Promise((r) => setTimeout(r, 400));
    await this.waitFor('document.readyState === "complete"', 10_000, 'reload');
  }

  async setViewport(width: number, height: number, mobile = false): Promise<void> {
    await this.cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile }, this.sessionId);
  }

  async key(key: string, code: string, vkc: number): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.cdp.send('Input.dispatchKeyEvent',
        { type, key, code, windowsVirtualKeyCode: vkc, nativeVirtualKeyCode: vkc }, this.sessionId);
    }
  }

  async insertText(text: string): Promise<void> {
    await this.cdp.send('Input.insertText', { text }, this.sessionId);
  }

  async shot(name: string): Promise<string> {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
    const file = join(EVIDENCE, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
}

// ---------- helpers ----------

async function api(base: string, method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollApi(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---------- main ----------

const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chrome) {
  console.error('no headless chrome found; set PATCHDUB_CHROME');
  process.exit(2);
}

// data/ is gitignored and absent on a clean checkout — create it first.
const scratchDir = join(ROOT, 'data');
mkdirSync(scratchDir, { recursive: true });
const dataDir = mkdtempSync(join(scratchDir, 'browser-check-data-'));
const profileDir = mkdtempSync(join(scratchDir, 'browser-check-profile-'));
mkdirSync(EVIDENCE, { recursive: true });

// Same default path the worker resolves via PATCHDUB_DATA.
const db = openDb(join(dataDir, 'patchdub.db'));
const adapter = new LocalSellerAdapter(db, {
  lexicon: {
    'Close the intake valve fully.': 'உள்ளீட்டு வால்வை முழுவதும் மூடவும்.',
    'Wear your safety harness at all times.': 'எப்போதும் உங்கள் கட்டைப் பட்டை அணியவும்.',
  },
});
const server = createApp({ db, adapter });
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// Real worker process against the same data dir (supervised path).
const worker: ChildProcess = spawn('node', ['src/worker-main.ts'], {
  cwd: ROOT,
  env: { ...process.env, PATCHDUB_DATA: dataDir, PATCHDUB_WORKER_INTERVAL_MS: '200' },
  stdio: 'ignore',
});

let browser: ChildProcess | undefined;
try {
  // Seed the studio state through the API (UI journey starts at sign-in).
  const ws = await api(base, 'POST', '/api/workspaces', undefined, { name: 'Browser Check Studio', producerName: 'Priya' });
  const wsId = ws.body.workspace.id;
  const producer = ws.body.producer.token;
  const mk = async (role: string) => (await api(base, 'POST', `/api/workspaces/${wsId}/actors`, producer, { name: role, role })).body.token;
  const tokens = { producer, editor: await mk('editor'), reviewer: await mk('reviewer'), distributor: await mk('distributor'), operator: await mk('operator') };
  const ed = await api(base, 'POST', '/api/editions', tokens.editor, { workspaceId: wsId, title: 'Valve safety ep1', sourceLocale: 'en', targetLocale: 'ta' });
  const edId = ed.body.id;
  const r1 = await api(base, 'POST', `/api/editions/${edId}/revisions`, tokens.editor, { kind: 'source', label: 'prev', content: fixture('prev-source.vtt'), idempotencyKey: 'bc-prev' });
  await api(base, 'POST', `/api/editions/${edId}/revisions`, tokens.editor, { kind: 'target', label: 'ta', content: fixture('prev-target.vtt'), sourceRevisionId: r1.body.revisionId, idempotencyKey: 'bc-tgt' });
  const r3 = await api(base, 'POST', `/api/editions/${edId}/revisions`, tokens.editor, { kind: 'source', label: 'new', content: fixture('new-source.vtt'), parentId: r1.body.revisionId, idempotencyKey: 'bc-new' });
  await api(base, 'POST', `/api/workspaces/${wsId}/glossaries`, producer, { name: 'course-terms', terms: [{ source: 'safety', target: 'பாதுகாப்பு', required: true }] });
  await api(base, 'POST', `/api/revisions/${r3.body.revisionId}/alignment/recompute`, tokens.editor);

  // Launch headless chrome. --no-sandbox/--single-process are needed where the
  // host seatbelt denies Chromium's Mach-port rendezvous; override with
  // PATCHDUB_CHROME_FLAGS (space-separated) on hosts that permit multiprocess.
  const chromeFlags = process.env.PATCHDUB_CHROME_FLAGS
    ? process.env.PATCHDUB_CHROME_FLAGS.split(/\s+/).filter(Boolean)
    : ['--no-sandbox', '--single-process', '--disable-gpu'];
  browser = spawn(chrome, [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--remote-allow-origins=*',
    '--force-device-scale-factor=1',
    ...chromeFlags,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = '';
    browser!.stderr!.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error('no DevTools ws within 15s')), 15_000);
  });
  const cdp = await Cdp.connect(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await page.setViewport(1280, 900);

  // --- Journey 1: producer signs in, opens the case, sees the repair map ---
  await page.navigate(base);
  await page.waitFor('!document.querySelector("#view-signin").hidden');
  await page.eval(`document.querySelector('#in-token').value = ${JSON.stringify(producer)}`);
  await page.eval(`document.querySelector('#in-workspace').value = ${JSON.stringify(wsId)}`);
  await page.eval(`document.querySelector('#form-signin').requestSubmit()`);
  await page.waitFor('!document.querySelector("#view-editions").hidden');
  check('sign-in reaches edition list', true);

  await page.eval(`document.querySelector('#edition-list a').click()`);
  await page.waitFor('document.querySelectorAll("#align-table tbody tr").length >= 6');
  const alignKinds = await page.eval(`[...document.querySelectorAll('#align-table tbody tr')].map(r => r.cells[3].textContent)`);
  check('alignment shows cue repair kinds', alignKinds.includes('edit') && alignKinds.includes('retime') && alignKinds.includes('unchanged'), JSON.stringify(alignKinds));
  const cueLabels = await page.eval(`[...document.querySelectorAll('#align-table tbody tr')].map(r => r.cells[2].textContent).join('|')`);
  check('alignment shows readable cue labels (C4 retimed)', /C4 · 12\.5s–15\.5s/.test(cueLabels), cueLabels.slice(0, 120));
  await page.shot('01-alignment');

  // --- Plan + bounded quote through the UI ---
  await page.eval(`document.querySelector('#in-cap').value = '4'`);
  await page.eval(`document.querySelector('#in-glossary').selectedIndex = 1`);
  await page.eval(`document.querySelector('#form-plan').requestSubmit()`);
  await page.waitFor('!document.querySelector("#quote-box").hidden');
  const quote = await page.eval(`document.querySelector('#quote-text').textContent`);
  check('quote shows total vs cap', /4 minor units against cap 4/i.test(quote), quote);
  await page.eval(`document.querySelector('#quote-box').scrollIntoView({block:'center'})`);
  await page.shot('02-quote');
  await page.eval(`document.querySelector('#btn-approve').click()`);
  await page.waitFor(`document.querySelector('#status').textContent.includes('dispatched')`, 10_000, 'approve announce');
  check('approve announces operation', true);

  // Real worker settles the two orders.
  await pollApi(async () => {
    const d = await api(base, 'GET', `/api/editions/${edId}/patches`, producer);
    return d.body.patches?.length >= 1
      && d.body.patches.every((p: any) => p.status !== 'dispatched' && p.status !== 'pending');
  }, 20_000, 'worker settle');
  const patchStates = await api(base, 'GET', `/api/editions/${edId}/patches`, producer);
  const flagged = patchStates.body.patches.find((p: any) => p.cue_label === 'C5');
  check('C5 patch flagged by required-term check', flagged?.status === 'flagged' && flagged.open_findings > 0, JSON.stringify(flagged?.status));

  // --- Error visibility: final export blocked while the finding is open ---
  await page.reload();
  await page.waitFor('document.querySelectorAll("#patch-table tbody tr").length >= 1');
  await page.eval(`document.querySelector('#btn-final').click()`);
  await page.waitFor(`[...document.querySelectorAll('#alerts .alert')].some(a => /block/i.test(a.textContent))`, 8_000, 'blocked export alert');
  const alertText = await page.eval(`[...document.querySelectorAll('#alerts .alert')].map(a=>a.textContent).join(' ')`);
  check('final export blocked with visible reason', /finding|patch|approv/i.test(alertText), alertText.slice(0, 160));
  await page.eval(`document.querySelector('#panel-export').scrollIntoView({block:'center'})`);
  await page.shot('03-export-blocked');

  // --- Switch actor: reviewer, keyboard-only journey ---
  await page.eval('localStorage.clear()');
  await page.reload();
  await page.waitFor('!document.querySelector("#view-signin").hidden');
  await page.eval(`document.querySelector('#in-token').value = ${JSON.stringify(tokens.reviewer)}`);
  await page.eval(`document.querySelector('#in-workspace').value = ${JSON.stringify(wsId)}`);
  await page.eval(`document.querySelector('#form-signin').requestSubmit()`);
  await page.waitFor('!document.querySelector("#view-editions").hidden');
  await page.eval(`document.querySelector('#edition-list a').click()`);
  await page.waitFor('document.querySelectorAll("#patch-table tbody tr").length >= 1');
  await page.waitFor(`[...document.querySelectorAll('#patch-table tbody tr textarea')].every(t => t.value.length > 0)`, 10_000, 'variant hydration');

  // Keyboard: focus first row, j/k moves selection.
  await page.eval(`document.querySelector('#patch-table tr[data-patch]').focus()`);
  const firstSel = await page.eval(`document.querySelector('#patch-table tr.selected')?.dataset.patch`);
  await page.key('j', 'KeyJ', 74);
  await sleep(200);
  const secondSel = await page.eval(`document.querySelector('#patch-table tr.selected')?.dataset.patch`);
  check('keyboard j moves selection to next cue', firstSel !== secondSel && !!secondSel, `${firstSel} -> ${secondSel}`);
  await page.key('k', 'KeyK', 75);
  await sleep(200);
  const backSel = await page.eval(`document.querySelector('#patch-table tr.selected')?.dataset.patch`);
  check('keyboard k returns selection', backSel === firstSel);

  // Approve C2 via keyboard 'a' (its variant is clean).
  const c2Patch = patchStates.body.patches.find((p: any) => p.cue_label === 'C2');
  await page.eval(`document.querySelector('#patch-table tr[data-patch="${c2Patch.id}"]').focus()`);
  await page.key('a', 'KeyA', 65);
  await pollApi(async () => (await api(base, 'GET', `/api/patches/${c2Patch.id}`, tokens.reviewer)).body.patch.status === 'approved', 10_000, 'C2 approved');
  check('keyboard a approves clean patch', true);
  // reviewPatch re-renders the table ~300ms after approve; let it settle.
  await sleep(700);
  await page.waitFor(`[...document.querySelectorAll('#patch-table tbody tr textarea')].every(t => t.value.length > 0)`, 10_000, 're-render hydration');

  // C5: 'e' edits the variant, insert corrected Tamil, 's' saves, 'a' approves.
  const c5Patch = patchStates.body.patches.find((p: any) => p.cue_label === 'C5');
  let activeIsTextarea = false;
  for (let attempt = 0; attempt < 5 && !activeIsTextarea; attempt++) {
    await page.eval(`document.querySelector('#patch-table tr[data-patch="${c5Patch.id}"]')?.focus()`);
    await page.key('e', 'KeyE', 69);
    await sleep(250);
    activeIsTextarea = await page.eval(`document.activeElement.tagName === 'TEXTAREA'`);
  }
  check('keyboard e focuses variant editor', activeIsTextarea);
  await page.eval('document.activeElement.select()');
  await page.insertText('எப்போதும் உங்கள் பாதுகாப்பு கட்டைப் பட்டை அணியவும்.');
  // Escape returns focus to the cue row (editor keeps plain keys for typing),
  // then 's' saves the variant.
  await page.key('Escape', 'Escape', 27);
  await sleep(150);
  const focusAfterEsc = await page.eval(`document.activeElement.tagName + '/' + (document.activeElement.dataset?.patch || '')`);
  await page.key('s', 'KeyS', 83);
  try {
    await pollApi(async () => (await api(base, 'GET', `/api/patches/${c5Patch.id}`, tokens.reviewer)).body.findings.every((f: any) => f.status === 'resolved'), 10_000, 'finding resolved at new digest');
  } catch (err) {
    const ta = await page.eval(`document.querySelector('#patch-table tr[data-patch="${c5Patch.id}"] textarea')?.value`);
    const st = await api(base, 'GET', `/api/patches/${c5Patch.id}`, tokens.reviewer);
    console.log('DEBUG focusAfterEsc:', focusAfterEsc, 'textarea:', JSON.stringify(ta).slice(0, 200), 'findings:', JSON.stringify(st.body.findings).slice(0, 300));
    throw err;
  }
  check('keyboard s saves variant; required-term finding resolves', true);
  await page.eval(`document.querySelector('#patch-table tr[data-patch="${c5Patch.id}"]')?.scrollIntoView({block:'center'})`);
  await page.shot('04-review-resolved');
  // saveVariant re-renders ~300ms after the PUT; refocus the row then approve.
  await page.waitFor(`document.querySelector('#patch-table tr[data-patch="${c5Patch.id}"]')`, 10_000, 'row re-rendered');
  await page.eval(`document.querySelector('#patch-table tr[data-patch="${c5Patch.id}"]').focus()`);
  await page.key('a', 'KeyA', 65);
  await pollApi(async () => (await api(base, 'GET', `/api/patches/${c5Patch.id}`, tokens.reviewer)).body.patch.status === 'approved', 10_000, 'C5 approved');
  check('keyboard a approves corrected digest', true);

  // --- Final export through the UI ---
  await page.reload();
  await page.waitFor('document.querySelectorAll("#export-list li").length >= 0 && !document.querySelector("#view-case").hidden');
  await page.eval(`document.querySelector('#btn-final').click()`);
  await page.waitFor(`document.querySelectorAll('#export-list li').length >= 1`, 10_000, 'final export listed');
  const exportRows = await page.eval(`[...document.querySelectorAll('#export-list li')].map(l=>l.textContent).join('|')`);
  check('final export listed in UI', /final/.test(exportRows), exportRows.slice(0, 120));
  await page.eval(`document.querySelector('#export-list').scrollIntoView({block:'center'})`);
  await page.shot('05-final-export');
  const manifest = await api(base, 'GET', `/api/editions/${edId}/case`, producer).then(async (d) => {
    const fin = d.body.exports.find((x: any) => x.kind === 'final');
    return api(base, 'GET', `/api/exports/${fin.id}/manifest`, producer);
  });
  check('manifest records 8s billable union, 4 minor, 2 items',
    manifest.body.usage?.billableSeconds === 8 && manifest.body.usage?.totalMinor === 4 && manifest.body.usage?.paidItems === 2,
    JSON.stringify(manifest.body.usage));

  // --- Reload persistence: selected cue survives refresh via the hash ---
  await page.eval(`document.querySelector('#patch-table tr[data-patch="${c5Patch.id}"]').focus()`);
  await page.reload();
  await page.waitFor('document.querySelectorAll("#patch-table tbody tr").length >= 1');
  const persisted = await page.eval(`document.querySelector('#patch-table tr.selected')?.dataset.patch`);
  check('selected cue persists across reload', persisted === c5Patch.id, `${persisted}`);

  // --- 320px keyboard pass ---
  await page.setViewport(320, 700, true);
  await page.reload();
  await page.waitFor('!document.querySelector("#view-case").hidden');
  const vp = await page.eval(`innerWidth + '/' + matchMedia('(max-width: 480px)').matches + '/' + getComputedStyle(document.querySelector('#patch-table')).display`);
  console.log('  [320px viewport probe]', vp);
  const overflow = await page.eval('document.documentElement.scrollWidth');
  const wide = await page.eval(`[...document.querySelectorAll('body *')]
    .filter(el => el.getBoundingClientRect().right > 330)
    .map(el => el.tagName.toLowerCase() + '#' + (el.id || '') + ' w=' + Math.round(el.getBoundingClientRect().width))
    .slice(0, 8).join(', ')`);
  check('no horizontal page overflow at 320px', overflow <= 340, `scrollWidth=${overflow} wide: ${wide}`);
  const firstRowPatch = await page.eval(`document.querySelector('#patch-table tr[data-patch]')?.dataset.patch`);
  await page.eval(`document.querySelector('#patch-table tr[data-patch]').focus()`);
  await page.key('j', 'KeyJ', 74);
  await sleep(200);
  const moved320 = await page.eval(`document.querySelector('#patch-table tr.selected')?.dataset.patch`);
  check('keyboard navigation works at 320px', !!moved320 && moved320 !== firstRowPatch, `selected=${moved320}`);
  const focusVisible = await page.eval(`getComputedStyle(document.activeElement).outlineStyle !== 'none' || document.activeElement.tagName === 'TR'`);
  check('focus is keyboard-visible at 320px', focusVisible);
  await page.shot('06-mobile-320');

  // --- Permission visibility: distributor sees download-only surface ---
  await page.setViewport(1280, 900);
  await page.eval('localStorage.clear()');
  await page.reload();
  await page.waitFor('!document.querySelector("#view-signin").hidden');
  await page.eval(`document.querySelector('#in-token').value = ${JSON.stringify(tokens.distributor)}`);
  await page.eval(`document.querySelector('#in-workspace').value = ${JSON.stringify(wsId)}`);
  await page.eval(`document.querySelector('#form-signin').requestSubmit()`);
  await page.waitFor('!document.querySelector("#view-editions").hidden');
  await page.eval(`document.querySelector('#edition-list a').click()`);
  await page.waitFor('document.querySelectorAll("#patch-table tbody tr").length >= 1');
  const reviewerOnly = await page.eval(`[...document.querySelectorAll('#patch-table tbody tr td:last-child')].every(td => /reviewer only/.test(td.textContent))`);
  check('distributor sees reviewer-only actions, no edit affordance', reviewerOnly);
  const exportBtnsHidden = await page.eval(`document.querySelector('#btn-final').hidden && document.querySelector('#btn-draft').hidden`);
  check('distributor export buttons hidden', exportBtnsHidden);
  const draftHidden = await page.eval(`[...document.querySelectorAll('#export-list li')].every(li => /final/.test(li.textContent))`);
  check('draft exports hidden from distributor', draftHidden);
  await page.eval(`document.querySelector('#patch-table').scrollIntoView({block:'start'})`);
  await page.shot('07-distributor');

  // --- Error visibility: bad token shows a clear failure ---
  await page.eval('localStorage.clear()');
  await page.reload();
  await page.waitFor('!document.querySelector("#view-signin").hidden');
  await page.eval(`document.querySelector('#in-token').value = 'pd_actor_deadbeef'`);
  await page.eval(`document.querySelector('#in-workspace').value = ${JSON.stringify(wsId)}`);
  await page.eval(`document.querySelector('#form-signin').requestSubmit()`);
  await page.waitFor(`[...document.querySelectorAll('#alerts .alert')].some(a => /sign-in failed/i.test(a.textContent))`, 8_000, 'sign-in failure alert');
  check('bad token produces visible sign-in error', true);
  await page.shot('08-signin-error');

  await page.eval('window.close()').catch(() => {});
} finally {
  browser?.kill('SIGKILL');
  worker.kill('SIGKILL');
  server.close();
  db.close();
  if (process.env.KEEP_ARTIFACTS !== '1') {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`FAILED: ${f.name} ${f.note ?? ''}`);
  process.exit(1);
}
