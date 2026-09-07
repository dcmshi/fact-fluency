/* Minimal headless-Chrome screenshot driver for visual checks — no npm deps
   (Node >= 22 built-in WebSocket talking CDP to Chrome's --remote-debugging-port).

   Usage:
     node scripts/screenshot.mjs <url> <outfile.png> [width=1440] [height=900] [sessionCookie]

   - width < 600 emulates a mobile viewport.
   - sessionCookie is the value of an `ff_session` cookie (see Application >
     Cookies in devtools, or grab it from a curl -c login), for shooting
     signed-in pages.
   - CHROME below is the standard Windows install path — adjust if yours differs. */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [url, out, w = '1440', h = '900', cookie] = process.argv.slice(2);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;

const chrome = execFile(CHROME, [
  '--headless',
  '--disable-gpu',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--window-size=${w},${h}`,
  'about:blank',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// wait for the debugger endpoint
let target;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch {
    // debugger endpoint not up yet — keep polling
  }
}
if (!target) {
  console.error('no CDP target');
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg.result);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));

await send('Page.enable');
await send('Network.enable');
if (cookie) {
  await send('Network.setCookie', {
    name: 'ff_session',
    value: cookie,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
  });
}
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(w),
  height: Number(h),
  deviceScaleFactor: 1,
  mobile: Number(w) < 600,
});
await send('Page.navigate', { url });
await sleep(4500); // let data load, fonts settle, entrance animations finish

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('wrote', out);
ws.close();
chrome.kill();
process.exit(0);
