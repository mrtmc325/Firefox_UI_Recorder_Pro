// GUI-level end-to-end check of the shipped extension in headless Firefox. Node stdlib only.
//   node docs/e2e/run.mjs            (FIREFOX_BIN=... to point at another Firefox; FF_VERBOSE=1 for browser logs)
// Records a session on a synthetic local site via the toggle-recording command, then drives the
// report editor (rename, tags, move+undo, templates, exports, raw-ZIP import, delete+undo) and
// checks that sensitive-field pixels are masked. Exit 1 on any failed check.
import fs from 'node:fs';
import { launch, EXT, sleep } from './ff.mjs';
import { startSite } from './site.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); } };
const site = await startSite();
const ff = await launch();
try {
  const page = ff.ctx; await ff.viewport(page, 1100, 800); await ff.goto(page, site.url);
  const pop = await ff.openExt(`${EXT}/popup.html`); await ff.viewport(pop, 420, 1200); await sleep(600);
  // Host permission must come from a user gesture; the popup opened as a tab cannot start a recording
  // (START_RECORDING is popup-only by design), so grant here and start through the keyboard command.
  // This harness exercises masking and features, not licensing: seed an active license so the free-tier
  // screenshot cap (verified separately in license.mjs) does not clamp the stop screenshot here.
  try {
    await ff.evalIn(pop, `browser.storage.local.set({ __uiRecorderInstallId: "e2e00000-0000-4000-8000-000000000000", __uiRecorderLicense: { status: "active", email: "e2e@example.test", activationId: "${"a".repeat(64)}", activatedAt: Date.now(), lastValidatedAt: Date.now(), lastCheckAt: Date.now(), failures: 0, lastError: "" } })`);
    await ff.evalIn(pop, `browser.runtime.getBackgroundPage().then(bg => bg.loadLicenseState()).then(() => true)`);
  } catch (e) { console.log("  note: license seed skipped (" + e.message + ")"); }
  await ff.grantHostPermissions();
  check('host permissions granted (Marionette)', /granted/.test(await ff.grantHostPermissions()));
  const pwRect = await ff.evalIn(page, `(() => { const r = document.getElementById('pw').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio, viewportWidth: window.innerWidth }; })()`);
  await ff.selectTabByUrlPrefix(site.url);
  check('toggle-recording command fired', (await ff.fireCommand('toggle-recording')).ok === true);
  await sleep(1500);
  const state = () => ff.evalIn(pop, `browser.runtime.sendMessage({ type: 'GET_STATE' }).then(s => ({ isRecording: s.isRecording, count: s.count }))`);
  check('recording started via command', (await state()).isRecording === true);
  await ff.type(page, '#user', 'alice'); await sleep(200);
  await ff.type(page, '#pw', 'hunter2'); await sleep(200);
  await ff.click(page, '#agree'); await sleep(200);
  await ff.click(page, '#secondary'); await sleep(300);
  await ff.click(page, '#submit'); await sleep(400);
  const kids = await ff.children(page);
  let frameFieldRect = null;
  if (kids[0]) {
    const outer = await ff.evalIn(page, `(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
    const inner = await ff.evalIn(kids[0].context, `(() => { const r = document.getElementById('fsecret').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    frameFieldRect = { x: outer.x + inner.x, y: outer.y + inner.y, w: inner.w, h: inner.h };
    await sleep(900); // let the child frame's rect report reach the top frame
    await ff.type(kids[0].context, '#fsecret', 'framepw'); await sleep(200); await ff.click(kids[0].context, '#fbtn'); await sleep(300);
  }
  await ff.click(page, '#nav'); await sleep(1200); await ff.click(page, '#back'); await sleep(1200);
  check('events captured while recording', (await state()).count >= 8);
  // Positions at stop time (the page may have scrolled during the run) for the stop-screenshot checks.
  const stopRects = await ff.evalIn(page, `(() => { const pw = document.getElementById('pw').getBoundingClientRect(); const fr = document.getElementById('frame').getBoundingClientRect(); return { pw: { x: pw.x, y: pw.y, w: pw.width, h: pw.height }, frame: { x: fr.x, y: fr.y }, viewportWidth: window.innerWidth }; })()`);
  if (frameFieldRect) { const kidsNow = await ff.children(page); const inner = await ff.evalIn(kidsNow[0].context, `(() => { const r = document.getElementById('fsecret').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`); frameFieldRect = { x: stopRects.frame.x + inner.x, y: stopRects.frame.y + inner.y, w: inner.w, h: inner.h }; }
  // Stop the way a user does: site tab in front, keyboard command (a click inside the popup *tab* would
  // select that tab and make the stop screenshot target an extension page).
  await ff.selectTabByUrlPrefix(site.url);
  check('toggle-recording command fired for stop', (await ff.fireCommand('toggle-recording')).ok === true);
  await ff.waitFor(pop, `browser.runtime.sendMessage({ type: 'GET_STATE' }).then(s => (!s.isRecording && (!s.stopFinalization || !s.stopFinalization.active)) ? 'done' : '')`, { timeout: 30000 });
  await sleep(1500);
  const reportsNow = await ff.storedReports(pop);
  const events = reportsNow[0] ? reportsNow[0].events : [];
  check('report persisted after stop', reportsNow.length === 1 && events.length >= 8, `reports=${reportsNow.length} events=${events.length}`);
  check('iframe events captured', events.some(e => /frame/i.test(String(e.human || e.label || ''))));
  check('events captured on the navigated-to page (content script re-injected)', events.some(e => /page2\.html/.test(String(e.url || ''))), events.map(e => e.url).filter((u, i, a) => a.indexOf(u) === i).join(' | '));
  check('recorded urls carry no secret query params', events.every(e => !/token=|password=/i.test(String(e.url || '')) || /REDACTED/.test(String(e.url))));
  check('lifecycle screenshots present', events.filter(e => e.type === 'outcome' && e.screenshot).length >= 1);

  const rep = await ff.openExt(`${EXT}/report.html`); await ff.viewport(rep, 1280, 1000); await sleep(2500);
  // Every control lives inside collapsed <details>; open them all and use a tall viewport so pointer
  // targets on the long page are always inside the emulated viewport.
  const openAll = async () => { await ff.evalIn(rep, `document.querySelectorAll('details').forEach(d => d.open = true); true`); await sleep(300); await ff.viewport(rep, 1280, 9000); };
  await openAll();
  check('report page renders the recorded steps', (await ff.evalIn(rep, `document.querySelectorAll('#steps [id^=step-]').length`)) >= 8);
  const mask = await ff.evalIn(rep, `(async () => { const s = await browser.storage.local.get(['reports']); const ev = s.reports[0].events.find(e => e.screenshot && Array.isArray(e.redactRects) && e.redactRects.length && e.human === 'Password'); if (!ev) return null; const rect = ${JSON.stringify(pwRect)}; const img = new Image(); img.src = ev.screenshot; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const scale = img.naturalWidth / rect.viewportWidth; const px = (x, y) => Array.from(ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data).slice(0, 3); return { scale, size: [img.naturalWidth, img.naturalHeight], field: px(rect.x + rect.w / 2, rect.y + rect.h / 2), corner: px(4, 4) }; })()`);
  check('password field pixels masked black at HiDPI scale, page corner untouched', !!mask && mask.scale > 1.2 && mask.field.every(v => v === 0) && mask.corner.every(v => v > 200), JSON.stringify(mask));
  const stopShot = await ff.evalIn(rep, `(async () => { const s = await browser.storage.local.get(['reports']); const ev = s.reports[0].events.find(e => e.type === 'outcome' && e.outcome === 'stop'); if (!ev || !ev.screenshot) return { missing: true, skip: ev ? ev.screenshotSkipReason : 'no stop event' }; const rect = ${JSON.stringify({ ...stopRects.pw, viewportWidth: stopRects.viewportWidth })}; const img = new Image(); img.src = ev.screenshot; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const scale = img.naturalWidth / rect.viewportWidth; return Array.from(ctx.getImageData(Math.round((rect.x + rect.w / 2) * scale), Math.round((rect.y + rect.h / 2) * scale), 1, 1).data).slice(0, 3); })()`);
  check('stop lifecycle screenshot masks the password field too', Array.isArray(stopShot) && stopShot.every(v => v === 0), JSON.stringify(stopShot));
  if (frameFieldRect) {
    const frameShot = await ff.evalIn(rep, `(async () => { const s = await browser.storage.local.get(['reports']); const ev = s.reports[0].events.find(e => e.type === 'outcome' && e.outcome === 'stop'); if (!ev || !ev.screenshot) return { missing: true, skip: ev ? ev.screenshotSkipReason : 'no stop event' }; if (!ev) return null; const rect = ${JSON.stringify({ ...frameFieldRect, viewportWidth: stopRects.viewportWidth })}; const img = new Image(); img.src = ev.screenshot; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const scale = img.naturalWidth / rect.viewportWidth; return Array.from(ctx.getImageData(Math.round((rect.x + rect.w / 2) * scale), Math.round((rect.y + rect.h / 2) * scale), 1, 1).data).slice(0, 3); })()`);
    check('iframe password field masked in the stop screenshot (parent-translated child rects)', Array.isArray(frameShot) && frameShot.every(v => v === 0), JSON.stringify(frameShot));
  }
  ff.promptText = 'E2E Renamed';
  await ff.click(rep, '#report-rename'); await sleep(1500); await openAll();
  check('rename persists to the report list', /E2E Renamed/.test(await ff.evalIn(rep, `document.querySelector('#report-select option:checked').textContent`)));
  await ff.evalIn(rep, `(() => { const inp = document.querySelector('#steps input.step-tag-input'); if (inp) inp.id = 'e2e-tag'; return !!inp; })()`);
  await ff.type(rep, '#e2e-tag', 'smoke'); await sleep(200);
  // Commit by moving focus off the input (native blur), which is what the input's commit handler listens for.
  await ff.evalIn(rep, `document.getElementById('e2e-tag').blur()`);
  await ff.click(rep, '#report-select'); await sleep(1500);
  check('tag saved and filter chip rendered', (await ff.evalIn(rep, `[...document.querySelectorAll('#tag-filter-chips button')].map(c => c.textContent.trim())`)).includes('smoke'));
  const order = () => ff.evalIn(rep, `browser.storage.local.get(['reports']).then(s => s.reports[0].events.slice(0, 2).map(e => e.type))`);
  const before = await order();
  await ff.clickWhere(rep, `[...document.querySelectorAll('#steps button')].find(x => x.textContent.trim() === 'Move down' && !x.disabled)`, 'e2e-move'); await sleep(1200);
  const moved = await order();
  await ff.clickWhere(rep, `document.querySelector('#step-undo-bar button')`, 'e2e-undo'); await sleep(1200);
  check('move down then undo restores order', moved[0] === before[1] && JSON.stringify(await order()) === JSON.stringify(before));
  await ff.type(rep, '#report-template-name', 'E2E Template'); await ff.click(rep, '#report-template-save'); await sleep(800);
  await ff.click(rep, '#report-template-load'); await sleep(1500);
  check('template save + load merges section shells', /sections added/.test(await ff.evalIn(rep, `document.getElementById('report-template-status').textContent`)));
  await ff.click(rep, '#report-template-delete'); await sleep(600);
  check('template delete', /deleted/i.test(await ff.evalIn(rep, `document.getElementById('report-template-status').textContent`)));
  // exports: bypass the save-as picker (no file dialog in headless Firefox)
  await ff.evalIn(rep, `(() => { const orig = browser.downloads.download.bind(browser.downloads); Object.defineProperty(browser.downloads, 'download', { value: (o) => orig({ ...o, saveAs: false }), configurable: true, writable: true }); return true; })()`);
  const status = () => ff.evalIn(rep, `document.getElementById('import-status').textContent`);
  const waitIdle = () => ff.waitFor(rep, `(() => { const s = document.getElementById('import-status').textContent; return /Building|Exporting|Preparing/i.test(s) ? '' : (s || ' '); })()`, { timeout: 30000, every: 1000 });
  for (const [sel, mode] of [['#bundle'], ['#bundle-raw'], ['#bundle-markdown', 'zip'], ['#bundle-markdown', 'inline'], ['#bundle-playwright'], ['#bundle-media']]) { if (mode) await ff.setSelect(rep, '#bundle-markdown-mode', mode); await ff.click(rep, sel); await sleep(1200); await waitIdle(); }
  await sleep(2500);
  const files = fs.readdirSync(ff.downloads).filter(f => !f.endsWith('.part'));
  check('six export artifacts downloaded', files.length === 6, files.join(', '));
  const md = files.find(f => f.endsWith('.md'));
  check('markdown export embeds screenshots', !!md && /!\[Screenshot for step/.test(fs.readFileSync(`${ff.downloads}/${md}`, 'utf8')));
  const html = files.find(f => f.startsWith('ui-report-') && f.endsWith('.html'));
  if (html) {
    const exportTab = await ff.send('browsingContext.create', { type: 'tab' });
    const errorsBefore = ff.consoleLog(['error']).length;
    await ff.goto(exportTab.context, `file://${ff.downloads}/${html}`); await sleep(2500);
    const rendered = await ff.evalIn(exportTab.context, `({ slides: document.querySelectorAll('[id^="step-"]').length, title: document.title })`).catch(e => ({ error: e.message }));
    check('exported HTML opens and renders steps with no console errors', rendered.slides > 0 && ff.consoleLog(['error']).length === errorsBefore, JSON.stringify(rendered));
  }
  const zip = files.find(f => f.startsWith('ui-report-raw-'));
  const eventsBefore = await ff.evalIn(rep, `browser.storage.local.get(['reports']).then(s => s.reports[0].events.length)`);
  await ff.setSelect(rep, '#import-mode', 'merge'); await ff.setFiles(rep, '#bundle-import-file', [`${ff.downloads}/${zip}`]); await sleep(4000);
  check('raw ZIP round-trip merge', (await ff.evalIn(rep, `browser.storage.local.get(['reports']).then(s => s.reports[0].events.length)`)) === eventsBefore * 2, await status());
  await openAll();
  await ff.click(rep, '#report-delete'); await sleep(3000); await openAll();
  check('delete removes the report from storage', (await ff.evalIn(rep, `browser.storage.local.get(['reports']).then(s => (s.reports || []).length)`)) === 0);
  await ff.clickWhere(rep, `document.querySelector('#report-undo-bar button')`, 'e2e-undo-del'); await sleep(3000);
  check('undo delete restores exactly one report', (await ff.evalIn(rep, `browser.storage.local.get(['reports']).then(s => (s.reports || []).length)`)) === 1);
  const errors = ff.consoleLog(['error']).filter(l => !/Content-Security-Policy|moz-nullprincipal/.test(l));
  check('no unexpected console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL  harness error — ' + e.message); if (process.env.FF_VERBOSE) console.log(ff.logs.slice(-10).join(''));
} finally {
  await ff.close(); site.close();
}
console.log(`\n================  E2E RESULT: ${pass} passed, ${fail} failed  (artifacts: ${ff.workDir})  ================`);
process.exit(fail ? 1 : 0);
