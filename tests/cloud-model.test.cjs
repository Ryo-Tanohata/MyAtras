'use strict';
// Numerical checks on the wind model and on every bundled observed vector.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./harness.cjs');
const M = require('../dist/cloud-model.js');

const s = suite('cloud-model');
const near = (a, b, tolerance, what) =>
  assert.ok(Math.abs(a - b) <= tolerance, what + ': ' + a + ' vs ' + b);

s.test('wind components use m/s and the meteorological FROM convention', () => {
  const north = M.windComponents(10, 0);      // wind FROM the north blows south
  near(north.u, 0, 1e-9, 'u');
  near(north.v, -10 * M.KNOT_MPS, 1e-9, 'v');
  const west = M.windComponents(10, 270);     // wind FROM the west blows east
  near(west.u, 10 * M.KNOT_MPS, 1e-9, 'u');
  near(west.v, 0, 1e-9, 'v');
  near(M.windComponents(1, 0).v, -0.5144444, 1e-6, 'one knot in m/s');
});

s.test('pressure maps to standard-atmosphere altitude', () => {
  near(M.pressureHeight(1013.25), 0, 1e-9, 'sea level');
  near(M.pressureHeight(850), 1.457, 0.01, '850 hPa');
  near(M.pressureHeight(650), 3.591, 0.01, '650 hPa');
  assert.ok(M.pressureHeight(600) > M.pressureHeight(950), 'lower pressure is higher up');
});

s.test('advection moves the observed distance on the sphere', () => {
  const east = { lat: 0, lon: 0, u: 10, v: 0 };
  const after = M.advect(east, 3600);
  near(after.lat, 0, 1e-9, 'latitude unchanged');
  const km = after.lon / 360 * 2 * Math.PI * M.EARTH_KM;
  near(km, 36, 0.2, 'kilometres travelled in one hour');
  const north = M.advect({ lat: 0, lon: 0, u: 0, v: 10 }, 3600);
  near(north.lat * Math.PI / 180 * M.EARTH_KM, 36, 0.2, 'northward kilometres');
  near(north.lon, 0, 1e-9, 'longitude unchanged');
});

s.test('longitude wraps across the date line and latitude is bounded', () => {
  assert.strictEqual(M.wrapLon(181), -179);
  assert.strictEqual(M.wrapLon(-181), 179);
  assert.strictEqual(M.wrapLon(540), -180, '540 degrees is the date line');
  const crossing = M.advect({ lat: 0, lon: 179.9, u: 60, v: 0 }, 3600);
  assert.ok(crossing.lon < 0, 'crossed the date line instead of exceeding 180');
  const polar = M.advect({ lat: 74, lon: 0, u: 0, v: 200 }, 10800);
  assert.ok(Math.abs(polar.lat) <= 85, 'latitude clamped away from the pole');
});

s.test('timestamps are validated, not merely pattern matched', () => {
  assert.strictEqual(M.timeISO('20260916.190000'), '2026-09-16T19:00:00Z');
  assert.strictEqual(M.timeISO('20260916_190000'), '2026-09-16T19:00:00Z');
  assert.strictEqual(M.timeISO('20260931.190000'), null, 'September 31 does not exist');
  assert.strictEqual(M.timeISO('2026-09-16T19:00:00Z'), null);
  assert.strictEqual(M.timeISO(''), null);
});

s.test('stale and malformed observations are discarded', () => {
  const feature = (props, lon, lat) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: props
  });
  const good = { DAY: '2026-09-16', TIME: '19:00:00', SPD: '30', DIR: '270', PRE: '850' };
  const collection = {
    type: 'FeatureCollection',
    features: [
      feature(good, 10, 10),
      feature({ ...good, DAY: '2026-09-16', TIME: '18:00:00' }, 12, 10),  // older sweep
      feature({ ...good, SPD: '' }, 14, 10),                              // blank speed
      feature({ ...good, DIR: '400' }, 16, 10),                           // impossible direction
      feature({ ...good, PRE: '700' }, 18, 10),                           // wrong pressure band
      feature({ ...good, SPD: '900' }, 20, 10),                           // impossible speed
      { type: 'Feature', geometry: null, properties: good }               // no geometry
    ]
  };
  const result = M.normalize(collection, 'AMV-LLlow', '20260916.190000');
  assert.strictEqual(result.matching, 1, 'only the exact-time record counts');
  assert.strictEqual(result.old, 1, 'the earlier sweep is excluded, not relabeled');
  assert.strictEqual(result.invalid, 5);
  assert.strictEqual(result.points.length, 1);
  assert.strictEqual(result.points[0].product, 'AMV-LLlow');
  near(result.points[0].u, 30 * M.KNOT_MPS, 1e-9, 'eastward component');
  assert.throws(() => M.normalize(collection, 'AMV-LLlow', '20260916.200000'),
    /有効な観測風がありません/, 'a time with no matching observation is an error');
  assert.throws(() => M.normalize({}, 'AMV-LLlow', '20260916.190000'), /形式が不正/);
});

s.test('one observed vector is kept per 2-degree cell', () => {
  const props = { DAY: '2026-09-16', TIME: '19:00:00', SPD: '20', DIR: '90', PRE: '900' };
  const collection = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [10.1, 10.1] }, properties: props },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [10.9, 10.9] }, properties: props },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [12.1, 10.1] }, properties: props }
    ]
  };
  const result = M.normalize(collection, 'AMV-LLlow', '20260916.190000');
  assert.strictEqual(result.matching, 3);
  assert.strictEqual(result.points.length, 2, 'two cells, two representatives');
});

s.test('the bundled snapshot validates and stays finite for three hours', () => {
  const file = path.join(__dirname, '..', 'dist', 'data', 'amv.json');
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  M.validateBundle(bundle);
  assert.ok(M.timeISO(bundle.time), 'bundled observation time is a real time');
  assert.ok(bundle.points.length > 0, 'bundle has tracers');
  for (const point of bundle.points) {
    for (const seconds of [0, 5400, 10800]) {
      const moved = M.advect(point, seconds);
      assert.ok(Number.isFinite(moved.lat) && Number.isFinite(moved.lon),
        'non-finite position at ' + seconds + 's from ' + point.lat + ',' + point.lon);
      assert.ok(Math.abs(moved.lat) <= 85.0001 && Math.abs(moved.lon) <= 180.0001,
        'left the globe at ' + seconds + 's');
    }
  }
  console.log('       ' + bundle.points.length + ' bundled vectors advected to 3 h');
});

s.test('a tampered bundle is rejected', () => {
  const base = {
    time: '20260916.190000',
    points: [{ lat: 10, lon: 20, knots: 30, from: 270, pressure: 850,
      ...M.windComponents(30, 270), altitudeKm: M.pressureHeight(850), product: 'AMV-LLlow' }]
  };
  M.validateBundle(base);
  const wrongUnits = JSON.parse(JSON.stringify(base));
  wrongUnits.points[0].u = 30;  // knots left unconverted
  assert.throws(() => M.validateBundle(wrongUnits), /単位が一致しません/);
  const wrongTime = JSON.parse(JSON.stringify(base));
  wrongTime.time = 'yesterday';
  assert.throws(() => M.validateBundle(wrongTime), /観測風を確認できません/);
});

s.run();
