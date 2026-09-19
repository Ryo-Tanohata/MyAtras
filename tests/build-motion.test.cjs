'use strict';
// scripts/build-motion.cjs: the motion of the cloud pattern between two observations,
// measured from the observations themselves.
//
// The synthetic frames are made-up clouds in the observations' Web Mercator layout,
// moved by a known amount between the two; what is checked is that the known motion
// comes back, that a pattern which did not move comes back as zero, and that clear
// sky says nothing. The last test holds the bundled motion to the bundled sequence.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { suite } = require('./harness.cjs');
const png = require('../tools/png.cjs');
const { encodePng } = require('../scripts/wind-grid.cjs');
const motion = require('../scripts/build-motion.cjs');

const SIZE = 512;
const HOURS = 3;
const METRES_PER_DEGREE = 111195;

// Cloud blobs [lon, lat] with a 2-degree spread, drawn as bright infrared on a dark
// background, the way the shader's threshold turns brightness into cloud.
function frame(blobs, shiftLon = 0, shiftLat = 0) {
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    const my = (y + 0.5) / SIZE;
    const lat = (2 * Math.atan(Math.exp((0.5 - my) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
    for (let x = 0; x < SIZE; x++) {
      const lon = (x + 0.5) / SIZE * 360 - 180;
      let cloud = 0;
      for (const [bl, bb] of blobs) {
        let dl = lon - (bl + shiftLon);
        dl = ((dl + 180) % 360 + 360) % 360 - 180;
        const dLon = dl * Math.cos(lat * Math.PI / 180), dLat = lat - (bb + shiftLat);
        cloud = Math.max(cloud, Math.exp(-(dLon * dLon + dLat * dLat) / (2 * 2 * 2)));
      }
      const grey = Math.round((0.3 + 0.6 * cloud) * 255);
      const i = (y * SIZE + x) * 3;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = grey;
    }
  }
  return encodePng(SIZE, SIZE, rgb);
}

// Two observations three hours apart in a scratch directory, built into motion.
function measure(earlier, later) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-motion-'));
  const entries = [['20260918.000000', earlier], ['20260918.030000', later]].map(([time, bytes]) => {
    const file = `globalir_${time.replace('.', '_')}.png`;
    fs.writeFileSync(path.join(dir, file), bytes);
    return { time, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ globalir: entries }));
  const out = path.join(dir, 'motion');
  const log = process.stdout.write;
  process.stdout.write = () => true;
  let intervals;
  try { intervals = motion.build(dir, out); } finally { process.stdout.write = log; }
  const image = png.decode(fs.readFileSync(path.join(out, intervals[0].file)));
  fs.rmSync(dir, { recursive: true, force: true });
  // Speed and confidence at a longitude and latitude, from the 2-degree output.
  return (lon, lat) => {
    const col = Math.min(179, Math.max(0, Math.round((lon + 179) / 2)));
    const row = Math.min(89, Math.max(0, Math.round((89 - lat) / 2)));
    const i = (row * 180 + col) * 3;
    return {
      east: (image.data[i] / 255 - 0.5) * 2 * motion.SCALE,
      north: (image.data[i + 1] / 255 - 0.5) * 2 * motion.SCALE,
      confidence: image.data[i + 2] / 255,
      manifest: intervals[0],
    };
  };
}

const BLOBS = [[-120, 0], [-60, 30], [0, -30], [60, 50], [120, 10], [150, -45]];
const s = suite('build-motion');

s.test('a known motion comes back', () => {
  // Two degrees east and one north in three hours: multiples of the half-degree grid,
  // so the search can land on them exactly.
  const at = measure(frame(BLOBS), frame(BLOBS, 2, 1));
  for (const [lon, lat] of BLOBS) {
    const m = at(lon + 1, lat + 0.5);
    const east = 2 * METRES_PER_DEGREE * Math.cos(lat * Math.PI / 180) / (HOURS * 3600);
    const north = METRES_PER_DEGREE / (HOURS * 3600);
    assert.ok(m.confidence > 0.5, `confident at ${lon}, ${lat}: ${m.confidence.toFixed(2)}`);
    assert.ok(Math.abs(m.east - east) < 2, `east at ${lon}, ${lat}: ${m.east.toFixed(1)} vs ${east.toFixed(1)} m/s`);
    assert.ok(Math.abs(m.north - north) < 2, `north at ${lon}, ${lat}: ${m.north.toFixed(1)} vs ${north.toFixed(1)} m/s`);
  }
});

// Cold ground and clouds that stay put are real answers: zero, and confident.
s.test('a pattern that did not move comes back as zero, not as nothing', () => {
  const same = frame(BLOBS);
  const at = measure(same, same);
  for (const [lon, lat] of BLOBS) {
    const m = at(lon, lat);
    assert.ok(m.confidence > 0.5, `confident at ${lon}, ${lat}: ${m.confidence.toFixed(2)}`);
    assert.ok(Math.hypot(m.east, m.north) < 1, `still at ${lon}, ${lat}: ${m.east.toFixed(1)}, ${m.north.toFixed(1)}`);
  }
});

s.test('clear sky says nothing, and is left to the observed wind', () => {
  const at = measure(frame(BLOBS), frame(BLOBS, 2, 1));
  // Far from every blob.
  for (const [lon, lat] of [[-90, -50], [30, 40], [90, -20]]) {
    assert.strictEqual(at(lon, lat).confidence, 0, `no confidence at ${lon}, ${lat}`);
  }
});

s.test('motion across the antimeridian is measured as motion, not a jump round the world', () => {
  const blobs = [[178, 20]];
  const at = measure(frame(blobs), frame(blobs, 2, 0));
  const m = at(179, 20);
  const east = 2 * METRES_PER_DEGREE * Math.cos(20 * Math.PI / 180) / (HOURS * 3600);
  assert.ok(m.confidence > 0.5, `confident: ${m.confidence.toFixed(2)}`);
  assert.ok(Math.abs(m.east - east) < 2, `east ${m.east.toFixed(1)} vs ${east.toFixed(1)} m/s`);
});

s.test('each field records the two observations it was measured from', () => {
  const earlier = frame(BLOBS), later = frame(BLOBS, 2, 1);
  const m = measure(earlier, later)(0, 0).manifest;
  assert.strictEqual(m.fromSha256, crypto.createHash('sha256').update(earlier).digest('hex'));
  assert.strictEqual(m.toSha256, crypto.createHash('sha256').update(later).digest('hex'));
});

// Refreshing the observations without rebuilding the motion would carry new clouds by
// old motion. The bundled fields must be the ones measured from the bundled frames.
s.test('the bundled motion was measured from the bundled observations', () => {
  const root = path.join(__dirname, '..', 'dist');
  const frames = JSON.parse(fs.readFileSync(path.join(root, 'weather', 'sequence', 'manifest.json'), 'utf8'))
    .globalir.slice().sort((a, b) => a.time.localeCompare(b.time));
  const bundled = JSON.parse(fs.readFileSync(path.join(root, 'data', 'motion', 'manifest.json'), 'utf8'));
  assert.strictEqual(bundled.intervals.length, frames.length - 1, 'one field per interval');
  bundled.intervals.forEach((m, k) => {
    assert.strictEqual(m.from, frames[k].time);
    assert.strictEqual(m.to, frames[k + 1].time);
    assert.strictEqual(m.fromSha256, frames[k].sha256, `${m.from} measured from the bundled frame`);
    assert.strictEqual(m.toSha256, frames[k + 1].sha256, `${m.to} measured from the bundled frame`);
    const bytes = fs.readFileSync(path.join(root, 'data', 'motion', m.file));
    assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'), m.sha256);
  });
});

s.run();
