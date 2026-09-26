'use strict';
// The typhoon object (dist/typhoon.js) and what builds and scores it
// (scripts/build-typhoon.cjs, scripts/hindcast-typhoon.cjs).
//
// The real record (IBTrACS) cannot be downloaded here, so the behaviour is checked on a
// made-up world whose answer is known: storms that run west-north-west in the tropics
// and north-east once past 28 degrees. Whether the model does well on real storms is
// what the backtest in .github/workflows/typhoon-model.yml measures.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./harness.cjs');
const { TyphoonModel, betaDrift, decodeBits, followForecast, distanceKm } = require('../dist/typhoon.js');
const B = require('../scripts/build-typhoon.cjs');
const H = require('../scripts/hindcast-typhoon.cjs');

const ROOT = path.resolve(__dirname, '..');
const s = suite('typhoon');
const LAND = B.landMask();

/// A world where the answer is known. West-moving storms: easterlies in the tropics that
/// weaken and turn poleward towards 28 degrees. East-moving (recurved): north-east and
/// fast. Stronger over warm tropical water, weaker beyond 30 degrees.
function madeUpModel(extra = {}) {
  const cell = 2.5, cols = 144;
  const west = [], east = [], all = [], intensity = [];
  for (let row = 0; row < 72; row++) {
    const lat = -90 + (row + 0.5) * cell;
    if (Math.abs(lat) > 60) continue;
    const a = Math.abs(lat), pole = lat >= 0 ? 1 : -1;
    const wu = a < 22 ? -18 : a < 28 ? -18 + (a - 22) * 3.5 : 6;
    const wv = pole * (a < 22 ? 6 : 12);
    for (let col = 0; col < cols; col++) {
      west.push(row, col, wu, wv, 100);
      east.push(row, col, 25, pole * 12, 100);
      all.push(row, col, (wu + 25) / 2, wv, 200);
      for (let cls = 0; cls < 3; cls++) intensity.push(row, col, cls, a < 20 ? 2 : a < 30 ? -4 : -12, 50);
    }
  }
  return new TyphoonModel(Object.assign({
    params: { tau: 12 },
    motion: { cell, west, east, all },
    intensity: { cell, cells: intensity, fallback: -4 },
    land: LAND,
  }, extra));
}

s.test('the beta drift points poleward and west in both hemispheres', () => {
  const north = betaDrift(20), south = betaDrift(-20);
  assert.ok(north.u < 0 && north.v > 0, 'north-west in the north');
  assert.ok(south.u < 0 && south.v < 0, 'south-west in the south');
  assert.ok(Math.abs(Math.hypot(north.u, north.v) - 7.2) < 1e-9, 'about 2 m/s');
});

s.test('the land is where the land is', () => {
  const model = madeUpModel();
  assert.ok(model.isLand(35.7, 139.7), 'Tokyo');
  assert.ok(model.isLand(23, 10), 'the Sahara');
  assert.ok(!model.isLand(30, 140), 'south of Japan');
  assert.ok(!model.isLand(0, -150), 'the middle of the Pacific');
  const bits = decodeBits(Buffer.from([0b10100000]).toString('base64'), 4);
  assert.deepStrictEqual([...bits], [1, 0, 1, 0]);
});

s.test('a storm in the northern tropics runs west, turns, and leaves north-east', () => {
  // Far enough east that it turns over open sea: started further west, the same storm
  // reaches Taiwan before the turning zone and dies over land, which is also right. The
  // sea neither feeds nor starves it here - this is about the turn, not the strength.
  const flat = [];
  for (let row = 0; row < 72; row++) for (let col = 0; col < 144; col++) for (let c = 0; c < 3; c++) flat.push(row, col, c, 0, 50);
  const run = madeUpModel({ intensity: { cell: 2.5, cells: flat } }).run({ lat: 18, lon: 160, kt: 90, u: -18, v: 6 });
  const p = run.points;
  const at = t => p[Math.min(t, p.length - 1)];
  assert.ok(at(24).lon < 160, 'it goes west first');
  const westmost = p.reduce((m, q) => (q.lon < m.lon ? q : m));
  assert.ok(westmost.t > 24 && westmost.lat > 22, `it turns in the turning zone (at ${westmost.lat.toFixed(1)}N)`);
  assert.ok(p[p.length - 1].lon > westmost.lon + 3, 'and ends up well east of where it turned');
  assert.strictEqual(p[p.length - 1].regime, 'east', 'moving as recurved storms do');
  assert.ok(p.every(q => q.lat > 0), 'it never reaches the equator');
  const switches = p.filter((q, i) => i && q.regime !== p[i - 1].regime).length;
  assert.ok(switches <= 2, `the regime does not flicker (${switches} switches)`);
});

s.test('in the southern hemisphere the same storm goes the other way round', () => {
  const run = madeUpModel().run({ lat: -14, lon: 80, kt: 90, u: -18, v: -6 });
  assert.ok(run.points.every(q => q.lat < 0), 'it never crosses the equator');
  assert.ok(run.points[run.points.length - 1].lat < -20, 'it moves towards the south pole');
});

s.test('over land it dies within about a day, as Kaplan and DeMaria have it', () => {
  // Nearly stationary over central Honshu, so the decay is all there is.
  const cell = 2.5, still = [];
  for (let row = 0; row < 72; row++) for (let col = 0; col < 144; col++) still.push(row, col, 0.1, 0.1, 100);
  const model = madeUpModel({ motion: { cell, west: still, east: still, all: still } });
  assert.ok(model.isLand(36, 138.5), 'the start is on land');
  const run = model.run({ lat: 36, lon: 138.5, kt: 100, u: 0, v: 0 });
  assert.strictEqual(run.end.reason, 'weakened');
  assert.ok(run.end.t > 12 && run.end.t < 36, `below 34 kt after ${run.end.t} h`);
  assert.ok(run.points[6].kt < 80, 'most of the wind goes in the first hours');
});

s.test('over warm sea it strengthens, over cold sea it fades and ends', () => {
  const model = madeUpModel();
  const run = model.run({ lat: 12, lon: 160, kt: 70, u: -18, v: 6 });
  const peak = Math.max(...run.points.map(q => q.kt));
  assert.ok(peak > 70, `it grows in the tropics (to ${peak.toFixed(0)} kt)`);
  assert.ok(['weakened', 'left the tropics', 'left the record'].includes(run.end.reason), run.end.reason);
  assert.ok(run.end.t < 360, 'and it does end');
});

s.test('it ends where past storms ended', () => {
  // A band at 30-40N where one storm in ten ends each hour: the object gets about seven
  // hours in (half-life) and stops, well before any wind limit.
  const hazard = [];
  for (let row = 0; row < 72; row++) {
    const lat = -90 + (row + 0.5) * 2.5;
    for (let col = 0; col < 144; col++) hazard.push(row, col, lat > 30 && lat < 40 ? 0.1 : 0, 100);
  }
  const model = madeUpModel({ hazard: { cell: 2.5, cells: hazard } });
  const run = model.run({ lat: 31, lon: 160, kt: 120, u: 25, v: 12 });
  assert.strictEqual(run.end.reason, 'as storms here end');
  assert.ok(run.end.t >= 5 && run.end.t <= 9, `after ${run.end.t} h`);
  assert.ok(run.points[run.points.length - 1].kt > 60, 'while still strong');
});

s.test('it never lives on the equator', () => {
  // A made-up world that pushes everything towards the equator.
  const cell = 2.5, south = [];
  for (let row = 0; row < 72; row++) for (let col = 0; col < 144; col++) south.push(row, col, -10, -30, 100);
  const model = madeUpModel({ motion: { cell, west: south, east: south, all: south } });
  const run = model.run({ lat: 12, lon: 150, kt: 90, u: -10, v: -30 });
  assert.strictEqual(run.end.reason, 'reached the equator');
  assert.ok(run.points.every(q => q.lat >= 4), 'it stops before 4 degrees');
});

s.test('an object it has no record for ends rather than guessing', () => {
  const model = new TyphoonModel({ motion: { cell: 2.5, west: [], east: [], all: [] }, land: LAND });
  const run = model.run({ lat: 15, lon: 140, kt: 80, u: -10, v: 5 });
  assert.strictEqual(run.end.reason, 'left the record');
  assert.strictEqual(run.points.length, 1);
});

/// A best-track file in IBTrACS's shape, for storms that follow the made-up world. Three-
/// hourly, as the real file is: anything that counts points instead of hours breaks here.
function madeUpTracks(count = 400) {
  const head = 'SID,SEASON,NUMBER,BASIN,SUBBASIN,NAME,ISO_TIME,NATURE,LAT,LON,WMO_WIND,DIST2LAND,USA_WIND';
  const lines = [head, ' ,Year, , , , , , ,degrees_north,degrees_east,kts,km,kts'];
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let n = 0; n < count; n++) {
    const season = 1980 + (n % 40);
    let lat = 10 + rand() * 8, lon = 135 + rand() * 25, kt = 40 + rand() * 20, east = false;
    const t0 = Date.UTC(season, 7, 1) + n * 3600000;
    for (let k = 0; k < 80; k++) {
      const a = Math.abs(lat);
      let u = a < 22 ? -18 : a < 28 ? -18 + (a - 22) * 3.5 : 6, v = a < 22 ? 6 : 12;
      if (east || u > 2) { east = true; u = 25; v = 12; }
      const nature = k > 60 ? 'ET' : 'TS';
      const time = new Date(t0 + k * 3 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
      lines.push([`S${n}`, season, n, 'WP', 'MM', 'X', time, nature, lat.toFixed(2), lon.toFixed(2),
        '', 500, kt.toFixed(0)].join(','));
      lat += v * 3 / 111.195;
      lon += u * 3 / (111.195 * Math.cos(lat * Math.PI / 180));
      kt += a < 20 ? 3 : -4;
    }
  }
  return lines.join('\n') + '\n';
}

s.test('the builder recovers the motion of the storms it was given', () => {
  const storms = B.parseTracks(madeUpTracks());
  assert.strictEqual(storms.length, 400);
  const data = B.buildModel(storms, { land: LAND });
  const model = new TyphoonModel(data);
  const tropics = model.motionAt(14, 145, 'all');
  assert.ok(tropics && Math.abs(tropics.u + 18) < 3 && Math.abs(tropics.v - 6) < 3,
    `storms at 14N run west-north-west (${JSON.stringify(tropics)})`);
  const zone = [22.5, 25, 27.5, 30, 32.5].map(lat => model.motionAt(lat, 142, 'all'));
  assert.ok(zone[0].u < 0 && zone[zone.length - 1].u > 2,
    `and all storms together turn east going north (${zone.map(z => z.u.toFixed(0)).join(' → ')})`);
  const turned = model.motionAt(35, 150, 'east');
  assert.ok(turned && turned.u > 15 && turned.v > 5, `recurved storms run north-east (${JSON.stringify(turned)})`);
  assert.ok(data.intensity.cells.length > 0, 'strength changes were measured');
  const warm = model.intensityChangeAt(14, 145, 50);
  assert.ok(warm > 0, `and they strengthened in the tropics (${warm} kt per 6 h)`);
});

s.test('the backtest picks storms at typhoon strength and knows when they ended', () => {
  const storms = B.parseTracks(madeUpTracks(40));
  const found = H.starts(storms, 1980, 2100);
  assert.ok(found.length > 0, 'there are starts');
  for (const c of found) {
    assert.ok(c.init.kt >= 64, 'each at 64 kt or more');
    assert.ok(c.end >= c.points[c.i].t, 'ending after it starts');
  }
  const pts = storms[0].points;
  const end = H.trueEnd(pts, 0);
  const at = pts.findIndex(p => p.t === end);
  assert.ok(pts[at].nature === 'ET' || pts[at].kt < 34 || at === pts.length - 1,
    'the end is where it went extratropical, fell below 34 kt, or the record stops');
  const straight = H.persistence({ init: { lat: 20, lon: 140, kt: 80, u: 0, v: 11.1195 } });
  assert.ok(Math.abs(straight.points[10].lat - 21) < 0.01, 'persistence carries straight on');
});

s.test('the bundled model, when there is one, is whole', () => {
  const file = path.join(ROOT, 'dist', 'data', 'typhoon.json');
  if (!fs.existsSync(file)) return;   // written by .github/workflows/typhoon-model.yml
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const regime of ['east', 'all']) {
    assert.ok(data.motion[regime].length > 500, `a ${regime} motion grid`);
  }
  assert.ok(data.intensity.cells.length > 500, 'a strength grid');
  assert.ok(/^[0-9a-f]{64}$/.test(data.source.sha256), 'the track file it came from, by digest');
  assert.ok(data.params.tau >= 0 && data.params.alpha > 0, 'its parameters');
  const model = new TyphoonModel(data);
  const run = model.run({ lat: 18, lon: 135, kt: 100, u: -15, v: 5 });
  assert.ok(run.points.length > 24, 'a typhoon east of the Philippines lasts more than a day');
  assert.ok(run.points.every(p => p.lat > 0), 'and stays north of the equator');
});

// Following an issued forecast (the Japan Meteorological Agency's). Made up in the shape
// scripts/fetch-jma-typhoon.cjs writes: an analysis and forecast centres at 12, 24, 48
// and 120 hours.
const FORECAST = { points: [
  { time: '2026-09-26T00:00:00Z', kind: 'analysis', lat: 21.5, lon: 126.8, windKt: 50, class: '台風（ＴＳ）' },
  { time: '2026-09-26T12:00:00Z', kind: 'forecast', lat: 22.4, lon: 126.2, windKt: 60, class: '台風（ＳＴＳ）' },
  { time: '2026-09-27T00:00:00Z', kind: 'forecast', lat: 23.3, lon: 126.0, windKt: 65, class: '台風（ＴＹ）' },
  { time: '2026-09-28T00:00:00Z', kind: 'forecast', lat: 25.0, lon: 126.5, windKt: 70, class: '台風（ＴＹ）' },
  { time: '2026-10-01T00:00:00Z', kind: 'forecast', lat: 31.0, lon: 133.0, windKt: 65, class: '台風（ＴＹ）' },
] };
const START = Date.parse('2026-09-25T20:00:00Z');   // four hours before the analysis

s.test('a forecast is followed through every forecast centre, smoothly and hour by hour', () => {
  const run = followForecast(FORECAST, START, { seen: { lat: 21.3, lon: 127.0 } });
  assert.ok(run, 'the forecast covers the start');
  for (const p of FORECAST.points) {
    const h = (Date.parse(p.time) - START) / 3600000, at = run.points[h];
    if (h >= 12) assert.ok(distanceKm(at, p) < 1, `${h} h: ${at.lat.toFixed(2)}, ${at.lon.toFixed(2)}`);
    assert.ok(Math.abs(at.kt - p.windKt) < 1e-9);
  }
  // Starts where the storm was seen, and eases onto the forecast over twelve hours without
  // overshooting it: seen a hundred kilometres south of the analysis, it never runs past it.
  assert.ok(distanceKm(run.points[0], { lat: 21.3, lon: 127.0 }) < 1);
  for (let t = 1; t <= 12; t++) assert.ok(run.points[t].lat >= run.points[t - 1].lat, `northward all the way, ${t} h`);
  // No hour jumps: the path is smooth, never more than a day's worth of the fastest leg in an hour.
  for (let i = 1; i < run.points.length; i++) assert.ok(distanceKm(run.points[i - 1], run.points[i]) < 60);
  assert.deepStrictEqual(run.knotHours, [4, 16, 28, 52, 124]);
  assert.strictEqual(run.forecastHours, 124);
  assert.strictEqual(run.end.reason, 'the forecast ends', 'with no model, it ends with the forecast');
});

s.test('seen nowhere near, it starts on the way the forecast was going', () => {
  const run = followForecast(FORECAST, START);
  const back = run.points[0];
  // Four hours before the analysis, back along the first twelve-hour leg.
  assert.ok(back.lat < 21.5 && back.lon > 126.8, `${back.lat}, ${back.lon}`);
  assert.ok(distanceKm(back, FORECAST.points[0]) < 50);
});

s.test('observations newer than the forecast start part way along it', () => {
  const run = followForecast(FORECAST, Date.parse('2026-09-27T00:00:00Z'));
  assert.ok(distanceKm(run.points[0], FORECAST.points[2]) < 1);
  assert.strictEqual(run.forecastHours, 96);
});

s.test('a forecast that does not cover the start is not used', () => {
  assert.strictEqual(followForecast(FORECAST, Date.parse('2026-09-30T20:00:00Z')), null, 'ends within 12 hours');
  assert.strictEqual(followForecast(FORECAST, Date.parse('2026-09-24T12:00:00Z')), null, 'begins more than a day later');
  assert.strictEqual(followForecast({ points: [FORECAST.points[0]] }, START), null);
});

s.test('past the last forecast hour a typhoon carries on by the record; a depression ends', () => {
  const model = madeUpModel();
  const on = followForecast(FORECAST, START, { model });
  assert.ok(on.points.length > 125 && on.end.t > 124, `ended at ${on.end.t}`);
  for (let i = 125; i < on.points.length; i++) assert.strictEqual(on.points[i].t, i);
  assert.ok(distanceKm(on.points[124], on.points[125]) < 80, 'no jump where the forecast hands over');
  const weak = { points: FORECAST.points.map((p, i) => i === 4 ? Object.assign({}, p, { class: '熱帯低気圧（ＴＤ）', windKt: 30 }) : p) };
  const off = followForecast(weak, START, { model });
  assert.strictEqual(off.end.t, 124);
  assert.strictEqual(off.end.reason, 'the forecast ends');
});

s.test('a path over the date line does not swing round the earth', () => {
  const f = { points: [
    { time: '2026-09-26T00:00:00Z', lat: 30, lon: 178, windKt: 60, class: '台風（ＳＴＳ）' },
    { time: '2026-09-27T00:00:00Z', lat: 33, lon: -178, windKt: 60, class: '台風（ＳＴＳ）' },
  ] };
  const run = followForecast(f, Date.parse('2026-09-26T00:00:00Z'));
  for (let i = 1; i < run.points.length; i++) assert.ok(distanceKm(run.points[i - 1], run.points[i]) < 60);
  assert.ok(Math.abs(run.points[12].lon) > 179, `half way at ${run.points[12].lon}`);
});

s.run();
