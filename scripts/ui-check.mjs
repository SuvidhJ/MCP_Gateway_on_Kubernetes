#!/usr/bin/env node
// Visual smoke check of the dashboard SPA, dependency-free (Node 24: global fetch + WebSocket).
// Launches headless Edge (or Chrome), logs in through the real form, screenshots each page into
// out/ui/, creates + revokes an API key through the UI, expands a server row, and reports console
// errors, exceptions and failed network requests. Exit code 1 if any problem was collected.
//
//   fnm exec --using=24.21.0 node scripts/ui-check.mjs
//   env: UI_URL (default http://gateway.127.0.0.1.nip.io:8080), UI_EMAIL (default admin@urumi.local),
//        UI_PASSWORD (default: read from secret gateway-app via kubectl, context UI_KUBE_CONTEXT=k3d-urumi-dev),
//        UI_BROWSER (path to msedge/chrome), UI_OUT (default out/ui)
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = (process.env.UI_URL ?? 'http://gateway.127.0.0.1.nip.io:8080').replace(/\/$/, '');
const EMAIL = process.env.UI_EMAIL ?? 'admin@urumi.local';
const OUT = resolve(process.env.UI_OUT ?? 'out/ui');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function password() {
  if (process.env.UI_PASSWORD) return process.env.UI_PASSWORD;
  const ctx = process.env.UI_KUBE_CONTEXT ?? 'k3d-urumi-dev';
  const b64 = execFileSync('kubectl', ['--context', ctx, '-n', 'urumi', 'get', 'secret', 'gateway-app',
    '-o', 'jsonpath={.data.admin-password}'], { encoding: 'utf8' });
  return Buffer.from(b64.trim(), 'base64').toString('utf8');
}

function browserPath() {
  const candidates = [
    process.env.UI_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean);
  const p = candidates.find((c) => existsSync(c));
  if (!p) throw new Error('No Edge/Chrome found; set UI_BROWSER');
  return p;
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

// ---- minimal CDP client ----
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { (this.handlers.get(method) ?? this.handlers.set(method, []).get(method)).push(fn); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  const pw = password();
  mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'ui-check-'));
  const exe = browserPath();
  const browser = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1400,900',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', 'about:blank',
  ], { stdio: 'ignore' });

  const problems = [];
  let cdp;
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('browser did not expose a page target');
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);

    let phase = 'login';
    const note = (kind, text) => { problems.push({ phase, kind, text }); };
    const urls = new Map();
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'assert') return;
      note('console', p.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    });
    cdp.on('Runtime.exceptionThrown', (p) => note('exception', p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
    cdp.on('Log.entryAdded', (p) => {
      // The browser logs every >=400 fetch as "Failed to load resource"; those are reported via Network below.
      if (p.entry.level === 'error' && p.entry.source !== 'network') note('log', `${p.entry.source}: ${p.entry.text}`);
    });
    cdp.on('Network.requestWillBeSent', (p) => urls.set(p.requestId, `${p.request.method} ${p.request.url}`));
    cdp.on('Network.loadingFailed', (p) => {
      if (p.canceled) return; // aborted fetches (navigation / query cancellation) are not failures
      note('network', `${urls.get(p.requestId) ?? p.requestId} failed: ${p.errorText}`);
    });
    cdp.on('Network.responseReceived', (p) => {
      const { status, url } = p.response;
      if (status < 400) return;
      const path = new URL(url).pathname;
      if (phase === 'login' && status === 401 && path === '/api/me') return; // expected before login
      note('network', `${urls.get(p.requestId) ?? url} -> ${status}`);
    });
    cdp.on('Page.javascriptDialogOpening', (p) => {
      console.log(`  dialog (${p.type}): ${p.message}`);
      void cdp.send('Page.handleJavaScriptDialog', { accept: true });
    });
    await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'].map((m) => cdp.send(m)));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const waitFor = async (expression, what, timeout = 10_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(`!!(${expression})`)) return;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const shot = async (name, fullPage = true) => {
      let clip;
      if (fullPage) {
        const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
        clip = { x: 0, y: 0, width: 1400, height: Math.max(900, Math.ceil(cssContentSize.height)), scale: 1 };
      }
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      const file = join(OUT, `${name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  saved ${file}`);
    };
    // React-friendly input: native value setter + bubbling input event.
    const fill = (selector, value) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no element ' + ${JSON.stringify(selector)});
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const clickByText = (selector, text, scope = 'document') => evaluate(`(() => {
      const el = [...${scope}.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

    // ---- login ----
    console.log(`Browser: ${exe}\nOpening ${BASE}/`);
    await cdp.send('Page.navigate', { url: `${BASE}/#/servers` });
    await waitFor(`document.querySelector('form.login input[type=email]')`, 'login form');
    await sleep(300);
    await shot('login', false);
    await fill('form.login input[type=email]', EMAIL);
    await fill('form.login input[type=password]', pw);
    await evaluate(`document.querySelector('form.login').requestSubmit()`);
    await waitFor(`document.querySelector('header.topbar')`, 'dashboard after login');
    phase = 'app';

    const pages = await evaluate(`[...document.querySelectorAll('header.topbar nav a')].map((a) => a.getAttribute('href'))`);
    console.log(`Logged in; nav: ${pages.join(' ')}`);
    for (const href of pages) {
      const name = href.replace(/^#\/?/, '');
      phase = name;
      await evaluate(`location.hash = ${JSON.stringify(href)}`);
      await sleep(1500);
      await shot(name);
    }

    // ---- servers: expand first row's tools ----
    phase = 'servers-tools';
    await evaluate(`location.hash = '#/servers'`);
    await waitFor(`document.querySelector('td.expander button')`, 'server rows');
    const rowName = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td.expander'));
      const row = rows.find((r) => /store/i.test(r.textContent)) ?? rows[0];
      row.querySelector('td.expander button').click();
      return row.querySelector('.strong')?.textContent;
    })()`);
    await waitFor(`document.querySelector('tr.detail table.inner')`, 'tools table');
    await sleep(500);
    console.log(`Expanded server "${rowName}"`);
    await shot('servers-tools');

    // ---- keys: create, screenshot secret, revoke ----
    phase = 'keys-create';
    await evaluate(`location.hash = '#/keys'`);
    await waitFor(`document.querySelector('form.inline-form input')`, 'key form');
    await fill('form.inline-form input', 'ui-check');
    await evaluate(`document.querySelector('form.inline-form').requestSubmit()`);
    await waitFor(`document.querySelector('.secret-box code.secret')`, 'one-time secret box');
    await sleep(800);
    const secret = await evaluate(`document.querySelector('.secret-box code.secret').textContent`);
    console.log(`Created key ui-check (secret prefix ${secret.slice(0, 12)}…)`);
    await shot('keys-created');

    phase = 'keys-revoke';
    await clickByText('.secret-box button', 'I have saved it');
    const clicked = await evaluate(`(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((r) =>
        r.querySelector('td.strong')?.textContent === 'ui-check' && [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Revoke'));
      if (!row) return false;
      [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Revoke').click();
      return true;
    })()`);
    if (!clicked) note('ui', 'no active ui-check key row with a Revoke button');
    else {
      await waitFor(`[...document.querySelectorAll('tbody tr')].some((r) => r.querySelector('td.strong')?.textContent === 'ui-check' && /Revoked/.test(r.textContent) && r.classList.contains('dim'))`, 'revoked badge');
      await sleep(500);
      console.log('Revoked key ui-check');
      await shot('keys-revoked');
    }
    phase = 'end';
    await sleep(500);
  } finally {
    cdp?.close();
    browser.kill();
    if (process.platform === 'win32' && browser.pid) {
      try { execFileSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold files */ }
  }

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  [${p.phase}] ${p.kind}: ${p.text}`);
    process.exitCode = 1;
  } else {
    console.log('\nNo console errors, exceptions or failed requests.');
  }
}

main().catch((e) => { console.error(`ui-check failed: ${e.stack ?? e}`); process.exit(2); });
