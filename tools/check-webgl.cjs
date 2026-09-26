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
//   node tools/check-webgl.cjs --unity --url https://ryo-tanohata.github.io/MyAtras/unity/
//                                              # the published site itself, as a phone gets it
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
// A published page is opened where it lives, with nothing served locally, so what is
// checked is exactly what the host sends - its headers included.
const LIVE_URL = opt('--url');

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

// The strip beside the globe: the page's own background shows past a whole globe and
// nothing shows past the close view. Counted as distinct colours rather than brightness,
// because the view it lands on can be night ocean.
function besideStrip(image) {
  return png.region(image,
    Math.round(image.width * 0.05), Math.round(image.height * 0.30),
    Math.round(image.width * 0.11), Math.round(image.height * 0.45));
}

/// The first moment of the flight: waits for it to be running rather than for the
/// observations, which now take longer to arrive than the flight takes to land.
async function openingShot(page) {
  const deadline = Date.now() + 15000;
  let flying = false;
  while (Date.now() < deadline) {
    flying = await page.js("!!(window.geoIntro && window.geoIntro.running)").catch(() => false);
    if (flying) break;
    await sleep(200);
  }
  return { image: await page.shot('00-opening'), flying, note: flying ? '' : 'never saw it running' };
}

// -------------------------------------------------- which storm the camera can see

// The marks are drawn where the globe is looking, and it opens on Japan. With 71
// observations of the whole world, the newest detection is as likely to be in the
// eastern Pacific, whose marks never reach the screen - so the checks sit on the storm
// that ends nearest the middle of the opening view, and say which one they took. Read
// here rather than asked of the page, because the Unity build keeps its track to itself.
const HOME_VIEW = { lat: 35.5, lon: 136 };

function degreesApart(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const cosine = Math.sin(aLat * rad) * Math.sin(bLat * rad)
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.cos((aLon - bLon) * rad);
  return Math.acos(Math.min(1, Math.max(-1, cosine))) / rad;
}

/// The observation indices to sit on: the storm's last detection, where the outlook may
/// appear, and one from the middle of it, where the ring and its trail must. null when
/// nothing is bundled.
function stormTarget() {
  let file;
  try {
    file = JSON.parse(fs.readFileSync(path.join(SERVE_ROOT, 'data', 'storms.json'), 'utf8'));
  } catch {
    return null;
  }
  const times = JSON.parse(fs.readFileSync(
    path.join(SERVE_ROOT, 'weather', 'sequence', 'manifest.json'), 'utf8')).globalir.map(f => f.time);
  let best = null;
  for (const storm of file.storms || []) {
    const end = storm.points[storm.points.length - 1];
    const last = times.indexOf(end.time);
    const middle = storm.points[Math.floor((storm.points.length - 1) / 2)];
    const mid = times.indexOf(middle.time);
    if (last < 0 || mid < 0) continue;
    const away = degreesApart(end.lat, end.lon, HOME_VIEW.lat, HOME_VIEW.lon);
    if (!best || away < best.away) {
      best = { away, last, mid, hours: storm.points.length, end };
    }
  }
  return best;
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
  // The opening flight is measured at the opening: it lasts eleven seconds, and waiting
  // for the observations first would arrive after it had landed - which is what happened
  // once the bundled sequence grew to 71 frames.
  const opening = await openingShot(page);

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

  const wide = besideStrip(opening.image);
  check(opening.flying, 'the globe opens on a flight rather than where it lands',
    opening.note);
  // Every later check wants the view it settles on, and a moving camera would
  // contaminate the pixel comparisons, so the rest of the flight is skipped here.
  await page.js("window.geoIntro && window.geoIntro.skip()");
  await sleep(500);

  const first = await page.shot('01-load');
  const arrived = besideStrip(first);
  check(wide.colours < 30 && arrived.colours > 60,
    'it starts on the whole globe and ends with the close view filling the frame',
    `${wide.colours} colours beside the globe at the start, ${arrived.colours} at the end`);

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

  // The storm found in the bundled observations, drawn where it was measured. Sought to
  // an observation the storm was actually found in: three of these seventy-two have no
  // detection, and landing on one of those would fail a working globe. Counted by its own
  // amber rather than by pixels changing, so a stray repaint cannot pass for the mark.
  const target = stormTarget();
  const sought = !target ? 'no bundled storm has an observation to sit on' : await page.js(`(() => {
    const t = window.geoStorms;
    if (!t || !t.loaded) return 'no storms loaded';
    const slider = document.getElementById('weatherTime');
    slider.value = '${target.mid}';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  check(sought === 'ok', 'an observation with a storm can be shown',
    target ? `${target.hours} hours of it, ending ${target.away.toFixed(0)}\u00b0 from the middle of the view`
      : sought);
  await sleep(1800);

  const toggle = on => page.js(`(() => { const box = document.getElementById('showStorms');
    box.checked = ${on}; box.dispatchEvent(new Event('change')); return box.checked; })()`);
  await toggle(false);
  await sleep(500);
  const unmarked = await page.shot('05-without-the-storm');
  await toggle(true);
  await sleep(700);
  const marked = await page.shot('06-with-the-storm');
  const amber = image => {
    let n = 0;
    for (let i = 0; i < image.data.length; i += image.channels) {
      const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
      if (r > 190 && g > 110 && g < 205 && b < 120 && r - b > 90) n++;
    }
    return n;
  };
  const wasAmber = amber(unmarked), nowAmber = amber(marked);
  check(nowAmber > wasAmber + 40, 'the storm mark is drawn',
    `${nowAmber} amber pixels with it, ${wasAmber} without`);

  const line = await page.js("(document.getElementById('stormStatus') || {}).textContent || ''");
  check(/推定中心/.test(line) && /予報でもありません/.test(line),
    'the mark says what it is', line.slice(0, 80));

  // Nothing is drawn for a time with no observation, and nothing is carried past the last
  // one: a time the storm was not found in leaves the globe unmarked rather than guessing.
  const honest = await page.js(`(() => {
    const t = window.geoStorms;
    if (!t) return 'no track';
    const points = t.storms.flatMap(s => s.points.length);
    return t.at('20991231.235959').length === 0 && points.length > 0
      ? 'ok' : 'a time with no observation was marked';
  })()`);
  check(honest === 'ok', 'no mark for a time the storm was not found in', honest);

  // What storms have typically done next, drawn only once the observations run out. Sought
  // to that storm's own last observation, which is the only place it may appear.
  const toLast = !target ? 'no bundled storm has a last observation' : await page.js(`(() => {
    const slider = document.getElementById('weatherTime');
    slider.value = '${target.last}';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  check(toLast === 'ok', "the storm's last observation can be shown", toLast);
  await sleep(1800);
  const beforeOutlook = await page.shot('07-before-the-outlook');
  await page.js(`(() => { const box = document.getElementById('showOutlook');
    box.checked = true; box.dispatchEvent(new Event('change')); })()`);
  await sleep(2500);
  const withOutlook = await page.shot('08-with-the-outlook');
  const violet = image => {
    let n = 0;
    for (let i = 0; i < image.data.length; i += image.channels) {
      const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
      if (b > 140 && b - g > 25 && r > g && b > r && r < 230) n++;
    }
    return n;
  };
  const wasViolet = violet(beforeOutlook), nowViolet = violet(withOutlook);
  check(nowViolet > wasViolet + 30, 'the outlook is drawn ahead of the last observation',
    `${nowViolet} violet pixels with it, ${wasViolet} without`);

  const said = await page.js("(document.getElementById('stormStatus') || {}).textContent || ''");
  check(/予報ではありません/.test(said) && /過去/.test(said),
    'the outlook says it is not a forecast', said.slice(-52));

  // And nowhere else. An hour the globe has an observation for must not be overdrawn with
  // a guess about it. Asked of one and the same observation with the outlook switched on
  // and then off: two different hours differ by a few dozen scene pixels this violet test
  // catches, which says nothing about whether a fan was drawn.
  const onlyAtTheEnd = await page.js(`(() => {
    const w = window.geoWeather, t = window.geoStorms;
    const product = document.getElementById('weatherProduct').value;
    const times = (w.times && w.times[product]) || [];
    const i = times.findIndex(x => t.at(x && x.time ? x.time : x).some(f => !f.last));
    if (i < 0) return 'no mid-track observation to try';
    const slider = document.getElementById('weatherTime');
    slider.value = String(i); slider.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(1800);
  const midTrack = await page.shot('09-outlook-mid-track');
  await page.js(`(() => { const box = document.getElementById('showOutlook');
    box.checked = false; box.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  const midTrackPlain = await page.shot('10-mid-track-without-it');
  check(onlyAtTheEnd === 'ok' && violet(midTrack) <= violet(midTrackPlain) + 30,
    'no outlook over an observation the globe already has',
    `${violet(midTrack)} violet pixels mid-track with it on, ${violet(midTrackPlain)} with it off`);
  await sleep(400);

  await checkCloseUp(page);
  await checkSimulation(page);

  const before = await page.shot('03-before-drag');
  await page.drag(200, 420, 320, 470);
  await sleep(1500);
  const after = await page.shot('04-after-drag');
  const rotated = png.changed(before, after);
  check(rotated >= 0.02, 'a touch drag rotates the globe',
    `${(rotated * 100).toFixed(1)}% of pixels differ`);

}

/// The last thirteen bundled observations over Japan, as the globe draws their cloud, on
/// the simulation's 1024 x 512 grid: what the simulation's hours are held to.
function observedGrain() {
  const dir = path.join(SERVE_ROOT, 'weather', 'sequence');
  const frames = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).globalir.slice(-13);
  const W = 1024, H = 512, x0 = Math.round(300 / 360 * W), x1 = Math.round(330 / 360 * W), y0 = Math.round(110 / 180 * H), y1 = Math.round(135 / 180 * H);
  const ss = x => { const t = Math.min(1, Math.max(0, (x - 0.38) / 0.44)); return t * t * (3 - 2 * t); };
  return frames.map(f => {
    const im = png.decode(fs.readFileSync(path.join(dir, f.file)));
    return Array.from({ length: y1 - y0 }, (_, j) => {
      const lat = (y0 + j + 0.5) / H * 180 - 90, my = 0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI);
      return Array.from({ length: x1 - x0 }, (_, i) => {
        const px = Math.min(im.width - 1, Math.floor((x0 + i + 0.5) / W * im.width)), py = Math.min(im.height - 1, Math.floor(my * im.height));
        const k = (py * im.width + px) * im.channels;
        return ss((0.299 * im.data[k] + 0.587 * im.data[k + 1] + 0.114 * im.data[k + 2]) / 255) * (im.channels === 4 ? im.data[k + 3] / 255 : 1);
      });
    });
  });
}

/// How much a sequence of cloud grids changes from one to the next, and how much fine
/// detail each holds (its difference from its own 3 x 3 average), both on average.
function grainOf(grids) {
  let change = 0, n = 0, detail = 0, m = 0;
  for (let g = 0; g < grids.length; g++) {
    const a = grids[g];
    for (let y = 1; y < a.length - 1; y++) for (let x = 1; x < a[0].length - 1; x++) {
      let box = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) box += a[y + dy][x + dx];
      detail += Math.abs(a[y][x] - box / 9); m++;
      if (g) { change += Math.abs(a[y][x] - grids[g - 1][y][x]); n++; }
    }
  }
  return { change: change / Math.max(1, n), detail: detail / Math.max(1, m) };
}

/// After the last observation, the storms found in it carried on to their end by the typhoon
/// object, the clouds with them - and then back to the observations. Run at the fastest
/// playback so the whole scene, some four simulated days, passes in under a minute.
async function checkSimulation(page) {
  const offered = await page.js("!document.getElementById('simulateToggle').hidden");
  // The standalone export carries no typhoon model, so it must not offer one.
  if (await page.js('!!window.GEO_STANDALONE')) {
    check(!offered, 'the standalone page does not offer the simulation');
    return;
  }
  check(offered && await page.js("document.getElementById('simulateStorms').checked"), 'the simulation switch is offered, and on');
  if (!offered) return;
  const speed = await page.js("document.getElementById('weatherPlaybackSpeed').value");
  await page.js(`(() => {
    const box = document.getElementById('simulateStorms');
    box.checked = true; box.dispatchEvent(new Event('change'));
  })()`);
  const loaded = await page.waitFor("/最後の観測のあとも/.test(document.getElementById('simulateNote').textContent)", 20000)
    .then(() => true, () => false);
  check(loaded, 'the simulation data loads', await page.js("document.getElementById('simulateNote').textContent"));
  const lastShown = await page.js(`(() => {
    const p = window.geoPlayback, s = document.getElementById('weatherPlaybackSpeed');
    s.value = '9'; s.dispatchEvent(new Event('change'));
    if (!p.playing) document.getElementById('weatherPlay').click();
    p.index = p.frames.length - 1;
    return p.frames[p.frames.length - 1];
  })()`);
  const started = await page.waitFor('window.geoStormSim.active', 30000).then(() => true, () => false);
  const tracks = started ? await page.js(`JSON.stringify(window.geoStormSim.tracks.map(t =>
    [+t.from.lat.toFixed(1), +t.from.lon.toFixed(1), t.end.t + 'h']))`) : '';
  check(started, 'the simulation starts after the last observation', `from ${lastShown}: ${tracks}`);
  if (!started) return;
  // Where the Japan Meteorological Agency has a forecast covering this hour, the storm
  // follows it: through the agency's forecast centre at each forecast hour, from the first
  // one twelve hours or more on (before that it is still easing over from where the
  // observations saw it, which can be a hundred kilometres away). With no such forecast
  // (none published, or the observations too old for it) there is nothing to hold it to.
  const jma = JSON.parse(await page.js(`(async () => {
    const data = await window.GeoData.jmaTyphoon(), sim = window.geoStormSim;
    const start = Date.parse(${JSON.stringify(lastShown)}.replace(/^(\\d{4})(\\d\\d)(\\d\\d)\\.(\\d\\d)(\\d\\d)(\\d\\d)$/, '$1-$2-$3T$4:$5:$6Z'));
    const covering = ((data && data.storms) || []).filter(f => Typhoon.followForecast(f, start));
    const followed = sim.tracks.filter(t => t.from.jma);
    const off = covering.map(f => {
      const a = f.points.find(p => Date.parse(p.time) - start >= 12 * 3600000), h = a ? Math.round((Date.parse(a.time) - start) / 3600000) : -1;
      const t = followed.find(t => t.from.jma.issued === f.issued);
      return t && h >= 0 && t.points[h] ? Math.round(Typhoon.distanceKm(t.points[h], a)) : null;
    });
    return JSON.stringify({ covering: covering.length, followed: followed.length, off,
      note: document.getElementById('simulateNote').textContent.slice(0, 60) });
  })()`));
  check(jma.followed === jma.covering && jma.off.every(d => d !== null && d <= 5) && (!jma.covering || /気象庁の予報/.test(jma.note)),
    jma.covering ? "the storms follow the agency's forecast" : 'no agency forecast covers these observations', JSON.stringify(jma));
  // A typhoon still blowing when the forecast stops is not left to stop dead there and
  // fade: it goes on north-east (south-east in the south), weakening to nothing.
  const past = JSON.parse(await page.js(`JSON.stringify(window.geoStormSim.tracks.filter(t => t.from.jma).map(t => {
    const f = t.points[t.forecastHours], e = t.points[t.points.length - 1], pole = f.lat >= 0 ? 1 : -1;
    return { typhoon: f.kt >= 34,
      hours: t.points.length - 1 - t.forecastHours, poleward: +((e.lat - f.lat) * pole).toFixed(1),
      east: +(((e.lon - f.lon + 540) % 360) - 180).toFixed(1), kt: [Math.round(f.kt), Math.round(e.kt)] };
  }))`));
  check(past.every(p => !p.typhoon || (p.hours === 36 && p.poleward > 0 && p.east > 0 && p.kt[1] === 0)),
    past.length ? 'past the forecast a typhoon goes on north-east and dies' : 'no forecast to go on from', JSON.stringify(past));
  const lastObservation = await page.shot('11-simulation-start');
  await page.waitFor('window.geoStormSim.hours >= 24 || !window.geoStormSim.active', 30000).catch(() => {});
  const label = await page.js("document.getElementById('observationTime').textContent");
  check(/シミュレーション/.test(label) && /観測から/.test(label), 'the time says it is a simulation', label);
  const status = await page.js("document.getElementById('weatherPlaybackStatus').textContent");
  check(/予報ではありません/.test(status), 'the simulation says it is not a forecast', status);
  const day = await page.shot('12-simulation-a-day-on');
  const moved = png.changed(lastObservation, day);
  check(moved >= 0.02, 'the simulated clouds move', `${(moved * 100).toFixed(1)}% of pixels differ after a day`);
  // Shown an hour at a time, like the observations it follows: within one simulated hour
  // the clouds on screen do not change, and each new hour dissolves in.
  // Watched at the slowest speed, an hour lasting two thirds of a second, so that each
  // hour is seen several times over.
  const steps = JSON.parse(await page.js(`new Promise(resolve => {
    const sim = window.geoStormSim, out = [], t0 = performance.now(), sel = document.getElementById('weatherPlaybackSpeed');
    const was = sel.value; sel.value = '1.5'; sel.dispatchEvent(new Event('change'));
    const probe = () => sim.sample(35, 135, 3).mean + '|' + sim.sample(25, 127, 3).mean;
    (function tick() {
      out.push({ h: sim.shownHours, raw: sim.hours, f: window.geoSimFade(), px: probe() });
      if (performance.now() - t0 < 4000) setTimeout(tick, 30);
      else { sel.value = was; sel.dispatchEvent(new Event('change')); resolve(JSON.stringify(out)); }
    })();
  })`));
  const byHour = new Map();
  let changedWithin = 0, between = 0;
  for (const st of steps) {
    if (byHour.has(st.h) && byHour.get(st.h) !== st.px) changedWithin++;
    if (!byHour.has(st.h)) byHour.set(st.h, st.px);
    if (st.f > 0 && st.f < 1) between++;
  }
  check(changedWithin === 0 && byHour.size >= 2 && steps.length >= 2 * byHour.size && between > 0 && steps.every(st => Number.isInteger(st.h) && st.h <= st.raw + 1e-6),
    'the simulation steps an hour at a time, dissolving like the observations',
    `${byHour.size} hours shown over ${steps.length} samples, ${changedWithin} changes within an hour, ${between} caught mid-dissolve`);
  // And an hour of it changes about as much, in as fine a grain, as an hour of the
  // observations: cloud only carried hardly changes shape, which read as smooth where the
  // observations flicker, so the edges are made to come and go (storm-sim.js, RESOLVE).
  // Both measured the same way, over Japan on the simulation's grid.
  const grain = JSON.parse(await page.js(`new Promise(resolve => {
    const sim = window.geoStormSim, gl = sim.gl, W = 1024, H = 512, sel = document.getElementById('weatherPlaybackSpeed');
    const x0 = Math.round(300 / 360 * W), x1 = Math.round(330 / 360 * W), y0 = Math.round(110 / 180 * H), y1 = Math.round(135 / 180 * H), w = x1 - x0, h = y1 - y0;
    const was = sel.value; sel.value = '4.5'; sel.dispatchEvent(new Event('change'));
    const read = () => { const px = new Uint8Array(w * h * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, sim.display.fb);
      gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => px[(y * w + x) * 4] / 255)); };
    const grids = []; let last = sim.shownHours;
    (function tick() {
      if (sim.shownHours !== last) { grids.push(read()); last = sim.shownHours; }
      if (grids.length < 7 && !sim.finished) return setTimeout(tick, 10);
      sel.value = was; sel.dispatchEvent(new Event('change'));
      resolve(JSON.stringify(grids));
    })();
  })`));
  const sim = grainOf(grain), obs = grainOf(observedGrain());
  check(grain.length >= 5 && Math.abs(sim.change / obs.change - 1) < 0.4 && Math.abs(sim.detail / obs.detail - 1) < 0.4,
    'an hour of it changes as much, as finely, as an hour of the observations',
    `change an hour ${sim.change.toFixed(3)} against ${obs.change.toFixed(3)} observed, fine detail ${sim.detail.toFixed(3)} against ${obs.detail.toFixed(3)}`);
  // The observations wait while it runs: nothing else is swapped in underneath.
  const held = await page.js(`JSON.stringify({ index: window.geoPlayback.index,
    active: window.geoStormSim.active })`);
  check(held === '{"index":0,"active":true}', 'the observations wait while it runs', held);
  // Paused, it stays where it is, for as long as anyone likes to look.
  const paused = await page.js(`new Promise(resolve => {
    document.getElementById('weatherPlay').click();
    const at = window.geoStormSim.hours;
    setTimeout(() => {
      const still = window.geoStormSim.active && window.geoStormSim.hours === at;
      const line = document.getElementById('weatherPlaybackStatus').textContent;
      document.getElementById('weatherPlay').click();
      resolve(JSON.stringify({ still, line }));
    }, 1500);
  })`);
  check(/"still":true/.test(paused) && /一時停止/.test(paused), 'pausing holds the simulation where it is', paused);
  // The clouds ride a flow that started from the motion last measured and has moved on.
  const air = await page.js(`JSON.stringify({ measured: window.geoStormSim.air.measured,
    hours: window.geoStormSim.air.hours })`);
  check(/"measured":6/.test(air) && JSON.parse(air).hours >= 20, 'the background flow starts from the measured motion and moves on', air);
  // Only storms the agency forecasts are moved, so the marks are those.
  const marks = await page.js('window.geoStormSim.marks().filter(m => !m.ended).length');
  check(marks === jma.covering, 'the storms the agency forecasts are marked, and no others', `${marks} alive a day on, ${jma.covering} forecast`);
  // Played through to the end, it stops there - the last simulated hour stays on screen,
  // paused - and the play button offers the observations from the start. Going back days
  // on its own read as the weather jumping.
  // Past its forecast the page says the typhoon is dying the typical way, not forecast.
  const dying = past.some(p => p.typhoon) && await page.waitFor(`(() => { const t = window.geoStormSim.tracks.find(t => t.from.jma);
    return t && window.geoStormSim.shownHours >= t.forecastHours + 18; })()`, 90000).then(() => true, () => false);
  if (dying) {
    await page.shot('13-simulation-past-the-forecast');
    const note = await page.js("document.getElementById('simulateNote').textContent");
    check(/典型的な消え方で弱まっています/.test(note), 'the page says when a typhoon is past its forecast', note.slice(0, 80));
  }
  const finished = await page.waitFor('window.geoStormSim.finished', 90000).then(() => true, () => false);
  await sleep(1200);
  const atEnd = await page.js(`JSON.stringify({ active: window.geoStormSim.active, hours: Math.round(window.geoStormSim.hours),
    playing: window.geoPlayback.playing, button: document.getElementById('weatherPlay').textContent,
    line: document.getElementById('weatherPlaybackStatus').textContent })`);
  const hd = JSON.parse(atEnd);
  check(finished && hd.active && !hd.playing && /観測の最初から再生/.test(hd.button) && /シミュレーションの終わり/.test(hd.line),
    'at its end it stops and offers the observations from the start', atEnd);
  const still = await page.js('window.geoStormSim.hours');
  await sleep(800);
  check(await page.js('window.geoStormSim.hours') === still, 'and nothing moves on by itself');
  // Asked, it fades from the simulation to the first observation over seconds, saying so.
  await page.js("document.getElementById('weatherPlay').click()");
  await sleep(300);
  const returning = await page.js(`JSON.stringify({ shown: +window.geoSimShown().toFixed(2),
    line: document.getElementById('weatherPlaybackStatus').textContent })`);
  const r = JSON.parse(returning);
  check(r.shown > 0 && r.shown < 1 && /最初の観測へ戻っています/.test(r.line),
    'asked, it fades back to the first observation, saying so', returning);
  const ended = true;
  await sleep(1500);
  const back = await page.js(`JSON.stringify({ playing: window.geoPlayback.playing,
    time: document.getElementById('observationTime').textContent })`);
  check(ended && /"playing":true/.test(back) && !/シミュレーション/.test(back),
    'the observations play again after it', back);
  // With the simulation off, the loop still goes back slowly: the last observation fades
  // into the first over seconds, with the page saying where it is going. Waited for once
  // the return from the simulation has finished, whose words are the same.
  await page.waitFor("!/最初の観測へ戻っています/.test(document.getElementById('weatherPlaybackStatus').textContent)", 10000).catch(() => {});
  await page.js(`(() => {
    const box = document.getElementById('simulateStorms');
    box.checked = false; box.dispatchEvent(new Event('change'));
    const p = window.geoPlayback; p.index = p.frames.length - 1;
  })()`);
  const wrapped = await page.waitFor("/最初の観測へ戻っています/.test(document.getElementById('weatherPlaybackStatus').textContent)", 20000)
    .then(() => true, () => false);
  const fading = await page.js(`JSON.stringify({ length: window.geoFade.length, progress: +window.geoFade.progress.toFixed(2),
    sim: window.geoStormSim.active })`);
  const f = JSON.parse(fading);
  check(wrapped && f.length >= 3000 && f.progress < 1 && !f.sim, 'without it, the loop fades back rather than cutting', fading);
  await page.js(`(() => {
    const box = document.getElementById('simulateStorms');
    box.checked = true; box.dispatchEvent(new Event('change'));
    const s = document.getElementById('weatherPlaybackSpeed');
    s.value = ${JSON.stringify(speed)}; s.dispatchEvent(new Event('change'));
  })()`);
  await sleep(800);
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
  // Day and night opens off, so the globe is the evenly lit exhibit the JavaScript
  // version opens as. The page says so where the sun's position would go.
  const sunAtRest = await page.js("(e => e ? e.textContent.trim() : '')(document.getElementById('sunPoint'))");
  check(/オフ/.test(sunAtRest), 'day and night starts off', sunAtRest);

  // Switched on, the line is drawn from the sun at the observation's own time; the page
  // names the point where that sun is overhead. Switched back off afterwards, so the
  // rest of the run sees what a visitor sees.
  const sun = on => page.js(`(() => { const box = document.getElementById('sunlight');
    box.checked = ${on}; box.dispatchEvent(new Event('change')); return box.checked; })()`);
  await sun(true);
  await sleep(1200);
  const sunPoint = await page.js("(e => e ? e.textContent.trim() : '')(document.getElementById('sunPoint'))");
  check(/太陽直下点：[北南]緯\d+\.\d° [東西]経\d+\.\d°/.test(sunPoint), 'the sun position is shown', sunPoint);
  await sun(false);
  await sleep(600);

  const first = await page.shot('unity-01-load');
  const drawn = globeRegion(first);
  check(drawn.colours >= DRAWN_COLOURS, 'the globe is drawn, not a blank frame',
    `${drawn.colours} colours, mean brightness ${drawn.mean.toFixed(1)}`);

  // Beside the globe the page's own dark background should show through the canvas,
  // as it does around the JavaScript globe. If Unity's end-of-frame alpha clear comes
  // back, the canvas turns opaque and the halo colour fills it (mean brightness ~130).
  // The view opens on Japan and fills the canvas, so it has to be pulled back out
  // first; the zoom button clamps at the far end, so pressing it often is enough.
  await page.js("(() => { const out = document.getElementById('out');" +
    " for (let i = 0; i < 20; i++) out.click(); return 1; })()");
  await sleep(600);
  const pulledBack = await page.shot('unity-01b-pulled-back');
  const beside = png.region(pulledBack,
    Math.round(pulledBack.width * 0.05), Math.round(pulledBack.height * 0.36),
    Math.round(pulledBack.width * 0.09), Math.round(pulledBack.height * 0.40));
  check(beside.mean < 40, 'the page shows through around the globe',
    `mean brightness ${beside.mean.toFixed(1)} beside the globe`);
  await page.js("document.getElementById('reset').click()");
  await sleep(400);

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

  // The same two marks the JavaScript globe draws, from the same two files. Unity draws
  // them over its own finished picture, so this checks the colours arrive on screen rather
  // than that the page asked for them.
  const targetU = stormTarget();
  const seekLast = await page.js(`(() => {
    const slider = document.getElementById('weatherTime');
    if (!slider || !(+slider.max > 0)) return 'no observation slider';
    slider.value = ${targetU ? `'${targetU.last}'` : 'slider.max'};
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  check(seekLast === 'ok', targetU ? "the storm's last observation can be shown"
    : 'the last observation can be shown',
    targetU ? `${targetU.hours} hours of it, ending ${targetU.away.toFixed(0)}\u00b0 from the middle of the view` : seekLast);
  await sleep(2000);
  const unmarkedU = await page.shot('unity-05-without-the-storm');
  await page.js(`(() => { const box = document.getElementById('storms');
    box.checked = true; box.dispatchEvent(new Event('change')); })()`);
  await sleep(2000);
  const markedU = await page.shot('unity-06-with-the-storm');
  const count = (image, test) => {
    let n = 0;
    for (let i = 0; i < image.data.length; i += image.channels) {
      if (test(image.data[i], image.data[i + 1], image.data[i + 2])) n++;
    }
    return n;
  };
  const amberTest = (r, g, b) => r > 190 && g > 110 && g < 205 && b < 120 && r - b > 90;
  const violetTest = (r, g, b) => b > 140 && b - g > 25 && r > g && b > r && r < 230;
  check(count(markedU, amberTest) > count(unmarkedU, amberTest) + 40, 'the storm mark is drawn',
    `${count(markedU, amberTest)} amber pixels with it, ${count(unmarkedU, amberTest)} without`);

  await page.js(`(() => { const box = document.getElementById('outlook');
    box.checked = true; box.dispatchEvent(new Event('change')); })()`);
  await sleep(3500);
  const outlookU = await page.shot('unity-07-with-the-outlook');
  check(count(outlookU, violetTest) > count(markedU, violetTest) + 30,
    'the outlook is drawn ahead of the last observation',
    `${count(outlookU, violetTest)} violet pixels with it, ${count(markedU, violetTest)} without`);

  const noteU = await page.js("(document.getElementById('stormNote') || {}).textContent || ''");
  check(/推定中心/.test(noteU) && /予報ではありません/.test(noteU),
    'the marks say what they are', noteU.slice(-52));

  // And nowhere else: an hour the globe has an observation for is not overdrawn with a
  // guess about it. Asked of one and the same observation, with the outlook switched on
  // and then off. Comparing against a different observation used to do, while the globe
  // opened with a night side; evenly lit it holds a hundred-odd scene pixels the violet
  // test catches - scattered, not the run of a fan - and those differ from hour to hour,
  // which says nothing about whether a fan was drawn.
  await page.js(`(() => {
    const slider = document.getElementById('weatherTime');
    slider.value = ${targetU ? `'${targetU.mid}'` : 'String(Math.max(0, Math.round(+slider.max / 2)))'};
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(2000);
  const midU = await page.shot('unity-08-outlook-mid-track');
  await page.js(`(() => { const box = document.getElementById('outlook');
    box.checked = false; box.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  const midPlainU = await page.shot('unity-09-mid-track-without-it');
  check(count(midU, violetTest) <= count(midPlainU, violetTest) + 30,
    'no outlook over an observation the globe already has',
    `${count(midU, violetTest)} violet pixels mid-track with it on, ` +
    `${count(midPlainU, violetTest)} with it off`);
  await page.js(`(() => { for (const id of ['storms', 'outlook']) {
    const box = document.getElementById(id); box.checked = false;
    box.dispatchEvent(new Event('change')); } })()`);
  await sleep(600);

  await checkUnityCloseUp(page);

  // Paused, so the only thing a drag can change is the view.
  const paused = await page.shot('unity-03-paused');
  await page.drag(200, 420, 320, 470);
  await sleep(1500);
  const after = await page.shot('unity-04-after-drag');
  const rotated = png.changed(paused, after);
  check(rotated >= 0.02, 'a touch drag rotates the globe',
    `${(rotated * 100).toFixed(1)}% of pixels differ`);
}

// -------------------------------------------------- the close-up

// The close-up layer (dist/weather/region/): the same observations cropped to one part
// of the world at the resolution SSEC holds. It is optional - a build without one
// hides the switch - so this reports rather than fails when none is bundled.
//
// What is measured is placement. The crop carries the same clouds the global frame
// already has, so switching it on must change the picture (it is being drawn) but
// only a little (it lands on the same clouds). A crop mapped to the wrong place
// would paint different clouds over Japan and blow past the upper bound;
// tests/make-region-fixture.cjs --shift builds exactly that, to check this would
// notice.
async function checkCloseUp(page) {
  const offered = await page.js(
    "(() => { const l = document.getElementById('detailToggle'); return !!l && !l.hidden; })()");
  if (!offered) {
    console.log('  --   no close-up is bundled with this build; its checks are skipped');
    return;
  }

  // Sit on an observation the crop covers: it holds fewer times than the globe does,
  // and the globe keeps its global frame for the rest.
  const sought = await page.js(`(() => {
    const w = window.geoWeather, d = window.geoDetail;
    if (!w || !d) return 'no close-up object';
    const product = document.getElementById('weatherProduct').value;
    const times = (w.times && w.times[product]) || [];
    const covered = new Set(d.times);
    let index = -1;
    for (let i = 0; i < times.length; i++) {
      const time = times[i] && times[i].time ? times[i].time : times[i];
      if (covered.has(time)) index = i;
    }
    if (index < 0) return 'no bundled observation has a crop';
    const slider = document.getElementById('weatherTime');
    slider.value = String(index);
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  check(sought === 'ok', 'an observation the close-up covers can be shown', sought);
  if (sought !== 'ok') return;
  await sleep(1800);

  const coarse = await page.shot('10-without-the-close-up');
  await page.js("(() => { const box = document.getElementById('detail');" +
    " box.checked = true; box.dispatchEvent(new Event('change')); return box.checked; })()");
  try {
    await page.waitFor('window.geoDetail && !window.geoDetail.loading && window.geoDetail.ready > 0',
      60000, 'the close-up frames never finished loading');
  } catch (error) {
    check(false, 'the close-up loads', error.message);
    return;
  }
  await sleep(900);
  const close = await page.shot('11-with-the-close-up');

  const moved = png.changed(globeRegionImage(coarse), globeRegionImage(close));
  check(moved > 0.002, 'the close-up is drawn over the observation',
    `${(moved * 100).toFixed(1)}% of pixels differ`);

  // Placement, measured where sharpness cannot reach it: the mean brightness of each
  // cell of a coarse grid. Finer cloud inside a cell barely moves its mean; cloud
  // painted in the wrong place moves it a lot. Measured against this repository's own
  // stand-in (tests/make-region-fixture.cjs): 0.005 placed right, 0.051 two degrees
  // off, 0.133 six degrees off - so the bound below fails a crop 180 km out of place.
  const drift = blockDrift(globeRegionImage(coarse), globeRegionImage(close));
  check(drift < 0.02, 'the close-up lands where the coarse observation put the clouds',
    `mean cell brightness moved by ${(drift * 100).toFixed(1)}% of full scale`);

  const note = await page.js("(document.getElementById('detailNote') || {}).textContent || ''");
  check(/km\/画素/.test(note), 'the page says how fine the close-up is', note.slice(0, 80));

  await page.js("(() => { const box = document.getElementById('detail');" +
    " box.checked = false; box.dispatchEvent(new Event('change')); })()");
  await sleep(500);
}

/// Mean difference in cell brightness over a coarse grid, 0 to 1. Blind to detail
/// inside a cell, which is the point: it answers where the clouds are, not how sharp.
function blockDrift(a, b, cells = 16) {
  let total = 0;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const x0 = Math.floor(a.width * cx / cells), x1 = Math.floor(a.width * (cx + 1) / cells);
      const y0 = Math.floor(a.height * cy / cells), y1 = Math.floor(a.height * (cy + 1) / cells);
      let sa = 0, sb = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * a.width + x) * a.channels, j = (y * b.width + x) * b.channels;
          sa += a.data[i] + a.data[i + 1] + a.data[i + 2];
          sb += b.data[j] + b.data[j + 1] + b.data[j + 2];
          n++;
        }
      }
      if (n) total += Math.abs(sa - sb) / (n * 3 * 255);
    }
  }
  return total / (cells * cells);
}

// The middle band of a frame, as an image rather than a summary, for comparing two
// renders pixel by pixel.
function globeRegionImage(image) {
  const left = Math.round(image.width * 0.1), right = Math.round(image.width * 0.9);
  const top = Math.round(image.height * 0.2), bottom = Math.round(image.height * 0.6);
  const width = right - left, height = bottom - top;
  const data = Buffer.alloc(width * height * image.channels);
  for (let y = 0; y < height; y++) {
    image.data.copy(data, y * width * image.channels,
      ((top + y) * image.width + left) * image.channels,
      ((top + y) * image.width + right) * image.channels);
  }
  return { width, height, channels: image.channels, data };
}

// The same close-up the JavaScript page carries, on the Unity globe: offered only where
// one is bundled, fetched only when asked, and measured the same way - it has to be drawn
// (the picture changes) and it has to land where the coarse observation already put the
// clouds (the coarse grid of cell brightness barely moves).
async function checkUnityCloseUp(page) {
  const offered = await page.js(
    "(() => { const l = document.getElementById('closeUpToggle'); return !!l && !l.hidden; })()");
  if (!offered) {
    console.log('  --   no close-up is bundled with this build; its checks are skipped');
    return;
  }

  // The newest observation: the close-up covers the newest hours of the sequence. The
  // flow streaks are turned off for the comparison - they drift on their own, and two
  // shots seconds apart would differ by them rather than by the close-up.
  const flow = on => page.js(`(() => { const box = document.getElementById('flow');
    box.checked = ${on}; box.dispatchEvent(new Event('change')); })()`);
  await flow(false);
  await page.js(`(() => {
    const slider = document.getElementById('weatherTime');
    slider.value = slider.max;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(2000);
  const coarse = await page.shot('unity-10-without-the-close-up');

  await page.js(`(() => { const box = document.getElementById('closeUp');
    box.checked = true; box.dispatchEvent(new Event('change')); })()`);
  try {
    await page.waitFor("/km\\/画素/.test((document.getElementById('closeUpNote') || {}).textContent || '')",
      90000, 'the close-up never finished loading');
  } catch (error) {
    check(false, 'the close-up loads', error.message);
    return;
  }
  await sleep(1500);
  const close = await page.shot('unity-11-with-the-close-up');

  const moved = png.changed(globeRegionImage(coarse), globeRegionImage(close));
  check(moved > 0.002, 'the close-up is drawn over the observation',
    `${(moved * 100).toFixed(1)}% of pixels differ`);
  const drift = blockDrift(globeRegionImage(coarse), globeRegionImage(close));
  check(drift < 0.02, 'the close-up lands where the coarse observation put the clouds',
    `mean cell brightness moved by ${(drift * 100).toFixed(1)}% of full scale`);

  const note = await page.js("(document.getElementById('closeUpNote') || {}).textContent || ''");
  check(/km\/画素/.test(note), 'the page says how fine the close-up is', note.slice(0, 80));

  await page.js(`(() => { const box = document.getElementById('closeUp');
    box.checked = false; box.dispatchEvent(new Event('change')); })()`);
  await flow(true);
  await sleep(600);
}

// -------------------------------------------------- the panel on a phone

// The settings panel used to be laid out in two columns on a narrow screen. With
// the switches it carries now, an explanation landed beside an unrelated switch and
// a long label wrapped around its own switch, which is what a phone actually showed.
// Both are geometry, so both can be measured rather than eyeballed.
async function checkPanelLayout(page) {
  const panel = JSON.parse(await page.js(`(() => {
    const aside = document.querySelector('aside');
    if (!aside) return JSON.stringify({ missing: true });
    const width = aside.getBoundingClientRect().width;
    const narrow = [], tall = [];
    for (const el of aside.children) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        ' ' + (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
      if (r.width < width * 0.92) narrow.push(name + ' (' + Math.round(r.width) + 'px of ' + Math.round(width) + ')');
      // Two lines of a 14px label plus the padding a row carries; a label that has
      // wrapped around its switch is taller than this.
      if (el.classList.contains('toggle') && r.height > 76) tall.push(name + ' (' + Math.round(r.height) + 'px)');
    }
    return JSON.stringify({ width: Math.round(width), narrow, tall });
  })()`));
  if (panel.missing) { check(false, 'the settings panel is on the page'); return; }
  check(panel.narrow.length === 0, 'the settings panel gives each control its own row',
    panel.narrow.slice(0, 2).join('; '));
  check(panel.tall.length === 0, 'no switch label wraps around its switch',
    panel.tall.slice(0, 2).join('; '));
}

// ---------------------------------------------------------------- main

async function main() {
  if (!LIVE_URL && !fs.existsSync(DIR)) {
    console.error(`${path.relative(ROOT, DIR)} does not exist.` +
      (UNITY ? ' Build the Unity WebGL target into it first — see unity/README.md.' : ''));
    process.exit(2);
  }
  const exe = chromiumPath();
  if (!exe) {
    console.error('No Chromium found. Set CHROMIUM=/path/to/chrome, or install one.');
    process.exit(2);
  }

  const target = LIVE_URL || `http://127.0.0.1:${PORT}${PAGE_PATH}`;
  console.log(LIVE_URL ? `opening   ${LIVE_URL} (live, nothing served locally)`
    : `serving   ${path.relative(ROOT, SERVE_ROOT)}, opening ${target}`);
  console.log(`chromium  ${exe}`);
  const { server, missing } = LIVE_URL ? { server: null, missing: [] } : await serve(SERVE_ROOT, PORT);
  const { child, profile } = launch(exe, PORT + 1);
  let page;
  try {
    page = await connect(PORT + 1);
    await page.viewport(MOBILE ? 412 : 1280, MOBILE ? 915 : 900, MOBILE);
    console.log(`viewport  ${MOBILE ? '412x915 (Android, touch)' : '1280x900 (desktop)'}\n`);

    const version = await loadWithWebGL(page, target);
    check(!!version, 'WebGL context granted', version);
    if (version) {
      if (UNITY) await checkUnityBuild(page);
      else await checkJavaScriptGlobe(page);
    }

    // Only on a phone: on a wide screen the panel is a narrow column beside the
    // globe, where these are not the questions.
    if (MOBILE && version) await checkPanelLayout(page);

    const problems = consoleProblems(page.events);
    check(problems.length === 0, 'no console errors from the site',
      problems.length ? problems[0] : '');
    for (const p of problems.slice(1)) console.log(`       ${p}`);
    if (!LIVE_URL) {
      check(missing.length === 0, 'every requested file was served',
        missing.length ? missing.slice(0, 3).join(' ') : '');
    }
  } finally {
    if (page) page.close();
    if (server) server.close();
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
