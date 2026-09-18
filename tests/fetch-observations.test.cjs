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
const TIMES = ['20260918.060000', '20260918.070000', '20260918.080000', '20260918.090000'];

// Bytes standing in for an image: distinct per product and time so a mix-up shows.
const body = (product, time, size) => Buffer.from(`${product}:${time}:${size}`.repeat(8));

/// An API stand-in. `serve` decides what RE-Time each image answers with, so a test
/// can make the server contradict the request.
function api({ reTime = time => time, omitHeader = false } = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/products')) {
      const product = url.searchParams.get('products');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([{ id: product, times: TIMES }]));
      return;
    }
    if (url.pathname.endsWith('/image')) {
      const [product, ...rest] = url.searchParams.get('products').split('_');
      const time = rest.join('_').replace(/_(\d{6})$/, '.$1');
      const size = url.searchParams.get('width');
      const headers = { 'Content-Type': 'image/png' };
      if (!omitHeader) headers['RE-Time'] = reTime(time);
      response.writeHead(200, headers);
      response.end(body(product, time, size));
      return;
    }
    response.writeHead(404).end('no');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}/api/`,
  })));
}

// Asynchronously: the stand-in server runs in this process, so a blocking spawn
// would leave it unable to answer the request it is waiting for.
function run(base, out, extra = []) {
  return new Promise(resolve => {
    const child = spawn('node', [SCRIPT, '--out', out, '--frames', '3', ...extra],
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
