'use strict';
// The playback clock of the 3-D model mode: what the buttons do to it, and that it
// stays inside the bounded three observed hours. The advection maths itself is
// covered by cloud-model.test.cjs; this is about the controls around it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { install, suite } = require('./harness.cjs');

const env = install([
  'cloudPlay', 'cloudReset', 'cloudTime', 'cloudSpeed', 'cloudHeight', 'cloudHeightValue',
  'cloudLayer', 'cloudStatus', 'cloudObserved', 'cloudCount',
  'cloudElapsed', 'cloudProgress',
]);
global.CloudModel = require('../dist/cloud-model.js');
require('../dist/cloud-simulation.js');

const BUNDLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'dist', 'data', 'amv.json'), 'utf8'));

const s = suite('cloud-simulation');

// A simulation with the bundled observed wind already applied and running.
function running() {
  const sim = new global.CloudSimulation();
  sim.enabled = true;
  sim.apply(BUNDLE, '同梱の観測風');
  return sim;
}

const el = id => env.document.getElementById(id);
const click = id => el(id).onclick();
const minutes = sim => Math.floor(sim.elapsed / 60);
// tick() never accepts more than 0.1s at a time, so a second of real time is ten of
// them. Feeding it one big step would under-count, exactly as the code intends.
const seconds = (sim, count) => { for (let i = 0; i < count * 10; i++) sim.tick(0.1); };

s.test('the bundled observed wind starts the clock at zero', () => {
  const sim = running();
  assert.strictEqual(sim.elapsed, 0);
  assert.ok(sim.playing, 'playback starts unless the viewer asked for reduced motion');
  assert.ok(!el('cloudPlay').disabled, 'the play button becomes usable');
});

s.test('time advances at the chosen simulated minutes per second', () => {
  const sim = running();
  sim.minutesPerSecond = 5;
  seconds(sim, 1);
  assert.strictEqual(minutes(sim), 5);
  sim.minutesPerSecond = 10;
  seconds(sim, 1);
  assert.strictEqual(minutes(sim), 15);
});

// A tab left in the background hands back one enormous frame time. The model must
// not treat that as hours of observed wind it never integrated.
s.test('one long frame cannot fast-forward the model', () => {
  const sim = running();
  sim.minutesPerSecond = 10;
  sim.tick(600);
  assert.strictEqual(minutes(sim), 1, 'ten minutes of wall clock advance the model by one');
});

s.test('a paused clock does not advance', () => {
  const sim = running();
  seconds(sim, 1);
  const held = sim.elapsed;
  click('cloudPlay');
  assert.ok(!sim.playing);
  seconds(sim, 5);
  assert.strictEqual(sim.elapsed, held);
});

// Returning to the start while the clock runs used to leave nothing to look at: at
// five or ten simulated minutes a second the reading was back in the minutes before
// the eye could follow it. Returning to the start now also stops there.
s.test('returning to the start stops there', () => {
  const sim = running();
  seconds(sim, 2);
  assert.ok(sim.elapsed > 0);

  click('cloudReset');
  assert.strictEqual(sim.elapsed, 0);
  assert.ok(!sim.playing, 'the clock holds at the start so the start can be seen');

  seconds(sim, 3);
  assert.strictEqual(sim.elapsed, 0, 'and it stays there until playback is asked for');
  assert.strictEqual(el('cloudElapsed').textContent, '計算開始から 0時間 00分');
});

s.test('playing again after returning to the start runs from the start', () => {
  const sim = running();
  seconds(sim, 2);
  click('cloudReset');
  click('cloudPlay');
  assert.ok(sim.playing);
  seconds(sim, 1);
  assert.strictEqual(minutes(sim), 5);
});

s.test('the clock stops at the third observed hour', () => {
  const sim = running();
  sim.minutesPerSecond = 10;
  seconds(sim, 40);
  assert.strictEqual(sim.elapsed, 10800, 'three hours is the bound the observed wind is used to');
  assert.ok(!sim.playing, 'and it stops rather than running past it');
});

s.test('playing at the bound starts over instead of standing still', () => {
  const sim = running();
  sim.elapsed = 10800;
  sim.playing = false;
  click('cloudPlay');
  assert.strictEqual(sim.elapsed, 0);
  assert.ok(sim.playing);
});

s.test('scrubbing to a time pauses there', () => {
  const sim = running();
  el('cloudTime').oninput({ target: { value: '90' } });
  assert.strictEqual(sim.elapsed, 5400);
  assert.ok(!sim.playing, 'a hand on the slider is not playback');
  assert.strictEqual(el('cloudElapsed').textContent, '計算開始から 1時間 30分');
});

s.test('choosing a pressure band keeps only that band, and never invents points', () => {
  const sim = running();
  const all = sim.visiblePoints.length;
  assert.strictEqual(all, BUNDLE.points.length);

  sim.layer = 'AMV-LLlow';
  sim.selectLayer();
  const low = sim.visiblePoints.length;
  assert.ok(low > 0 && low < all, `${low} of ${all} observed vectors are in the low band`);
  assert.ok(sim.visiblePoints.every(p => p.product === 'AMV-LLlow'));
  assert.strictEqual(el('cloudCount').textContent, low.toLocaleString() + ' 地点');
});

s.run();
