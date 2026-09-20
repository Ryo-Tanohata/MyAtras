'use strict';
// dist/storms.js: what the globe draws for the storms found in the observations.
//
// The drawing itself needs a WebGL context and is checked in a real browser by
// tools/check-webgl.cjs. What is checked here is the part that decides what may be drawn
// at all, which is where this could quietly start claiming more than it knows: a centre
// is shown for an observation the storm was found in and for no other time, the trail
// holds only where the storm has already been, and a bundle that will not load leaves the
// globe bare rather than throwing or inventing something.
const assert = require('assert');
const { suite } = require('./harness.cjs');
const { StormTrack, StormOutlook } = require('../dist/storms.js');

const AT = (time, lat, lon, circ = 2.4) => ({ time, lat, lon, circ });

function bundle(storms) {
  return { method: 'test', storms };
}

/// A fresh track over a given bundle. The loader caches on the global the page uses, so
/// each case clears it first.
async function track(value) {
  delete globalThis.GEO_STORMS;
  if (value !== undefined) globalThis.GEO_STORMS = value;
  const t = new StormTrack();
  await t.load();
  delete globalThis.GEO_STORMS;
  return t;
}

const ONE = bundle([{
  from: '20260917.050000', to: '20260917.080000',
  points: [
    AT('20260917.050000', 20.9, 149.8),
    AT('20260917.060000', 21.1, 149.6),
    AT('20260917.070000', 21.4, 149.3),
    AT('20260917.080000', 21.6, 149.1),
  ],
}]);

const s = suite('storms');

s.test('the centre of an observation the storm was found in is shown', async () => {
  const t = await track(ONE);
  const found = t.at('20260917.070000');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].centre.lat, 21.4);
  assert.strictEqual(found[0].centre.lon, 149.3);
});

// The hour between two observations is not an observation. Interpolating a centre into it
// would be inventing a position, which is the one thing this must not do.
s.test('a time between two observations is not marked', async () => {
  const t = await track(ONE);
  assert.deepStrictEqual(t.at('20260917.063000'), []);
});

// And neither is the hour after the last one: there is no forecast here.
s.test('a time past the last observation is not marked', async () => {
  const t = await track(ONE);
  assert.deepStrictEqual(t.at('20260917.090000'), []);
  assert.deepStrictEqual(t.at('20260920.040000'), []);
});

s.test('the trail holds where the storm has been, and nothing later', async () => {
  const t = await track(ONE);
  const { trail } = t.at('20260917.070000')[0];
  assert.deepStrictEqual(trail.map(p => p.time),
    ['20260917.050000', '20260917.060000', '20260917.070000']);
});

s.test('the first observation has a trail of just itself', async () => {
  const t = await track(ONE);
  assert.strictEqual(t.at('20260917.050000')[0].trail.length, 1);
});

// An observation in the middle that the storm was not found in draws nothing, rather than
// bridging the gap from the hours either side of it.
s.test('a gap in the middle of a track is left unmarked', async () => {
  const t = await track(bundle([{
    from: '20260918.200000', to: '20260919.000000',
    points: [
      AT('20260918.200000', 26.0, 141.0),
      AT('20260919.000000', 26.6, 140.2),
    ],
  }]));
  assert.deepStrictEqual(t.at('20260918.220000'), []);
  assert.strictEqual(t.at('20260919.000000').length, 1);
});

s.test('two storms at one time are two marks', async () => {
  const t = await track(bundle([
    { points: [AT('20260917.050000', 20.9, 149.8), AT('20260917.060000', 21.1, 149.6)] },
    { points: [AT('20260917.050000', 16.0, -60.0), AT('20260917.060000', 16.3, -60.4)] },
  ]));
  const found = t.at('20260917.060000');
  assert.strictEqual(found.length, 2);
  assert.ok(found.some(f => f.centre.lon < 0), 'the one in the Atlantic is kept as it is');
});

// A file that is missing, empty or malformed must leave the globe bare. Nothing about a
// storm is worth failing the page the observations are already drawn on.
s.test('a bundle that will not load leaves the globe bare', async () => {
  for (const value of [null, {}, { storms: null }, { storms: [{ points: [] }] },
    { storms: [{ points: [AT('not a time', 1, 2)] }] }]) {
    const t = await track(value);
    assert.deepStrictEqual(t.storms, [], `nothing from ${JSON.stringify(value)}`);
    assert.deepStrictEqual(t.at('20260917.050000'), []);
  }
});

// A track of one point cannot show a storm going anywhere, and one bad time should not
// shorten a track that is otherwise sound.
s.test('a single-point track is dropped, a single bad time is not', async () => {
  const one = await track(bundle([{ points: [AT('20260917.050000', 20, 149)] }]));
  assert.deepStrictEqual(one.storms, []);
  const mixed = await track(bundle([{ points: [
    AT('20260917.050000', 20.9, 149.8), AT('rubbish', 0, 0), AT('20260917.060000', 21.1, 149.6),
  ] }]));
  assert.strictEqual(mixed.storms.length, 1);
  assert.strictEqual(mixed.storms[0].points.length, 2);
});

s.test('the bundled storms are the ones the page will draw', async () => {
  const bundled = require('../dist/data/storms.json');
  const t = await track(bundled);
  assert.strictEqual(t.storms.length, bundled.storms.length);
  for (const storm of t.storms) {
    for (const p of storm.points) {
      assert.strictEqual(t.at(p.time).length > 0, true, `${p.time} is drawable`);
    }
  }
});

// The outlook is the one thing here that goes past what was observed, so what it may not
// do matters more than what it does.
async function outlook(grid){
  delete globalThis.GEO_TENDENCY;
  if (grid !== undefined) globalThis.GEO_TENDENCY = grid;
  const o = new StormOutlook();
  await o.load();
  delete globalThis.GEO_TENDENCY;
  return o;
}

s.test('only the last observation of a track is marked as the last', async () => {
  const t = await track(ONE);
  const times = ['20260917.050000', '20260917.060000', '20260917.070000', '20260917.080000'];
  const flags = times.map(x => t.at(x)[0].last);
  assert.deepStrictEqual(flags, [false, false, false, true]);
});

s.test('the outlook turns with the record, west in the tropics and north-east beyond', async () => {
  const o = await outlook(require('../dist/data/tendency.json'));
  const tropics = o.ahead(12.5, 132.5, 24);
  const first = tropics.middle[0];
  assert.ok(first.lon < 132.5, `heads west from the tropics, went to ${first.lon.toFixed(1)}`);
  const turning = o.ahead(29.2, 137.5, 48);
  const end = turning.middle[turning.middle.length - 1];
  assert.ok(end.lat > 34 && end.lon > 137.5,
    `recurves north-east near Japan, ended ${end.lat.toFixed(1)}N ${end.lon.toFixed(1)}E`);
});

// The fan is the honest part. Through the turn past storms disagreed far more than they
// did in the tropics, and the drawing has to show that.
s.test('the fan is wider through the turn than in the tropics', async () => {
  const o = await outlook(require('../dist/data/tendency.json'));
  assert.ok(o.ahead(29.2, 137.5).spread > o.ahead(12.5, 132.5).spread);
});

s.test('the outlook stops where the record does', async () => {
  const o = await outlook(require('../dist/data/tendency.json'));
  assert.strictEqual(o.ahead(0, 0), null, 'the Gulf of Guinea has no cyclones to average');
  assert.strictEqual(o.ahead(75, 20), null, 'and neither does the Arctic');
  const far = o.ahead(40, 150, 240);
  assert.ok(far.middle.every(p => Math.abs(p.lat) <= 70), 'and it does not run to the pole');
});

s.test('no grid means no outlook, not a guess', async () => {
  for (const value of [null, {}, { cells: null }, { cells: {} }]) {
    const o = await outlook(value);
    assert.strictEqual(o.grid, null, `nothing from ${JSON.stringify(value)}`);
    assert.strictEqual(o.ahead(29.2, 137.5), null);
  }
});

s.run();
