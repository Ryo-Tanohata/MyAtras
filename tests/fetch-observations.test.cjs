'use strict';
// scripts/fetch-observations.cjs against a stand-in for the SSEC API.
//
// The stand-in serves invented bytes under invented times - it is a stand-in for the
// protocol, not for the observations. What is checked is that the script stores
// exactly what the server said it served, records it truthfully, and refuses to
// store anything whose time the server does not confirm.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { suite } = require('./harness.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fetch-observations.cjs');
// Half-hourly, as SSEC publishes some products: enough to tell "as listed" apart
// from a chosen spacing.
const TIMES = [
  '20260918.060000', '20260918.063000', '20260918.070000', '20260918.073000',
  '20260918.080000', '20260918.083000', '20260918.090000',
];

// Bytes standing in for an image: distinct per product and time so a mix-up shows.
const body = (product, time, size) => Buffer.from(`${product}:${time}:${size}`.repeat(8));

/// An API stand-in. `serve` decides what RE-Time each image answers with, so a test
/// can make the server contradict the request.
function api({ reTime = time => time, omitHeader = false, staleWind = false, watermark = null } = {}) {
  // Every request, so a test can count what a run actually asked the server for.
  const calls = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    calls.push(request.url);
    if (url.pathname.endsWith('/products')) {
      const product = url.searchParams.get('products');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([{ id: product, times: TIMES }]));
      return;
    }
    if (url.pathname.endsWith('/shapes')) {
      const [product, ...rest] = url.searchParams.get('products').split('_');
      const band = product.slice(0, 9);
      const time = rest.join('_').replace(/_(\d{6})$/, '.$1');
      const stamp = staleWind ? '20260917' + time.slice(8) : time;
      const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
      const clock = `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
      const low = band === 'AMV-LLlow';
      const features = [];
      for (let lat = -40; lat <= 40; lat += 10) {
        for (let lon = -170; lon <= 170; lon += 20) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            // Meteorological direction is where the wind comes FROM: 270 is a westerly.
            properties: { DAY: day, TIME: clock, SPD: 20, DIR: low ? 270 : 180, PRE: low ? 850 : 700 },
          });
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ type: 'FeatureCollection', features }));
      return;
    }
    if (url.pathname.endsWith('/image')) {
      const [product, ...rest] = url.searchParams.get('products').split('_');
      const time = rest.join('_').replace(/_(\d{6})$/, '.$1');
      const size = url.searchParams.get('width');
      const headers = { 'Content-Type': 'image/png' };
      if (!omitHeader) headers['RE-Time'] = reTime(time);
      // What SSEC answers with when an image request is larger than it serves: the
      // picture, with "Size limit exceeded" written across it in tiles.
      if (watermark) headers['RE-Watermark'] = watermark;
      response.writeHead(200, headers);
      response.end(body(product, time, size));
      return;
    }
    response.writeHead(404).end('no');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    calls,
    base: `http://127.0.0.1:${server.address().port}/api/`,
  })));
}

// Asynchronously: the stand-in server runs in this process, so a blocking spawn
// would leave it unable to answer the request it is waiting for.
function run(base, out, extra = []) {
  return new Promise(resolve => {
    // A test that sets its own --frames means it, so the default is not also passed:
    // the script reads the first occurrence of an option.
    const frames = extra.includes('--frames') ? [] : ['--frames', '3'];
    const child = spawn('node', [SCRIPT, '--out', out, ...frames, ...extra],
      { env: { ...process.env, MYATRAS_API_BASE: base } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-observations-'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const s = suite('fetch-observations');

s.test('stores the newest frames and records what it stored', async () => {
  const { server, base } = await api();
  const out = temp();
  try {
    const result = await run(base, out);
    assert.strictEqual(result.status, 0, result.stderr);

    const manifest = read(path.join(out, 'sequence', 'manifest.json'));
    assert.deepStrictEqual(manifest.globalir.map(f => f.time), TIMES.slice(-3),
      'the three newest observations, oldest first');

    for (const frame of manifest.globalir) {
      const file = path.join(out, 'sequence', frame.file);
      assert.ok(fs.existsSync(file), `${frame.file} was written`);
      assert.strictEqual(sha256(file), frame.sha256, 'the manifest records the stored bytes');
      assert.strictEqual(fs.statSync(file).size, frame.bytes);
      assert.ok(frame.source.includes(frame.time.replace('.', '_')), 'and the URL it came from');
      assert.ok(frame.source.includes('width=512'));
    }
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

s.test('stores the newest observation of each product as the opening snapshot', async () => {
  const { server, base } = await api();
  const out = temp();
  try {
    assert.strictEqual((await run(base, out)).status, 0);
    const snapshot = read(path.join(out, 'snapshot.json'));
    for (const product of ['globalir', 'globalvis']) {
      assert.strictEqual(snapshot[product].time, TIMES.at(-1));
      assert.ok(snapshot[product].source.includes('width=1024'), 'the snapshot is the larger image');
      const file = path.join(out, snapshot[product].file);
      assert.strictEqual(sha256(file), snapshot[product].sha256);
    }
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// An observation the manifest no longer names would otherwise sit in the directory
// for ever, published and unreferenced.
s.test('frames from an earlier run are removed', async () => {
  const { server, base } = await api();
  const out = temp();
  try {
    const stale = path.join(out, 'sequence', 'globalir_20260101_000000.png');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'old');

    assert.strictEqual((await run(base, out)).status, 0);
    assert.ok(!fs.existsSync(stale), 'the stale frame is gone');
    assert.strictEqual(fs.readdirSync(path.join(out, 'sequence')).filter(n => n.endsWith('.png')).length, 3);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// The whole point of the check: a frame is only ever stored under the time the
// server itself says it holds.
s.test('an observation served under another time is refused', async () => {
  const { server, base } = await api({ reTime: () => '20260101.000000' });
  const out = temp();
  try {
    const result = await run(base, out);
    assert.notStrictEqual(result.status, 0, 'the run fails');
    assert.ok(/asked for .*, served 20260101\.000000/.test(result.stderr), result.stderr);
    assert.ok(!fs.existsSync(path.join(out, 'sequence', 'manifest.json')),
      'and no manifest claims otherwise');
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

s.test('an observation whose time is not confirmed at all is refused', async () => {
  const { server, base } = await api({ omitHeader: true });
  const out = temp();
  try {
    const result = await run(base, out);
    assert.notStrictEqual(result.status, 0);
    assert.ok(/RE-Time/.test(result.stderr), result.stderr);
    assert.ok(!fs.existsSync(path.join(out, 'sequence', 'manifest.json')));
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// More frames, or finer ones, is a question of which listed times are kept: the
// spacing on offer is reported, and --every thins it without ever skipping the
// newest observation.
s.test('the spacing SSEC publishes at is reported', async () => {
  const { server, base } = await api();
  const out = temp();
  try {
    const result = await run(base, out);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(/7 observation times, about 30 minutes apart/.test(result.stdout), result.stdout);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

s.test('--every keeps one observation per interval, newest first', async () => {
  const { server, base } = await api();
  const out = temp();
  try {
    assert.strictEqual((await run(base, out, ['--every', '60'])).status, 0);
    const manifest = read(path.join(out, 'sequence', 'manifest.json'));
    assert.deepStrictEqual(manifest.globalir.map(f => f.time),
      ['20260918.070000', '20260918.080000', '20260918.090000'],
      'an hour apart, ending at the newest observation');
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

s.test('asking for more frames than are listed takes what there is', async () => {
  const { server, base } = await api();
  const out = temp();
  try {
    const result = await run(base, out, ['--frames', '99', '--every', '60']);
    assert.strictEqual(result.status, 0, result.stderr);
    const manifest = read(path.join(out, 'sequence', 'manifest.json'));
    assert.strictEqual(manifest.globalir.length, 4, 'four hourly steps fit in the listing');
    assert.ok(/only 4 of the 99/.test(result.stdout), result.stdout);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// The wind at every bundled observation's time, as the images the globe reads.
s.test('--winds stores the wind observed at each bundled time, and says how it was made', async () => {
  const { server, base } = await api();
  const out = temp();
  try {
    const result = await run(base, out, ['--every', '60', '--winds']);
    assert.strictEqual(result.status, 0, result.stderr);
    const frames = read(path.join(out, 'sequence', 'manifest.json')).globalir.map(f => f.time);
    const wind = read(path.join(out, 'wind', 'manifest.json'));
    assert.deepStrictEqual(wind.winds.map(w => w.time), frames, 'one wind per observation, same times');
    assert.deepStrictEqual(wind.missing, []);
    assert.ok(/Gaussian/.test(wind.method), 'the manifest says how the gaps were spread');

    const png = require('../tools/png.cjs');
    for (const entry of wind.winds) {
      const file = path.join(out, 'wind', entry.file);
      assert.strictEqual(sha256(file), entry.sha256);
      const image = png.decode(fs.readFileSync(file));
      assert.strictEqual(image.width, 360);
      assert.strictEqual(image.height, 180);
      assert.strictEqual(image.channels, 3, 'opaque, so no browser can premultiply the wind away');
      // The texel centred at 20.5 N, 10.5 E, 0.7 degrees from vectors at 20 N 10 E: a
      // 20-knot westerly (10.3 m/s east) in the low band, mixed with the mid band's
      // southerly there. Row 0 is centred at 89.5 N.
      const i = ((89 - 20) * 360 + 190) * 3;
      const east = (image.data[i] / 255 - 0.5) * 80;
      assert.ok(east > 3, `eastward where the westerlies were observed, got ${east.toFixed(1)} m/s`);
      // Two vectors 0.71 degrees away, one per band, each weighted by a 3-degree
      // Gaussian: 1 - exp(-2 exp(-(0.71/3)^2)) = 0.85, as 217 of 255.
      const d = Math.SQRT1_2;
      const trust = 1 - Math.exp(-2 * Math.exp(-((d / 3) ** 2)));
      assert.ok(Math.abs(image.data[i + 2] - trust * 255) <= 1.5,
        `trusted as far as the vectors around it allow: ${image.data[i + 2]} vs ${(trust * 255).toFixed(1)}`);
      // Far from any vector - 70 S, beyond the 9 degrees the wind is spread - nothing.
      const far = ((89 + 70) * 360 + 190) * 3;
      assert.deepStrictEqual([...image.data.subarray(far, far + 3)], [128, 128, 0], 'still air, no trust');
    }
    // The JavaScript version's wind model gets the middle one.
    const amv = read(path.join(out, 'amv.json'));
    assert.strictEqual(amv.time, frames[Math.floor((frames.length - 1) / 2)]);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// The wind is what a run costs: one AMV-LLlow answer is about 20 MB and one AMV-LLmid
// answer about 3 MB, so an hour asked for twice is 23 MB taken from a university server
// for a grid already on disk. A wind is an observation at a fixed hour and does not
// change, so an hour whose stored grid still matches its manifest is kept.
s.test('the wind already stored is not asked for a second time', async () => {
  const { server, base, calls } = await api();
  const out = temp();
  try {
    const first = await run(base, out, ['--winds']);
    assert.strictEqual(first.status, 0, first.stderr);
    const askedFirst = calls.filter(u => u.includes('/shapes')).length;
    assert.strictEqual(askedFirst, 6, 'three hours, two pressure bands');

    calls.length = 0;
    const again = await run(base, out, ['--winds']);
    assert.strictEqual(again.status, 0, again.stderr);
    const askedAgain = calls.filter(u => u.includes('/shapes')).length;
    // Only the middle hour, whose two answers are what amv.json is rebuilt from.
    assert.strictEqual(askedAgain, 2, `asked for ${askedAgain} shape responses again`);
    assert.ok(/already stored/.test(again.stdout), again.stdout);

    // And what was kept is still the wind for those hours, byte for byte.
    const wind = read(path.join(out, 'wind', 'manifest.json'));
    assert.strictEqual(wind.winds.length, 3);
    for (const entry of wind.winds) {
      assert.strictEqual(sha256(path.join(out, 'wind', entry.file)), entry.sha256, entry.file);
    }

    // --refetch-winds asks for all of them again.
    calls.length = 0;
    const forced = await run(base, out, ['--winds', '--refetch-winds']);
    assert.strictEqual(forced.status, 0, forced.stderr);
    assert.strictEqual(calls.filter(u => u.includes('/shapes')).length, 6);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// An image with a notice written across it is not the observation. SSEC stamps "Size
// limit exceeded" over an image request above about 1.17 million pixels and says so in a
// header; storing that would put the notice on the globe and call it an observation.
s.test('an answer marked as watermarked is refused', async () => {
  const { server, base } = await api({ watermark: 'size 1.21' });
  const out = temp();
  try {
    const result = await run(base, out);
    assert.notStrictEqual(result.status, 0, 'the run has to fail');
    assert.ok(/RE-Watermark/.test(result.stderr), result.stderr);
    assert.ok(/Size limit exceeded/.test(result.stderr), result.stderr);
    assert.ok(!fs.existsSync(path.join(out, 'sequence', 'manifest.json')),
      'nothing is recorded as bundled');
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// A wind observed at another time is not the wind at this one.
s.test('wind observed at another time is not stored under this one', async () => {
  const { server, base } = await api({ staleWind: true });
  const out = temp();
  try {
    const result = await run(base, out, ['--every', '60', '--winds']);
    assert.strictEqual(result.status, 0, result.stderr);
    const wind = read(path.join(out, 'wind', 'manifest.json'));
    assert.deepStrictEqual(wind.winds, [], 'nothing kept');
    assert.strictEqual(wind.missing.length, 3, 'every time recorded as missing instead');
    assert.deepStrictEqual(fs.readdirSync(path.join(out, 'wind')).filter(n => n.endsWith('.png')), []);
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

s.test('the same observations produce the same manifest', async () => {
  const { server, base } = await api();
  const out = temp();
  try {
    assert.strictEqual((await run(base, out)).status, 0);
    const first = fs.readFileSync(path.join(out, 'sequence', 'manifest.json'), 'utf8');
    assert.strictEqual((await run(base, out)).status, 0);
    assert.strictEqual(fs.readFileSync(path.join(out, 'sequence', 'manifest.json'), 'utf8'), first,
      'a second run over unchanged observations changes nothing');
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

s.run();
