// Headless Firefox driver for GUI-level checks of the shipped extension. Node stdlib only.
// Marionette (classic WebDriver) supplies chrome-context access: opening moz-extension:// pages as
// tabs (BiDi refuses to navigate there) and firing the extension's keyboard commands. WebDriver
// BiDi on the same session supplies screenshots, script evaluation, trusted pointer/keyboard input,
// and user-prompt handling. Requires Firefox >= 133 (webExtension.install).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXT_ID = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).browser_specific_settings.gecko.id;
export const UUID = '11111111-1111-4111-8111-111111111111';
export const EXT = `moz-extension://${UUID}`;
const FF = process.env.FIREFOX_BIN || '/Applications/Firefox.app/Contents/MacOS/firefox';
export const KEYS = { Enter: '', Tab: '', Escape: '', ArrowDown: '', ArrowUp: '', Backspace: '', Shift: '', Control: '', Alt: '', Meta: '' };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }

class Marionette {
  constructor(port) { this.port = port; this.id = 0; this.pending = new Map(); this.buf = Buffer.alloc(0); }
  connect() {
    return new Promise((res, rej) => {
      this.sock = net.connect(this.port, '127.0.0.1');
      this.sock.on('error', rej);
      this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
      this.hello = res;
    });
  }
  drain() {
    for (;;) {
      const i = this.buf.indexOf(':');
      if (i < 0) return;
      const len = parseInt(this.buf.subarray(0, i).toString(), 10);
      if (this.buf.length < i + 1 + len) return;
      const msg = JSON.parse(this.buf.subarray(i + 1, i + 1 + len).toString());
      this.buf = this.buf.subarray(i + 1 + len);
      if (!Array.isArray(msg)) { if (this.hello) { this.hello(msg); this.hello = null; } continue; }
      const [, id, err, result] = msg;
      const p = this.pending.get(id); if (!p) continue; this.pending.delete(id);
      err ? p.rej(new Error(`${err.error}: ${err.message}`)) : p.res(result);
    }
  }
  cmd(name, params = {}) {
    return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); const body = JSON.stringify([0, id, name, params]); this.sock.write(`${Buffer.byteLength(body)}:${body}`); });
  }
  async chrome(script, args = []) {
    await this.cmd('Marionette:SetContext', { value: 'chrome' });
    try { return (await this.cmd('WebDriver:ExecuteScript', { script, args })).value; }
    finally { await this.cmd('Marionette:SetContext', { value: 'content' }); }
  }
  async chromeAsync(script, args = []) {
    await this.cmd('Marionette:SetContext', { value: 'chrome' });
    try { return (await this.cmd('WebDriver:ExecuteAsyncScript', { script, args, scriptTimeout: 10000 })).value; }
    finally { await this.cmd('Marionette:SetContext', { value: 'content' }); }
  }
}

export async function launch({ headless = true, workDir, dpr = 1.5 } = {}) {
  const bidiPort = await freePort(); const mPort = await freePort();
  workDir = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'uir-e2e-'));
  const profile = fs.mkdtempSync(path.join(workDir, 'profile-'));
  const downloads = fs.mkdtempSync(path.join(workDir, 'downloads-'));
  const shots = path.join(workDir, 'shots');
  const prefs = {
    'marionette.port': mPort,
    'extensions.webextensions.uuids': JSON.stringify({ [EXT_ID]: UUID }),
    'extensions.webextOptionalPermissionPrompts': false,
    'app.update.enabled': false, 'app.update.auto': false, 'app.normandy.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false, 'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.enabled': false, 'toolkit.telemetry.unified': false, 'toolkit.telemetry.server': '',
    'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage': 'about:blank', 'browser.startup.page': 0,
    'browser.newtabpage.enabled': false, 'browser.aboutConfig.showWarning': false, 'dom.disable_beforeunload': true,
    'browser.download.dir': downloads, 'browser.download.folderList': 2, 'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false, 'browser.download.alwaysOpenPanel': false,
    'extensions.update.enabled': false, 'extensions.blocklist.enabled': false, 'extensions.getAddons.cache.enabled': false,
    'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false,
    'browser.safebrowsing.enabled': false, 'browser.safebrowsing.malware.enabled': false, 'browser.safebrowsing.phishing.enabled': false,
    'services.settings.server': 'data:,#remote-settings-dummy/v1',
    'remote.log.level': 'Info',
    'layout.css.devPixelsPerPx': String(dpr), // non-integer scale exercises the screenshot-mask scaling
  };
  fs.writeFileSync(path.join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n');
  const args = ['--marionette', '--remote-allow-system-access', '--no-remote', '--new-instance', '--profile', profile, '--remote-debugging-port', String(bidiPort), 'about:blank'];
  if (headless) args.unshift('--headless');
  const proc = spawn(FF, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  const onData = (d) => { const s = d.toString(); logs.push(s); if (process.env.FF_VERBOSE) process.stderr.write(s); };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);

  const m = new Marionette(mPort);
  let hello;
  for (let i = 0; i < 120 && !hello; i++) { await sleep(250); try { hello = await m.connect(); } catch (_) { /* not up yet */ } }
  if (!hello) { proc.kill(); throw new Error('Marionette not reachable\n' + logs.join('')); }
  const ns = await m.cmd('WebDriver:NewSession', { webSocketUrl: true, unhandledPromptBehavior: 'ignore' });
  const wsUrl = ns.capabilities && ns.capabilities.webSocketUrl;
  if (!wsUrl) { proc.kill(); throw new Error('no webSocketUrl in capabilities'); }
  const ws = await new Promise((res, rej) => { const w = new WebSocket(wsUrl); w.onopen = () => res(w); w.onerror = () => rej(new Error('BiDi websocket error')); });
  let id = 0; const pending = new Map(); const events = []; const listeners = [];
  ws.onmessage = (raw) => {
    const msg = JSON.parse(raw.data);
    if (msg.id !== undefined && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.type === 'error' ? rej(new Error(`${msg.error}: ${msg.message}`)) : res(msg.result); }
    else if (msg.type === 'event') { events.push(msg); listeners.forEach((l) => l(msg)); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('session.subscribe', { events: ['log.entryAdded', 'browsingContext.userPromptOpened'] });
  await send('webExtension.install', { extensionData: { type: 'path', path: REPO } });
  const tree = await send('browsingContext.getTree', {});

  const api = {
    proc, send, m, events, logs, profile, downloads, shots, workDir, ctx: tree.contexts[0].context, sleep, extContexts: new Set(),
    onEvent: (l) => listeners.push(l),
    async tree() { return (await send('browsingContext.getTree', {})).contexts.map((c) => ({ context: c.context, url: c.url })); },
    async children(c) { return (await send('browsingContext.getTree', { root: c })).contexts[0].children.map((x) => ({ context: x.context, url: x.url })); },
    async goto(c, url) { return send('browsingContext.navigate', { context: c, url, wait: 'complete' }); },
    // Open a moz-extension:// page as a tab from chrome context (BiDi navigate refuses privileged URLs).
    async openExt(url) {
      const bcId = await m.chrome('const tab = gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); gBrowser.selectedTab = tab; return String(tab.linkedBrowser.browsingContext.id);', [url]);
      for (let i = 0; i < 80; i++) {
        const hit = (await api.tree()).find((x) => x.context === bcId || x.url === url);
        if (hit && hit.url === url) { await sleep(300); api.extContexts.add(hit.context); return hit.context; }
        await sleep(150);
      }
      throw new Error('extension tab did not appear: ' + url);
    },
    // Grant optional host permissions without a user gesture (extension pages can load in the parent
    // process, where BiDi input to click a permission button is unavailable). Chrome-scope only.
    async grantHostPermissions(origins = ['http://*/*', 'https://*/*'], permissions = []) {
      return m.chromeAsync(`const resolve = arguments[arguments.length - 1]; (async () => { const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs'); const policy = WebExtensionPolicy.getByID(arguments[0]); if (!policy) return 'no-policy'; await ExtensionPermissions.add(arguments[0], { permissions: arguments[2], origins: arguments[1] }, policy.extension); return 'granted'; })().then(resolve, (e) => resolve('err:' + e.message));`, [EXT_ID, origins, permissions]);
    },
    async selectTabByUrlPrefix(prefix) { return m.chrome('for (const tab of gBrowser.tabs) { if (tab.linkedBrowser.currentURI.spec.startsWith(arguments[0])) { gBrowser.selectedTab = tab; return true; } } return false;', [prefix]); },
    // Fire a manifest command (toggle-recording / toggle-burst-capture) through the extension keyset.
    async fireCommand(name) {
      const letter = { 'toggle-recording': 'Y', 'toggle-burst-capture': 'G' }[name] || name;
      const widgetId = EXT_ID.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      return m.chrome(`const ks = document.getElementById('ext-keyset-id-' + arguments[1]); if (!ks) return { ok: false, reason: 'no keyset' }; const hit = [...ks.children].find(k => (k.getAttribute('key') || '').toUpperCase() === arguments[0]); if (!hit) return { ok: false }; hit.doCommand(); return { ok: true };`, [letter, widgetId]);
    },
    // BiDi setViewport rejects privileged (moz-extension) contexts, so try it, then fall back to a
    // Marionette OS-window resize (chrome scope), and finally continue best-effort: rect()/scroll_to
    // scroll elements into view so a smaller window does not fail clicks.
    async viewport(c, width, height) {
      try { return await send('browsingContext.setViewport', { context: c, viewport: { width, height } }); }
      catch (_) {
        try { await m.cmd('WebDriver:SetWindowRect', { width: Math.round(width), height: Math.round(Math.min(height, 2000)) }); } catch (__) { /* best effort */ }
      }
    },
    async shot(c, name, opts = {}) { fs.mkdirSync(shots, { recursive: true }); const r = await send('browsingContext.captureScreenshot', { context: c, origin: opts.full ? 'document' : 'viewport' }); const file = path.join(shots, name.endsWith('.png') ? name : name + '.png'); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; },
    async evalIn(c, expression, { awaitPromise = true } = {}) {
      const r = await send('script.evaluate', { expression, target: { context: c }, awaitPromise, resultOwnership: 'root', serializationOptions: { maxObjectDepth: 8, maxDomDepth: 0 } });
      if (r.type === 'exception') throw new Error('eval exception: ' + ((r.exceptionDetails && r.exceptionDetails.text) || JSON.stringify(r.exceptionDetails)));
      return deserialize(r.result);
    },
    async rect(c, selector) {
      return api.evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no element ' + ${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center', inline: 'center' }); let r = el.getBoundingClientRect(); if (r.y < 0 || r.y + r.height > innerHeight) { window.scrollTo(0, window.scrollY + r.y - innerHeight / 2); r = el.getBoundingClientRect(); } return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
    },
    // Click an element found by a JS expression (for controls without stable selectors): stamps a temp id.
    async clickWhere(c, findExpression, tempId) {
      const found = await api.evalIn(c, `(() => { const el = (${findExpression}); if (!el) return false; el.id = ${JSON.stringify(tempId)}; return true; })()`);
      if (!found) throw new Error('clickWhere: no element for ' + findExpression);
      return api.click(c, '#' + tempId);
    },
    async storedReports(c) { return api.evalIn(c, `browser.storage.local.get(['reports']).then(s => Array.isArray(s.reports) ? s.reports : [])`); },
    async click(c, selector) {
      const r = await api.rect(c, selector);
      if (!r.w || !r.h) throw new Error(`element ${selector} has zero size`);
      await send('input.performActions', { context: c, actions: [{ type: 'pointer', id: 'mouse', actions: [{ type: 'pointerMove', x: Math.round(r.x), y: Math.round(r.y) }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    },
    async typeText(c, text) { await send('input.performActions', { context: c, actions: [{ type: 'key', id: 'kb', actions: [...text].flatMap((ch) => [{ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }]) }] }); },
    async type(c, selector, text) { await api.click(c, selector); await api.typeText(c, text); },
    async key(c, value) { const v = KEYS[value] || value; await send('input.performActions', { context: c, actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: v }, { type: 'keyUp', value: v }] }] }); },
    async setSelect(c, selector, value) { return api.evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`); },
    async setFiles(c, selector, files) { const h = await send('script.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, target: { context: c }, awaitPromise: false, resultOwnership: 'root' }); return send('input.setFiles', { context: c, element: { sharedId: h.result.sharedId }, files }); },
    async waitFor(c, expression, { timeout = 10000, every = 200 } = {}) { const t0 = Date.now(); for (;;) { let v; try { v = await api.evalIn(c, expression); } catch (_) { v = null; } if (v) return v; if (Date.now() - t0 > timeout) throw new Error('waitFor timeout: ' + expression); await sleep(every); } },
    consoleLog(levels) { return events.filter((e) => e.method === 'log.entryAdded' && (!levels || levels.includes(e.params.level))).map((e) => `[${e.params.level}] ${e.params.text}`); },
    async close() { try { ws.close(); } catch (_) { /* closing */ } try { m.sock.destroy(); } catch (_) { /* closing */ } proc.kill('SIGTERM'); await sleep(800); try { proc.kill('SIGKILL'); } catch (_) { /* gone */ } }
  };
  // Accept prompts/confirms automatically; `api.promptText` supplies the prompt() answer.
  api.promptText = 'e2e';
  api.onEvent((e) => { if (e.method === 'browsingContext.userPromptOpened') { const p = e.params; send('browsingContext.handleUserPrompt', { context: p.context, accept: true, ...(p.type === 'prompt' ? { userText: api.promptText } : {}) }).catch(() => {}); } });
  return api;
}

function deserialize(v) {
  if (!v || typeof v !== 'object') return v;
  switch (v.type) {
    case 'undefined': return undefined; case 'null': return null;
    case 'string': case 'boolean': return v.value;
    case 'number': return typeof v.value === 'string' ? Number(v.value.replace('-0', '0')) : v.value;
    case 'bigint': return BigInt(v.value);
    case 'array': return (v.value || []).map(deserialize);
    case 'object': return Object.fromEntries((v.value || []).map(([k, val]) => [typeof k === 'string' ? k : deserialize(k), deserialize(val)]));
    case 'map': return new Map((v.value || []).map(([k, val]) => [deserialize(k), deserialize(val)]));
    case 'set': return new Set((v.value || []).map(deserialize));
    case 'date': return new Date(v.value);
    case 'node': return { node: v.value && v.value.localName, id: v.sharedId };
    default: return v.value !== undefined ? v.value : `<${v.type}>`;
  }
}
