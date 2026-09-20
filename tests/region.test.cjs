'use strict';
// The close-up: where a crop of one part of the world sits inside the global frame,
// and what the page does with the one that is bundled - including when none is.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./harness.cjs');
const RegionBox = require('../dist/region-box.js');
const { DetailLayer } = require('../dist/detail.js');

const ROOT = path.resolve(__dirname, '..');
const s = suite('region');

s.test('the Mercator y matches the one the globe samples its frames in', () => {
  // The shader computes my = .5 - log(tan(PI/4 + lat/2)) / (2 PI); dist/weather.js
  // has the same line for the flat view. A crop placed with a different formula
  // would sit a few pixels off, so this pins the three to each other.
  const { mercatorY } = require('../dist/weather.js');
  for (const latitude of [0, 24, 35.5, 46, -30, 85.05112878]) {
    assert.ok(Math.abs(RegionBox.mercator01(latitude) - mercatorY(latitude)) < 1e-12,
      `${latitude} degrees`);
  }
  assert.strictEqual(RegionBox.mercator01(0), 0.5);
  assert.ok(RegionBox.mercator01(85.05112878) < 1e-9, 'the top edge of a global frame');
});

s.test('a box keeps its pixels square', () => {
  const box = RegionBox.box({ south: 24, west: 122, north: 46, east: 148, width: 1280 });
  const acrossDegrees = (box.u1 - box.u0) * 360;
  assert.strictEqual(Math.round(acrossDegrees), 26);
  // Height follows the projection: the same number of Mercator units per pixel.
  const perPixelX = (box.u1 - box.u0) / box.width;
  const perPixelY = (box.v1 - box.v0) / box.height;
  assert.ok(Math.abs(perPixelX - perPixelY) / perPixelX < 0.001, 'a pixel is as tall as it is wide');
  assert.ok(box.v0 < box.v1, 'north is above south in image coordinates');
});

s.test('the box is refused where it cannot be placed', () => {
  assert.throws(() => RegionBox.box({ south: 46, west: 122, north: 24, east: 148, width: 100 }));
  // Across the date line the crop would wrap around the seam of the global frame.
  assert.throws(() => RegionBox.box({ south: 20, west: 170, north: 40, east: -170, width: 100 }));
  assert.throws(() => RegionBox.box({ south: 20, west: 120, north: 40, east: 140, width: 0 }));
});

s.test('kilometres per pixel is what decides whether zooming in shows anything', () => {
  const global = RegionBox.box({ south: -85, west: -180, north: 85, east: 180, width: 512 });
  const japan = RegionBox.box({ south: 24, west: 122, north: 46, east: 148, width: 1280 });
  const coarse = RegionBox.kmPerPixel(global, 35.5), fine = RegionBox.kmPerPixel(japan, 35.5);
  assert.ok(coarse > 60 && coarse < 70, `global frames are ${coarse.toFixed(0)} km per pixel`);
  assert.ok(fine > 1.5 && fine < 2.5, `the crop is ${fine.toFixed(1)} km per pixel`);
});

s.test('with no crop bundled the layer offers nothing', async () => {
  const layer = new DetailLayer();
  global.GeoData = { region: async () => null };
  try {
    assert.strictEqual(await layer.describe(), null);
    assert.deepStrictEqual(layer.times, []);
    assert.strictEqual(layer.megabytes, 0);
    assert.strictEqual(layer.imageFor('20260920.000000'), null);
    assert.strictEqual(layer.box(), null);
  } finally {
    delete global.GeoData;
  }
});

function stubManifest() {
  return {
    name: 'japan',
    bounds: { south: 24, west: 122, north: 46, east: 148 },
    width: 640,
    height: 669,
    kmPerPixel: 3.7,
    frames: [
      { time: '20260920.030000', file: 'a.png', url: 'weather/region/a.png', bytes: 500000 },
      { time: '20260920.040000', file: 'b.png', url: 'weather/region/b.png', bytes: 700000 },
    ],
  };
}

s.test('a crop is used only for the times it holds, and only when asked for', async () => {
  const layer = new DetailLayer();
  global.GeoData = { region: async () => stubManifest() };
  global.RegionBox = RegionBox;
  try {
    const manifest = await layer.describe();
    assert.strictEqual(manifest.frames.length, 2);
    assert.deepStrictEqual(layer.times, ['20260920.030000', '20260920.040000']);
    assert.ok(Math.abs(layer.megabytes - 1.144) < 0.01);

    // Loaded, but the switch is off: the globe keeps its global frames.
    layer.images.set('20260920.030000', { width: 640, height: 669 });
    assert.strictEqual(layer.imageFor('20260920.030000'), null, 'off means off');

    layer.enabled = true;
    assert.ok(layer.imageFor('20260920.030000'), 'the time it holds');
    assert.strictEqual(layer.imageFor('20260920.040000'), null, 'not fetched yet');
    assert.strictEqual(layer.imageFor('20260919.120000'), null,
      'a time with no crop keeps the global observation rather than an older crop');

    const box = layer.box();
    assert.ok(Math.abs(box.u0 - (122 + 180) / 360) < 1e-12);
  } finally {
    delete global.GeoData;
    delete global.RegionBox;
  }
});

s.test('the bundled crop belongs to the bundled observations', () => {
  const file = path.join(ROOT, 'dist/weather/region/manifest.json');
  assert.ok(fs.existsSync(file),
    'the manifest is always present, so the page never asks for a file that is not there');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(manifest.frames));
  if (!manifest.frames.length) return;  // none bundled: the page hides the switch

  const observations = new Set(JSON.parse(fs.readFileSync(
    path.join(ROOT, 'dist/weather/sequence/manifest.json'), 'utf8')).globalir.map(f => f.time));
  for (const frame of manifest.frames) {
    assert.ok(observations.has(frame.time),
      `${frame.time} is not one of the bundled observations; re-run the fetch with --region`);
    assert.ok(fs.existsSync(path.join(ROOT, 'dist/weather/region', frame.file)), frame.file);
    assert.ok(/^[0-9a-f]{64}$/.test(frame.sha256 || ''), `${frame.file} has no SHA-256`);
  }
  const box = RegionBox.box({ ...manifest.bounds, width: manifest.width });
  assert.strictEqual(box.height, manifest.height, 'the stored height matches the projection');
});

s.run();
