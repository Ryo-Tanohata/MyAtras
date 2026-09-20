'use strict';
// scripts/build-tendency.cjs: where tropical cyclones have gone, from the best track record.
//
// The archive is a few hundred megabytes and is not in the repository, so the reading is
// checked against a small made-up track file with known answers, and the grid that ships
// is checked against the thing it claims to have measured: the pattern every textbook
// draws. If the bundled grid ever stops saying that storms run west under the subtropical
// ridge and north-east once the westerlies have them, something has gone wrong with it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite } = require('./harness.cjs');
const tendency = require('../scripts/build-tendency.cjs');

const HEAD = 'SID,SEASON,NUMBER,BASIN,SUBBASIN,NAME,ISO_TIME,NATURE,LAT,LON,USA_WIND';
const UNITS = ' ,Year, , , , , , ,degrees_north,degrees_east,kts';

/// A track file in IBTrACS' shape: rows of [sid, season, time, nature, lat, lon, wind].
function csv(rows) {
  return [HEAD, UNITS].concat(rows.map(r =>
    `${r.sid},${r.season},1,WP,MM,TEST,${r.time},${r.nature},${r.lat},${r.lon},${r.wind || 40}`)).join('\n');
}

/// Six-hourly points running due west at a known pace.
function westward(sid, season, nature, hours = 24, lat = 15, lon = 140) {
  const rows = [];
  for (let h = 0; h <= hours; h += 6) {
    const when = new Date(Date.UTC(season, 8, 1, h)).toISOString().slice(0, 19).replace('T', ' ');
    rows.push({ sid, season, time: when, nature, lat, lon: lon - h * 0.25 });
  }
  return rows;
}

const s = suite('build-tendency');

s.test('a known heading and pace come back', () => {
  const { legs, storms } = tendency.legs(csv(westward('A', 2000, 'TS')));
  assert.strictEqual(storms, 1);
  assert.strictEqual(legs.length, 4);
  for (const leg of legs) {
    assert.ok(Math.abs(tendency.turn(leg.bearing, 270)) < 1, `due west, was ${leg.bearing}`);
    // 1.5 degrees of longitude every 6 hours, at 15 N.
    const want = 1.5 * 111.195 * Math.cos(15 * Math.PI / 180) / 6;
    assert.ok(Math.abs(leg.speed - want) < 1, `about ${want.toFixed(1)} km/h, was ${leg.speed.toFixed(1)}`);
  }
});

// A storm that has gone extratropical is steered as a midlatitude low. Leaving those in
// would mix a different picture into the one this is trying to measure.
s.test('only the tropical stage is counted', () => {
  const mixed = csv(westward('A', 2000, 'TS').concat(westward('B', 2000, 'ET')));
  const { legs, storms } = tendency.legs(mixed);
  assert.strictEqual(storms, 1, 'the extratropical track is not a storm here');
  assert.strictEqual(legs.length, 4);
});

s.test('tracks from before the satellite era are left out', () => {
  const old = csv(westward('A', tendency.FROM_SEASON - 5, 'TS'));
  assert.strictEqual(tendency.legs(old).legs.length, 0);
  assert.ok(tendency.legs(csv(westward('A', tendency.FROM_SEASON, 'TS'))).legs.length > 0);
});

// A break in a track is a break, not a leg: joining the two ends would invent a heading
// and a pace that no storm had.
s.test('a gap in a track does not become a leg', () => {
  const rows = [
    { sid: 'A', season: 2000, time: '2000-09-01 00:00:00', nature: 'TS', lat: 15, lon: 140 },
    { sid: 'A', season: 2000, time: '2000-09-01 06:00:00', nature: 'TS', lat: 15, lon: 139.5 },
    { sid: 'A', season: 2000, time: '2000-09-03 06:00:00', nature: 'TS', lat: 16, lon: 135 },
  ];
  assert.strictEqual(tendency.legs(csv(rows)).legs.length, 1, 'the two-day gap is not crossed');
});

s.test('a storm that stalled says nothing about heading', () => {
  const rows = [
    { sid: 'A', season: 2000, time: '2000-09-01 00:00:00', nature: 'TS', lat: 15, lon: 140 },
    { sid: 'A', season: 2000, time: '2000-09-01 06:00:00', nature: 'TS', lat: 15, lon: 140 },
  ];
  assert.strictEqual(tendency.legs(csv(rows)).legs.length, 0);
});

// Headings are angles. Averaged as plain numbers, 350 and 10 give 180 - the opposite way.
s.test('headings either side of north average to north', () => {
  assert.strictEqual(Math.round(tendency.medianBearing([350, 0, 10])), 0);
  // An even count takes the upper middle, so this lands a few degrees off north rather
  // than on it. What matters is that it is not 180, which is where treating headings as
  // plain numbers would put it.
  const even = tendency.medianBearing([350, 355, 5, 10]);
  assert.ok(Math.abs(tendency.turn(even, 0)) < 10, `near north, was ${even.toFixed(0)}`);
});

s.test('a cell without enough storms says nothing rather than guessing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myatras-tendency-'));
  try {
    const file = path.join(dir, 'tracks.csv');
    fs.writeFileSync(file, csv(westward('A', 2000, 'TS', 120)));
    const out = tendency.build(file, path.join(dir, 'out.json'));
    assert.strictEqual(Object.keys(out.cells).length, 0,
      `one storm is not a tendency, got ${Object.keys(out.cells).length} cells`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

s.test('the grid reads back at the place it was measured', () => {
  const grid = require('../dist/data/tendency.json');
  assert.ok(tendency.tendencyAt(grid, 12.5, 132.5), 'east of the Philippines is covered');
  assert.strictEqual(tendency.tendencyAt(grid, 0, 0), null, 'the Gulf of Guinea has no cyclones');
  assert.strictEqual(tendency.tendencyAt(grid, 75, 20), null, 'and neither does the Arctic');
});

// What the grid is for. These are not thresholds tuned to make a test pass: they are the
// general circulation, and a grid that disagreed with them would be wrong.
s.test('the bundled grid shows storms running west in the deep tropics', () => {
  const grid = require('../dist/data/tendency.json');
  for (const [where, lat, lon] of [['north-west Pacific', 12.5, 132.5],
    ['Atlantic', 15.0, -50.0], ['east Pacific', 12.5, -110.0]]) {
    const t = tendency.tendencyAt(grid, lat, lon);
    assert.ok(t, `${where} is covered`);
    assert.ok(Math.abs(tendency.turn(t.bearing, 285)) < 45,
      `${where} runs west-north-west, was ${t.bearing.toFixed(0)}`);
  }
});

s.test('and turning back east once the westerlies have them', () => {
  const grid = require('../dist/data/tendency.json');
  const t = tendency.tendencyAt(grid, 37.5, 147.5);
  assert.ok(t, 'east of Japan is covered');
  assert.ok(t.bearing > 0 && t.bearing < 90, `north-east, was ${t.bearing.toFixed(0)}`);
  const tropics = tendency.tendencyAt(grid, 12.5, 132.5);
  assert.ok(t.speed > tropics.speed,
    `and faster than in the tropics, ${t.speed} against ${tropics.speed}`);
});

// The spread is the point of the thing. Through the turn, storms disagree; a grid that
// reported them agreeing would be hiding what it does not know.
s.test('the turn is recorded as less settled than the tropics', () => {
  const grid = require('../dist/data/tendency.json');
  const width = t => t.band50[1] - t.band50[0];
  const tropics = tendency.tendencyAt(grid, 12.5, 132.5);
  const turning = tendency.tendencyAt(grid, 27.5, 137.5);
  assert.ok(width(turning) > width(tropics),
    `wider through the turn: ${width(turning)} against ${width(tropics)}`);
  for (const t of [tropics, turning]) {
    assert.ok(t.band50[0] <= 0 && t.band50[1] >= 0, 'the spread straddles the middle');
    assert.ok(t.band80[0] <= t.band50[0] && t.band80[1] >= t.band50[1], 'and widens with it');
  }
});

s.run();
