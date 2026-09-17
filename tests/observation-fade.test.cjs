'use strict';
// The dissolve between two consecutive observations: when it runs, how long, and
// that it never runs where there is nothing observed to fade from.
const assert = require('assert');
const { suite } = require('./harness.cjs');
const { ObservationFade } = require('../dist/observation-fade.js');

const s = suite('observation-fade');

s.test('the first observation appears at once', () => {
  const fade = new ObservationFade(400);
  fade.start(1000, false);
  assert.strictEqual(fade.value(1000), 1, 'there is no earlier observation to come from');
  assert.ok(!fade.active);
});

s.test('a later observation fades in over the duration', () => {
  const fade = new ObservationFade(400);
  fade.start(1000);
  assert.strictEqual(fade.value(1000), 0, 'it starts on the observation already shown');
  assert.strictEqual(fade.value(1200), 0.5);
  assert.ok(fade.active, 'and both observations are on screen until it finishes');
  assert.strictEqual(fade.value(1400), 1);
  assert.ok(!fade.active);
});

s.test('it stays finished once it is finished', () => {
  const fade = new ObservationFade(400);
  fade.start(1000);
  fade.value(5000);
  assert.strictEqual(fade.value(1200), 1, 'time never runs backwards into a past dissolve');
});

s.test('each observation restarts it', () => {
  const fade = new ObservationFade(400);
  fade.start(1000);
  fade.value(1400);
  fade.start(2000);
  assert.strictEqual(fade.value(2200), 0.5);
});

s.test('turning it off shows the observation immediately', () => {
  const fade = new ObservationFade(400);
  fade.setEnabled(false);
  fade.start(1000);
  assert.strictEqual(fade.value(1000), 1);
  assert.strictEqual(fade.value(1200), 1);
});

s.test('turning it off mid-dissolve finishes rather than freezing', () => {
  const fade = new ObservationFade(400);
  fade.start(1000);
  fade.value(1100);
  fade.setEnabled(false);
  assert.strictEqual(fade.value(1100), 1, 'the newest observation is what stays on screen');
});

// A dissolve that outlasts the gap between observations would leave the globe
// permanently showing a mixture and never settling on one observation.
s.test('the dissolve always ends before the next observation arrives', () => {
  for (const interval of [300, 650, 1200]) {
    const fade = new ObservationFade();
    const duration = fade.matchInterval(interval);
    assert.ok(duration < interval, `${duration} ms must fit inside ${interval} ms`);
    assert.ok(duration >= 120, 'but long enough to read as motion rather than a flicker');
    assert.ok(duration <= 380, 'and short enough that the observation is what is mostly seen');
  }
});

s.test('a missing playback interval leaves the duration alone', () => {
  const fade = new ObservationFade(400);
  assert.strictEqual(fade.matchInterval(undefined), 400);
  assert.strictEqual(fade.matchInterval(0), 400);
});

s.run();
