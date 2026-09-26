'use strict';
// Observation loading, timestamp handling and what happens when a fetch fails.
const assert = require('assert');
const { install, suite } = require('./harness.cjs');

const env = install([
  'weatherProduct', 'weatherStatus', 'weatherDescription', 'observationTime',
  'weatherTime', 'refreshWeather', 'surfaceLabel', 'flatWeather',
  'rawObservation'
]);
const W = require('../dist/weather.js');
const s = suite('weather');

const PRODUCTS_JSON = JSON.stringify([
  { id: 'globalir', times: ['20260916.190000', '20260916.170000', '20260916.180000'] }
]);

function controller() {
  const ui = env.document;
  ui.getElementById('weatherProduct').value = 'globalir';
  for (const id of ['weatherStatus', 'observationTime', 'surfaceLabel']) {
    ui.getElementById(id).textContent = '';
  }
  const images = [];
  const enabled = [];
  const c = new W.WeatherController({
    onImage: image => images.push(image),
    onEnabled: value => enabled.push(value)
  });
  return { c, images, enabled };
}

// Status text depends on how old the observation is, so tests fix "now".
async function atTime(iso, body) {
  const realNow = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return await body();
  } finally {
    Date.now = realNow;
  }
}

s.test('timestamps are parsed strictly', () => {
  assert.strictEqual(W.parseTime('20260916.190000').toISOString(), '2026-09-16T19:00:00.000Z');
  assert.strictEqual(W.parseTime('20260916_190000').toISOString(), '2026-09-16T19:00:00.000Z');
  assert.strictEqual(W.parseTime('20260231.190000'), null, 'February 31 does not exist');
  assert.strictEqual(W.parseTime('20260916.196000'), null, 'minute 60 does not exist');
  assert.strictEqual(W.parseTime('nonsense'), null);
});

s.test('available times are de-duplicated and sorted', () => {
  const times = W.productInfo(JSON.parse(PRODUCTS_JSON), 'globalir');
  assert.deepStrictEqual(times, ['20260916.170000', '20260916.180000', '20260916.190000']);
  assert.throws(() => W.productInfo([{ id: 'globalir', times: ['bad'] }], 'globalir'),
    /利用可能な観測時刻がありません/);
  assert.throws(() => W.productInfo([], 'globalir'), /利用可能な観測時刻がありません/);
  assert.throws(() => W.productInfo('not an array', 'globalir'), /形式を確認できません/);
});

s.test('image requests keep the documented bounds and size', () => {
  const url = W.imageURL('globalir', '20260916.190000', 512);
  assert.ok(url.startsWith('https://realearth.ssec.wisc.edu/api/image?'));
  assert.ok(url.includes('products=globalir_20260916_190000'));
  assert.ok(url.includes('width=512&height=512'));
  assert.ok(url.includes('bounds=-85.05112878%2C-180%2C85.05112878%2C180'));
  assert.ok(W.imageURL('globalir', '20260916.190000').includes('width=1024'));
  assert.throws(() => W.imageURL('globalir', 'whenever'), /Invalid observation/);
  assert.throws(() => W.imageURL('made-up', '20260916.190000'), /Invalid observation/);
});

s.test('mercator projection matches the image the API returns', () => {
  assert.strictEqual(W.mercatorY(0), 0.5);
  assert.ok(W.mercatorY(85.05112878) < 0.0001, 'top edge of the image');
  assert.ok(W.mercatorY(-85.05112878) > 0.9999, 'bottom edge of the image');
  assert.ok(W.mercatorY(35) < W.mercatorY(-35), 'north is above south');
});

s.test('the bundled observation is shown without any network call', async () => {
  global.GEO_WEATHER_SNAPSHOT = {
    globalir: { time: '20260916.170000', url: 'weather/snapshot/globalir_20260916_170000.png' }
  };
  env.responses.set('weather/snapshot/', { image: true });
  env.reset();
  const { c, images, enabled } = controller();
  const listened = [], listen = env.document.addEventListener;
  env.document.addEventListener = type => listened.push(type);
  try { await atTime('2026-09-16T18:00:00Z', () => c.init(true)); }  // one hour after the observation
  finally { env.document.addEventListener = listen; }
  assert.strictEqual(images.length, 1, 'one observation uploaded');
  assert.deepStrictEqual(enabled, [true]);
  assert.strictEqual(c.current.time, '20260916.170000');
  assert.strictEqual(c.current.saved, true);
  assert.ok(env.loads.every(u => !u.includes('api/products')), 'no product listing was requested');
  // Nothing asks SSEC by itself: no hourly timer, and coming back to the page fetches
  // nothing. That check, on by default, had every visitor fetching from the university.
  assert.strictEqual(c.timer, undefined, 'no automatic refresh');
  assert.ok(!listened.includes('visibilitychange'), 'coming back to the page does not fetch');
  const shown = env.document.getElementById('observationTime').textContent;
  assert.ok(shown.includes('2026/09/17') && shown.includes('02:00') && shown.includes('日本時間'),
    'timestamp is shown in Japan time: ' + shown);
  assert.strictEqual(env.document.getElementById('weatherStatus').textContent, '同梱の観測画像を表示中');
  assert.ok(env.document.getElementById('surfaceLabel').textContent.includes('合成した雲'),
    'the caption says the white cloud layer is composited');
});

s.test('refresh loads the newest observation and lists the rest', async () => {
  delete global.GEO_WEATHER_SNAPSHOT;
  env.responses.set('api/products', PRODUCTS_JSON);
  env.responses.set('api/image', { image: true });
  env.reset();
  const { c, images } = controller();
  await atTime('2026-09-16T19:30:00Z', () => c.refresh());
  assert.strictEqual(c.current.time, '20260916.190000', 'newest time is displayed');
  assert.strictEqual(images.length, 1);
  assert.strictEqual(env.document.getElementById('weatherTime').max, '2');
  assert.strictEqual(env.document.getElementById('weatherTime').value, '2');
  assert.strictEqual(env.document.getElementById('weatherStatus').textContent, '取得した観測画像を表示中');
  assert.strictEqual(env.document.getElementById('flatWeather').hidden, false);
  env.reset();
  await atTime('2026-09-16T19:30:00Z', () => c.show('globalir', '20260916.190000'));
  assert.strictEqual(env.loads.length, 0, 'the cached observation is reused');
  assert.strictEqual(images.length, 2, 'the cached image is still uploaded');
  env.reset();
  await c.show('globalir', '20260916.170000');
  assert.strictEqual(env.loads.length, 1, 'a different time is fetched once');
  assert.strictEqual(env.document.getElementById('weatherStatus').textContent, '過去の観測を表示中');
});

s.test('a failed refresh keeps the observation already on screen', async () => {
  env.responses.set('api/products', PRODUCTS_JSON);
  env.responses.set('api/image', { image: true });
  const { c, enabled } = controller();
  await c.refresh();
  const kept = c.current.time;
  enabled.length = 0;
  env.responses.set('api/products', Error('network down'));
  await c.refresh();
  assert.strictEqual(c.current.time, kept, 'the displayed observation is unchanged');
  assert.deepStrictEqual(enabled, [true], 'the globe keeps showing the observation');
  assert.strictEqual(env.document.getElementById('weatherStatus').textContent,
    '取得できませんでした。表示中の日時の観測画像を保持しています。');
});

s.test('with nothing loaded a failure falls back to the reference globe', async () => {
  env.responses.set('api/products', Error('network down'));
  const { c, enabled } = controller();
  await c.refresh();
  assert.strictEqual(c.current, null);
  assert.deepStrictEqual(enabled, [false], 'the observation layer is switched off');
  assert.ok(env.document.getElementById('weatherStatus').textContent.includes('観測画像を取得できません'));
  assert.strictEqual(env.document.getElementById('surfaceLabel').textContent,
    '参考画像・現在の観測ではありません');
  assert.strictEqual(env.document.getElementById('observationTime').textContent, '観測画像は未取得');
});

s.test('the reference globe is not labelled as an observation', async () => {
  const { c, enabled } = controller();
  env.document.getElementById('weatherProduct').value = 'earth';
  await c.changeProduct();
  assert.deepStrictEqual(enabled, [false]);
  assert.ok(env.document.getElementById('weatherDescription').textContent.includes('現在の観測は表示していません'));
  assert.strictEqual(env.document.getElementById('flatWeather').hidden, true);
  assert.strictEqual(env.document.getElementById('observationTime').textContent, '観測日時なし');
});

s.run();
