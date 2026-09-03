// Synthetic test site served on 127.0.0.1 (the recorder only injects into http/https pages). No real data.
import http from 'node:http';
const PAGES = {
  '/': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Recorder Test Site</title>
<style>body{font-family:system-ui;margin:24px;max-width:720px}label{display:block;margin:10px 0}input,select,textarea{font:inherit;padding:6px}button{font:inherit;padding:8px 14px;margin:6px 6px 6px 0}</style></head>
<body><h1>Recorder Test Site</h1><p>Synthetic page for UI Recorder Pro end-to-end checks.</p>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitted'">
<label>Username <input id="user" name="username" autocomplete="off"></label>
<label>Password <input id="pw" name="password" type="password" autocomplete="off"></label>
<label>Plan <select id="plan" name="plan"><option>Free</option><option>Team</option></select></label>
<label><input id="agree" type="checkbox" name="agree"> I agree</label>
<button id="submit" type="submit" aria-label="Submit form">Submit</button>
<button id="secondary" type="button" data-testid="secondary-btn" onclick="document.getElementById('out').textContent='secondary clicked'">Secondary action</button>
<button id="tick" type="button" onclick="window.__n=(window.__n||0)+1;document.getElementById('out').textContent='tick '+window.__n">Tick</button>
</form><div id="out" aria-live="polite"></div>
<button id="nav" onclick="location.href='page2.html'">Go to page 2</button>
<iframe id="frame" src="frame.html" width="600" height="160" title="child frame"></iframe></body></html>`,
  '/page2.html': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page Two</title></head><body style="font-family:system-ui;margin:24px"><h1>Page Two</h1><button id="back" onclick="history.back()">Back</button></body></html>`,
  '/frame.html': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Child Frame</title></head><body style="font-family:system-ui;margin:12px"><label>Frame secret <input id="fsecret" type="password"></label><button id="fbtn" onclick="this.textContent='frame clicked'">Frame button</button></body></html>`,
};
export function startSite() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = PAGES[req.url.split('?')[0]];
      if (!body) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}
