#!/usr/bin/env node
'use strict';
// Serve the built site and open it in headless Chromium to check that it really
// starts: a WebGL context is granted, the globe reports itself drawn, the stored
// observations play, and nothing throws.
//
//   node tools/check-webgl.cjs                 # dist/ (the JavaScript globe)
//   node tools/check-webgl.cjs --unity         # dist/unity/ (the Unity WebGL build)
//   node tools/check-webgl.cjs --dir some/path # any other built directory
//   node tools/check-webgl.cjs --shots         # also write PNGs to .check-shots/
//   node tools/check-webgl.cjs --desktop       # 1280x900 instead of an Android viewport
//
// No npm dependencies: Chromium is driven over the DevTools protocol with node's
// own WebSocket. Any Chromium will do — playwright's bundled one is used when it
// is present. Failures to reach the live observation API are reported but do not
// fail the run, because the check is about the built site, not the network: the
// site is expected to keep showing the stored observations when a fetch fails.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const png = require('./png.cjs');

// Chromium is driven with node's built-in WebSocket, which arrived in node 22.
if (typeof WebSocket === 'undefined') {
  console.error(`This needs node 22 or newer for its built-in WebSocket; this is ${process.version}.`);
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const flag = name => ARGS.includes(name);
const opt = name => {
  const i = ARGS.indexOf(name);
  return i >= 0 ? ARGS[i + 1] : undefined;
};

const UNITY = flag('--unity');
const SHOTS = flag('--shots');
const MOBILE = !flag('--desktop');
const DIR = path.resolve(ROOT, opt('--dir') || (UNITY ? 'dist/unity' : 'dist'));
// The Unity build reads the observations and the ground texture from beside it, at
// ../weather/ and ../assets/, exactly as it will on Pages under /MyAtras/unity/. So it
// is served the way Pages serves it: the whole site, opened at /unity/.
const SERVE_ROOT = UNITY && !opt('--dir') ? path.resolve(ROOT, 'dist') : DIR;
const PAGE_PATH = UNITY && !opt('--dir') ? '/unity/' : '/';
// Pages built by Unity's default template choose their phone layout from the user
// agent, not the viewport, so the emulated phone has to say it is one.
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const SHOT_DIR = path.resolve(ROOT, '.check-shots');
const PORT = Number(opt('--port') || 8123);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.symbols': 'application/octet-stream', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const failures = [];
const notes = [];
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// ---------------------------------------------------------------- static server

function serve(dir, port) {
  const missing = [];
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    let file = path.join(dir, rel || 'index.html');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      if (rel !== 'favicon.ico') missing.push('/' + rel);
      res.writeHead(404).end('not found');
      return;
    }
    // Unity writes .js.gz / .wasm.gz when compression is on. Serving them with the
    // encoding header lets the browser inflate them; builds with decompressionFallback
    // on also cope without it, which is what GitHub Pages relies on.
    const headers = { 'Content-Type': MIME[path.extname(file.replace(/\.gz$/, ''))] || 'application/octet-stream' };
    if (file.endsWith('.gz')) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, missing })));
}

// ---------------------------------------------------------------- chromium

function chromiumPath() {
  if (process.env.CHROMIUM && fs.existsSync(process.env.CHROMIUM)) return process.env.CHROMIUM;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
    path.join(os.homedir(), '.cache/ms-playwright')].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root).sort().reverse()) {
      const candidate = path.join(root, entry, 'chrome-linux', 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // Windows and macOS keep the browser in fixed places rather than on the PATH.
  const installed = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const candidate of installed) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* keep looking */ }
  }
  return null;
}

function launch(exe, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'check-webgl-'));
  const child = spawn(exe, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--hide-scrollbars',
    // Software rendering: containers have no GPU, and without these WebGL is refused.
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  return { child, profile };
}

// ---------------------------------------------------------------- devtools client

async function connect(port) {
  const deadline = Date.now() + 30000;
  let target;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* browser still starting */ }
    await sleep(250);
  }
  if (!target) throw new Error('chromium did not expose a page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result || {});
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const js = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  };

  return {
    send, js, events, close: () => ws.close(),
    async viewport(width, height, mobile) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
      if (mobile) {
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv8l' });
      }
    },
    async waitFor(expr, timeout, label) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try { if (await js(expr)) return true; } catch { /* page still loading */ }
        await sleep(200);
      }
      throw new Error(label || expr);
    },
    // Always decodes the frame, so the checks can look at what was drawn rather
    // than trusting that no exception means something appeared. Writes the file
    // too when --shots was asked for.
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const buffer = Buffer.from(r.data, 'base64');
      if (SHOTS) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), buffer);
      }
      return png.decode(buffer);
    },
    async drag(x0, y0, x1, y1) {
      const points = sep => [{ x: sep, y: y0, id: 1 }];
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(x0) });
      for (let i = 1; i <= 10; i++) {
        await send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: x0 + (x1 - x0) * i / 10, y: y0 + (y1 - y0) * i / 10, id: 1 }],
        });
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Console noise that says nothing about the built site: the live observation API is
// unreachable from most sandboxes, and the site is designed to keep the stored
// observations on screen when that happens.
const EXTERNAL = /realearth\.ssec\.wisc\.edu|net::ERR_(TUNNEL|NAME|INTERNET|PROXY|CONNECTION)/;
const IGNORED = /favicon\.ico/;

function consoleProblems(events) {
  const out = [];
  for (const e of events) {
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
      const text = `${e.params.entry.text} ${e.params.entry.url || ''}`.trim();
      if (IGNORED.test(text)) continue;
      (EXTERNAL.test(text) ? notes : out).push(text);
    }
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      out.push('uncaught: ' + (d.exception?.description || d.text));
    }
  }
  return out;
}

// ---------------------------------------------------------------- what was drawn

// The globe sits in the upper half of both layouts. Looking at a band of it is
// enough to tell a rendered sphere from a page that came up blank.
function globeRegion(image) {
  return png.region(image,
    Math.round(image.width * 0.15), Math.round(image.height * 0.25),
    Math.round(image.width * 0.85), Math.round(image.height * 0.55));
}

// A blank page is one flat colour; a drawn globe has hundreds. The threshold sits
// far from both, so this fails on a black frame and passes on a real render.
const DRAWN_COLOURS = 100;

// ---------------------------------------------------------------- the checks

// The first page load in a cold container can lose the race with the GPU process
// and be refused a context; a reload settles it.
async function loadWithWebGL(page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.send('Page.navigate', { url });
    await page.waitFor('!!document.querySelector("canvas")', 20000, 'no canvas on the page');
    if (UNITY) {
      // Asking the canvas for a context before Unity does would hand Unity ours, with
      // our attributes. Wait for the page to say the player exists, then ask: the
      // browser returns the context Unity made.
      try {
        await page.waitFor('!!window.myatrasUnity', 120000, 'the Unity player never started');
      } catch {
        return '';
      }
    } else {
      await sleep(1500);
    }
    const granted = await page.js(`(() => {
      const c = document.querySelector('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      return gl ? gl.getParameter(gl.VERSION) : '';
    })()`);
    if (granted) return granted;
    await sleep(1500);
  }
  return '';
}

async function checkJavaScriptGlobe(page) {
  await page.waitFor(
    "!/確認中|読み込み中|準備中/.test(document.getElementById('observationTime').textContent)",
    60000, 'the observation timestamp never resolved');
  // The overlay hides itself once the reference globe is on screen, so a visible
  // one means the globe never got that far.
  const status = await page.js(`(s => ({hidden: s.hidden, text: s.textContent.trim()}))
    (document.getElementById('status'))`);
  check(status.hidden, 'the globe started', status.hidden ? '' : `status: ${status.text}`);
  check(true, 'observation shown',
    await page.js("document.getElementById('observationTime').textContent.trim()"));

  const first = await page.shot('01-load');
  const drawn = globeRegion(first);
  check(drawn.colours >= DRAWN_COLOURS, 'the globe is drawn, not a blank frame',
    `${drawn.colours} colours, mean brightness ${drawn.mean.toFixed(1)}`);

  // The time-lapse runs on its own; watching the timestamp change proves the stored
  // observations are really being swapped rather than one frame being spun, and the
  // frames either side of the change prove the swap reached the screen.
  const startTime = await page.js("document.getElementById('observationTime').textContent.trim()");
  const seen = new Set([startTime]);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && seen.size < 3) {
    seen.add(await page.js("document.getElementById('observationTime').textContent.trim()"));
    await sleep(250);
  }
  check(seen.size >= 3, 'observations play back', `${seen.size} distinct times seen`);

  // Consecutive observations fade into one another. Sampled from inside the page, since
  // a dissolve lasts well under half a second and a screenshot takes longer than that.
  const fades = await page.js(`new Promise(resolve => {
    const samples = [], started = performance.now();
    (function sample() {
      samples.push(window.geoFade ? window.geoFade.progress : -1);
      if (performance.now() - started < 3000) setTimeout(sample, 40); else resolve(samples);
    })();
  })`);
  const blended = fades.filter(p => p > 0 && p < 1).length;
  check(blended > 0, 'consecutive observations dissolve',
    `${blended} of ${fades.length} samples caught mid-dissolve`);

  const later = await page.shot('02-later-observation');
  const moved = png.changed(first, later);
  check(moved >= 0.005, 'the picture changes with the observation',
    `${(moved * 100).toFixed(1)}% of pixels differ`);

  const before = await page.shot('03-before-drag');
  await page.drag(200, 420, 320, 470);
  await sleep(1500);
  const after = await page.shot('04-after-drag');
  const rotated = png.changed(before, after);
  check(rotated >= 0.02, 'a touch drag rotates the globe',
    `${(rotated * 100).toFixed(1)}% of pixels differ`);
}

async function checkUnityBuild(page) {
  check(await page.js("typeof createUnityInstance === 'function'"), 'unity loader present');

  // The page around the Unity canvas is the JavaScript site's page: the same status
  // overlay, timestamp and playback line, filled in from what the player reports.
  await page.waitFor("document.getElementById('status').hidden ||" +
    " /できません|読み込めません/.test(document.getElementById('status').textContent)",
    120000, 'the observations never finished loading');
  const status = await page.js(`(s => ({hidden: s.hidden, text: s.textContent.trim()}))
    (document.getElementById('status'))`);
  check(status.hidden, 'the globe started', status.hidden ? '' : `status: ${status.text}`);
  check(true, 'observation shown',
    await page.js("document.getElementById('observationTime').textContent.trim()"));
  check(true, 'playback line',
    await page.js("document.getElementById('weatherPlaybackStatus').textContent.trim()"));

  const first = await page.shot('unity-01-load');
  const drawn = globeRegion(first);
  check(drawn.colours >= DRAWN_COLOURS, 'the globe is drawn, not a blank frame',
    `${drawn.colours} colours, mean brightness ${drawn.mean.toFixed(1)}`);

  // Beside the globe the page's own dark background should show through the canvas,
  // as it does around the JavaScript globe. If Unity's end-of-frame alpha clear comes
  // back, the canvas turns opaque and the halo colour fills it (mean brightness ~130).
  const beside = png.region(first,
    Math.round(first.width * 0.05), Math.round(first.height * 0.36),
    Math.round(first.width * 0.09), Math.round(first.height * 0.40));
  check(beside.mean < 40, 'the page shows through around the globe',
    `mean brightness ${beside.mean.toFixed(1)} beside the globe`);

  const seen = new Set([await page.js("document.getElementById('observationTime').textContent.trim()")]);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && seen.size < 3) {
    seen.add(await page.js("document.getElementById('observationTime').textContent.trim()"));
    await sleep(250);
  }
  check(seen.size >= 3, 'observations play back', `${seen.size} distinct times seen`);

  const later = await page.shot('unity-02-later-observation');
  const moved = png.changed(first, later);
  check(moved >= 0.005, 'the picture changes with the observation',
    `${(moved * 100).toFixed(1)}% of pixels differ`);

  // The page's own button pauses the player, and the timestamp then holds.
  await page.js("document.getElementById('weatherPlay').click()");
  await sleep(800);
  const held = await page.js("document.getElementById('observationTime').textContent.trim()");
  await sleep(2000);
  const still = await page.js("document.getElementById('observationTime').textContent.trim()");
  const pausedLine = await page.js("document.getElementById('weatherPlaybackStatus').textContent.trim()");
  check(held === still && /一時停止/.test(pausedLine), 'the page pauses the player', pausedLine);

  // Paused, so the only thing a drag can change is the view.
  const paused = await page.shot('unity-03-paused');
  await page.drag(200, 420, 320, 470);
  await sleep(1500);
  const after = await page.shot('unity-04-after-drag');
  const rotated = png.changed(paused, after);
  check(rotated >= 0.02, 'a touch drag rotates the globe',
    `${(rotated * 100).toFixed(1)}% of pixels differ`);
}

// ---------------------------------------------------------------- main

async function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`${path.relative(ROOT, DIR)} does not exist.` +
      (UNITY ? ' Build the Unity WebGL target into it first — see unity/README.md.' : ''));
    process.exit(2);
  }
  const exe = chromiumPath();
  if (!exe) {
    console.error('No Chromium found. Set CHROMIUM=/path/to/chrome, or install one.');
    process.exit(2);
  }

  console.log(`serving   ${path.relative(ROOT, SERVE_ROOT)}, opening http://127.0.0.1:${PORT}${PAGE_PATH}`);
  console.log(`chromium  ${exe}`);
  const { server, missing } = await serve(SERVE_ROOT, PORT);
  const { child, profile } = launch(exe, PORT + 1);
  let page;
  try {
    page = await connect(PORT + 1);
    await page.viewport(MOBILE ? 412 : 1280, MOBILE ? 915 : 900, MOBILE);
    console.log(`viewport  ${MOBILE ? '412x915 (Android, touch)' : '1280x900 (desktop)'}\n`);

    const version = await loadWithWebGL(page, `http://127.0.0.1:${PORT}${PAGE_PATH}`);
    check(!!version, 'WebGL context granted', version);
    if (version) {
      if (UNITY) await checkUnityBuild(page);
      else await checkJavaScriptGlobe(page);
    }

    const problems = consoleProblems(page.events);
    check(problems.length === 0, 'no console errors from the site',
      problems.length ? problems[0] : '');
    for (const p of problems.slice(1)) console.log(`       ${p}`);
    check(missing.length === 0, 'every requested file was served',
      missing.length ? missing.slice(0, 3).join(' ') : '');
  } finally {
    if (page) page.close();
    server.close();
    // Chromium keeps writing to its profile until it is gone, so wait for the exit
    // before removing the directory, and never let the cleanup mask the result.
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* left in tmp */ }
  }

  if (notes.length) {
    console.log(`\n  ${notes.length} request(s) to the live observation API failed here;` +
      ' the site is expected to keep the stored observations on screen:');
    console.log(`       ${notes[0]}`);
  }
  if (SHOTS) console.log(`\nscreenshots in ${path.relative(ROOT, SHOT_DIR)}/`);
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch(err => {
  console.error('\ncheck-webgl failed:', err.message);
  process.exit(1);
});
