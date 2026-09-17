'use strict';
// Time-lapse behaviour: distinct observations, looping, pausing, cache reuse and
// the guard that keeps the reference globe out of playback.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { install, suite } = require('./harness.cjs');

const env = install([
  'weatherProduct', 'weatherStatus', 'weatherDescription', 'observationTime',
  'weatherTime', 'refreshWeather', 'autoWeather', 'surfaceLabel', 'flatWeather',
  'rawObservation', 'weatherPlay', 'weatherPlaybackStatus', 'weatherPlaybackSpeed'
]);
const W = require('../dist/weather.js');
const { WeatherPlayback } = require('../dist/weather-playback.js');
const s = suite('weather-playback');

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'dist', 'weather', 'sequence', 'manifest.json'), 'utf8')
);
const TIMES = MANIFEST.globalir.map(f => f.time);
const PRODUCTS_JSON = JSON.stringify([
  { id: 'globalir', times: ['20260916.190000', '20260916.200000', '20260916.210000'] }
]);

function setup() {
  global.GEO_WEATHER_SEQUENCE = {
    globalir: MANIFEST.globalir.map(f => ({
      time: f.time, url: 'weather/sequence/' + f.file, source: f.source, sha256: f.sha256
    }))
  };
  env.responses.set('weather/sequence/', { image: true });
  env.responses.set('api/products', PRODUCTS_JSON);
  env.responses.set('api/image', { image: true });
  env.document.getElementById('weatherProduct').value = 'globalir';
  env.document.getElementById('autoWeather').checked = false;
  env.reset();
  const shown = [];
  const controller = new W.WeatherController({
    onImage: () => shown.push(1),
    onEnabled: () => {}
  });
  const playback = new WeatherPlayback(controller);
  return { controller, playback, shown };
}

// step() schedules the next frame; tests drive it by hand instead of waiting.
function stepOnce(playback) {
  playback.step();
  clearTimeout(playback.timer);
  return playback.controller.current.time;
}

s.test('the bundled sequence holds 13 distinct ordered observations', () => {
  assert.strictEqual(TIMES.length, 13, 'thirteen observation times');
  assert.deepStrictEqual(TIMES, [...new Set(TIMES)].sort(), 'distinct and in order');
  assert.strictEqual(TIMES[0], '20260916.090000');
  assert.strictEqual(TIMES[12], '20260916.210000');
  const hours = TIMES.map(t => W.parseTime(t).getTime());
  for (let i = 1; i < hours.length; i++) {
    assert.strictEqual(hours[i] - hours[i - 1], 3600000, 'one hour between observations');
  }
  for (const frame of MANIFEST.globalir) {
    assert.ok(/^[0-9a-f]{64}$/.test(frame.sha256), 'each frame records its SHA-256');
    assert.ok(frame.source.includes('products=globalir_' + frame.time.replace('.', '_')),
      'each frame records the request it came from');
  }
});

s.test('playback loads every bundled frame once, then replays from cache', async () => {
  const { playback, controller } = setup();
  await playback.prepare(true);
  clearTimeout(playback.timer);
  assert.deepStrictEqual(playback.frames, TIMES);
  assert.strictEqual(env.loads.length, 13, 'each observation fetched exactly once');
  assert.strictEqual(controller.cache.size, 13);
  env.reset();
  await playback.prepare(true);
  clearTimeout(playback.timer);
  assert.strictEqual(env.loads.length, 0, 'the second run reuses the cached observations');
  playback.stop();
  clearInterval(controller.timer);
});

s.test('each step shows a different observation and the loop returns to the first', async () => {
  const { playback, controller } = setup();
  await playback.prepare(true);
  clearTimeout(playback.timer);
  assert.strictEqual(controller.current.time, TIMES[0], 'starts at the earliest observation');
  const seen = [controller.current.time];
  const stamps = [env.document.getElementById('observationTime').textContent];
  for (let i = 0; i < 12; i++) {
    seen.push(stepOnce(playback));
    stamps.push(env.document.getElementById('observationTime').textContent);
  }
  assert.deepStrictEqual(seen, TIMES, 'all 13 observations are shown in order');
  assert.strictEqual(new Set(stamps).size, 13, 'the displayed timestamp changes every frame');
  assert.ok(stamps[0].includes('日本時間'), 'timestamps are labelled Japan time');
  assert.strictEqual(stepOnce(playback), TIMES[0], 'playback loops back to the first observation');
  playback.stop();
  clearInterval(controller.timer);
});

s.test('the last frame is held longer before looping', async () => {
  const { playback, controller } = setup();
  await playback.prepare(true);
  clearTimeout(playback.timer);
  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(() => {}, 0); };
  try {
    for (let i = 0; i < 13; i++) playback.step();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  // prepare() already showed the first frame, so these 13 steps cover frames 1..12
  // and then the loop back to frame 0.
  assert.strictEqual(delays.length, 13);
  assert.strictEqual(delays[0], playback.interval, 'ordinary frames use the chosen interval');
  assert.strictEqual(delays[11], playback.interval * 2, 'the final observation is held twice as long');
  assert.strictEqual(delays[12], playback.interval, 'the restarted loop runs at normal speed');
  playback.stop();
  clearInterval(controller.timer);
});

s.test('the speed control changes the interval', async () => {
  const { playback, controller } = setup();
  assert.strictEqual(playback.interval, 650);
  const select = env.document.getElementById('weatherPlaybackSpeed');
  select.value = '300';
  select.onchange({ target: select });
  assert.strictEqual(playback.interval, 300);
  clearInterval(controller.timer);
});

s.test('pausing stops the timer and reports the position', async () => {
  const { playback, controller } = setup();
  await playback.prepare(true);
  clearTimeout(playback.timer);
  stepOnce(playback);
  stepOnce(playback);
  const paused = controller.current.time;
  playback.stop();
  assert.strictEqual(playback.playing, false);
  assert.strictEqual(env.document.getElementById('weatherPlay').textContent, '▶ 雲の流れを再生');
  assert.strictEqual(env.document.getElementById('weatherPlay').getAttribute('aria-pressed'), 'false');
  assert.ok(env.document.getElementById('weatherPlaybackStatus').textContent.includes('一時停止'));
  assert.strictEqual(controller.current.time, paused, 'the paused observation stays on screen');
  playback.step();
  assert.strictEqual(controller.current.time, paused, 'a stray step after pausing does nothing');
  clearInterval(controller.timer);
});

s.test('the reference globe cannot be played back', async () => {
  const { playback, controller } = setup();
  env.document.getElementById('weatherProduct').value = 'earth';
  env.reset();
  await playback.prepare(true);
  assert.strictEqual(playback.playing, false);
  assert.strictEqual(playback.frames.length, 0);
  assert.strictEqual(env.loads.length, 0, 'nothing is fetched for the reference globe');
  assert.strictEqual(env.document.getElementById('weatherPlaybackStatus').textContent,
    '赤外線または可視光の観測を選んでください。');
  clearInterval(controller.timer);
});

s.test('a single observation is not presented as a time-lapse', async () => {
  const { playback, controller } = setup();
  global.GEO_WEATHER_SEQUENCE = { globalir: [{ time: TIMES[0], url: 'weather/sequence/x.png' }] };
  env.reset();
  await playback.prepare(true);
  assert.strictEqual(playback.playing, false);
  assert.strictEqual(env.loads.length, 0);
  assert.ok(env.document.getElementById('weatherPlaybackStatus').textContent.includes('2時刻以上'));
  clearInterval(controller.timer);
});

s.test('a failed load keeps the observation on screen instead of guessing', async () => {
  const { playback, controller } = setup();
  await playback.prepare(true);
  clearTimeout(playback.timer);
  const kept = controller.current.time;
  controller.cache.clear();
  env.responses.set('weather/sequence/', Error('network down'));
  await playback.prepare(true);
  assert.strictEqual(playback.playing, false);
  assert.strictEqual(controller.current.time, kept, 'the last good observation is retained');
  assert.strictEqual(env.document.getElementById('weatherPlaybackStatus').textContent,
    '観測の取得に失敗しました。表示中の観測を保持しています。');
  env.responses.set('weather/sequence/', { image: true });
  clearInterval(controller.timer);
});

s.test('refreshing while playing restarts from the newly listed times', async () => {
  const { playback, controller } = setup();
  await playback.prepare(true);
  clearTimeout(playback.timer);
  assert.strictEqual(playback.playing, true);
  await controller.refresh();
  clearTimeout(playback.timer);
  assert.strictEqual(playback.playing, true, 'playback resumes after the refresh');
  assert.deepStrictEqual(playback.frames,
    ['20260916.190000', '20260916.200000', '20260916.210000'],
    'the newly listed observation times are played');
  playback.stop();
  clearInterval(controller.timer);
});

s.run();
