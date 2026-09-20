'use strict';
// scripts/find-storms.cjs: the tropical cyclones in the observations, found from the
// observations alone.
//
// The synthetic frames are made-up cloud in the observations' Web Mercator layout, so a
// test can put a storm exactly where it wants one and know what should come back. What
// is checked is the part that does the work: that a compact mass travelling steadily is
// called a cyclone and comes back where it was put; that the three things which are not
// cyclones but look like one in a single frame - convection sitting still, a burst that
// lasts a few hours, a mass on the equator - are not; and that a storm whose canopy runs
// into a long frontal band is still followed, which is the case that the second stage
// exists for. The last test holds the bundled storms to the bundled observations.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite } = require('./harness.cjs');
const { encodePng } = require('../scripts/wind-grid.cjs');
const storms = require('../scripts/find-storms.cjs');

const SIZE = 512;

/// One frame. Each shape is drawn as bright infrared on a dark background: a `blob` is a
/// round mass with a 1.6-degree spread, a `band` is a long diagonal front, both well above
/// the threshold at their centre so they count as deep cold cloud.
function frame(shapes) {
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) {
    const lat = (2 * Math.atan(Math.exp((0.5 - (y + 0.5) / SIZE) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
    for (let x = 0; x < SIZE; x++) {
      const lon = (x + 0.5) / SIZE * 360 - 180;
      let cloud = 0;
      for (const s of shapes) {
        const wrap = d => ((d + 180) % 360 + 360) % 360 - 180;
        if (s.kind === 'band') {
          // A front: far in one direction, narrow in the other.
          const along = wrap(lon - s.lon) * Math.cos(lat * Math.PI / 180) + (lat - s.lat);
          const across = (lat - s.lat) - wrap(lon - s.lon) * Math.cos(lat * Math.PI / 180);
          if (Math.abs(along) > s.length) continue;
          cloud = Math.max(cloud, Math.exp(-(across * across) / (2 * 1.2 * 1.2)));
        } else {
          const dLon = wrap(lon - s.lon) * Math.cos(lat * Math.PI / 180), dLat = lat - s.lat;
          cloud = Math.max(cloud, Math.exp(-(dLon * dLon + dLat * dLat) / (2 * 1.6 * 1.6)));
        }
      }
      const grey = Math.round((0.25 + 0.72 * cloud) * 255);
      const i = (y * SIZE + x) * 3;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = grey;
    }
  }
  return encodePng(SIZE, SIZE, rgb);
}

/// A sequence of hourly frames in a scratch directory, and the tracks found in it.
function run(hours, shapesAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myatras-storms-'));
  try {
    const files = [], times = [];
    for (let h = 0; h < hours; h++) {
      const stamp = new Date(Date.UTC(2026, 0, 1, h));
      const p = n => String(n).padStart(2, '0');
      const time = `${stamp.getUTCFullYear()}${p(stamp.getUTCMonth() + 1)}${p(stamp.getUTCDate())}`
        + `.${p(stamp.getUTCHours())}0000`;
      const file = path.join(dir, `globalir_${time.replace('.', '_')}.png`);
      fs.writeFileSync(file, frame(shapesAt(h)));
      files.push(file);
      times.push(time);
    }
    return storms.track(files, times);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const cyclones = found => found.filter(s => s.cyclone);

const s = suite('find-storms');

// 0.2 degrees an hour at this latitude is about 21 km/h, which is how fast a typhoon
// travels, and 30 hours of it clears the 24 the tests below ask for.
const drifting = h => [{ lon: 140 + h * 0.2, lat: 18 + h * 0.12 }];

s.test('a storm that travels is found, where it was put', () => {
  const found = cyclones(run(30, drifting));
  assert.strictEqual(found.length, 1, 'exactly one cyclone');
  const last = found[0].points[found[0].points.length - 1];
  const want = drifting(29)[0];
  assert.ok(storms.km(last.lat, last.lon, want.lat, want.lon) < 150,
    `ends near where it was put, was ${last.lat}N ${last.lon}E for ${want.lat}N ${want.lon}E`);
});

s.test('the whole passage is followed, not just part of it', () => {
  const found = cyclones(run(30, drifting));
  assert.ok(found[0].span >= 28, `spans the sequence, was ${found[0].span}`);
  assert.ok(found[0].completeness >= 0.9, `found in nearly every hour, was ${found[0].completeness}`);
});

// Afternoon convection over land is the commonest thing that looks like a storm in one
// frame. It is told apart by not going anywhere.
s.test('convection that sits still is not a cyclone', () => {
  assert.strictEqual(cyclones(run(30, () => [{ lon: 20, lat: 10 }])).length, 0);
});

s.test('a burst that lasts a few hours is not a cyclone', () => {
  const found = cyclones(run(30, h => (h < 8 ? [{ lon: 140 + h * 0.2, lat: 18 + h * 0.12 }] : [])));
  assert.strictEqual(found.length, 0);
});

// There is no Coriolis force on the equator, so there are no cyclones there, however
// organised and long-lived the cloud is.
s.test('cloud on the equator is not a cyclone, however it moves', () => {
  assert.strictEqual(cyclones(run(30, h => [{ lon: 140 + h * 0.2, lat: 0.5 }])).length, 0);
});

// The reason the second stage exists. Near Japan a typhoon's canopy runs into the frontal
// band and the two become one connected area, whose centroid is somewhere down the front;
// following the cold core nearest the storm's own heading keeps the centre on the storm.
s.test('a storm is still followed when its canopy joins a front', () => {
  const found = cyclones(run(30, h => {
    const storm = drifting(h)[0];
    return h < 15 ? [storm] : [storm, { kind: 'band', lon: storm.lon + 3, lat: storm.lat + 3, length: 26 }];
  }));
  assert.strictEqual(found.length, 1, 'still one cyclone once the front arrives');
  const last = found[0].points[found[0].points.length - 1];
  const want = drifting(29)[0];
  assert.ok(storms.km(last.lat, last.lon, want.lat, want.lon) < 300,
    `centre stayed on the storm, was ${last.lat}N ${last.lon}E for ${want.lat}N ${want.lon}E`);
  assert.ok(found[0].span >= 28, `and was not cut short, was ${found[0].span}`);
});

s.test('two storms at once are two tracks, not one', () => {
  const found = cyclones(run(30, h => [
    { lon: 140 + h * 0.2, lat: 18 + h * 0.12 },
    { lon: -60 - h * 0.2, lat: 16 + h * 0.1 },
  ]));
  assert.strictEqual(found.length, 2);
  assert.ok(storms.km(found[0].points[0].lat, found[0].points[0].lon,
    found[1].points[0].lat, found[1].points[0].lon) > 5000, 'and they are the two that were drawn');
});

// Refreshing the observations without rebuilding this would leave last week's storm on
// this week's clouds. The bundled storms must be the ones found in the bundled frames.
s.test('the bundled storms were found in the bundled observations', () => {
  const root = path.join(__dirname, '..', 'dist');
  const frames = JSON.parse(fs.readFileSync(path.join(root, 'weather', 'sequence', 'manifest.json'), 'utf8'))
    .globalir.slice().sort((a, b) => a.time.localeCompare(b.time));
  const bundled = JSON.parse(fs.readFileSync(path.join(root, 'data', 'storms.json'), 'utf8'));
  assert.strictEqual(bundled.frames.length, frames.length, 'one entry per observation');
  bundled.frames.forEach((f, i) => {
    assert.strictEqual(f.time, frames[i].time);
    assert.strictEqual(f.sha256, frames[i].sha256, `${f.time} is the bundled frame`);
  });
  const times = new Set(frames.map(f => f.time));
  for (const storm of bundled.storms) {
    for (const p of storm.points) {
      assert.ok(times.has(p.time), `${p.time} is one of the bundled observation times`);
      assert.ok(Math.abs(p.lat) >= storms.MIN_ABS_LAT, `${p.time} is off the equator`);
    }
  }
});

s.run();
