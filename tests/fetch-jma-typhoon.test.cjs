'use strict';
// Reading the Japan Meteorological Agency's typhoon reports (scripts/fetch-jma-typhoon.cjs).
// The agency cannot be reached from here; tests/fixtures/jma-typhoon-2626.xml is the
// report the publishing workflow fetched on 2026-09-26 for typhoon 26 (Surigae), cut
// after its analysis and first forecast. Nothing in it is made up.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { suite } = require('./harness.cjs');
const J = require('../scripts/fetch-jma-typhoon.cjs');
const s = suite('fetch-jma-typhoon');

const XML = fs.readFileSync(path.join(__dirname, 'fixtures', 'jma-typhoon-2626.xml'), 'utf8');

s.test('a report gives the typhoon and its centre at each time, in UTC', () => {
  const r = J.parseReport(XML);
  assert.strictEqual(r.eventId, 'TC2632');
  assert.strictEqual(r.number, '2626');
  assert.strictEqual(r.name, 'SURIGAE');
  assert.strictEqual(r.kana, 'スリゲ');
  assert.strictEqual(r.issued, '2026-09-26T00:45:00.000Z');
  assert.strictEqual(r.status, '通常');
  assert.deepStrictEqual(r.points.map(p => [p.time, p.kind, p.lat, p.lon]), [
    ['2026-09-26T00:00:00.000Z', 'analysis', 22.2, 127.2],
    ['2026-09-26T12:00:00.000Z', 'forecast', 23.4, 126.9],
  ]);
  const [now, next] = r.points;
  assert.strictEqual(now.pressure, 996);
  assert.strictEqual(now.windKt, 50, 'the maximum wind, not the gust or the storm-area wind');
  assert.strictEqual(now.class, '台風(STS)');
  assert.strictEqual(now.circleKm, null, 'an analysis has no forecast circle');
  assert.strictEqual(next.windKt, 60);
  assert.strictEqual(next.circleKm, 65, 'the 70% circle, in km');
  assert.strictEqual(next.pressure, 990);
});

s.test('coordinates read in all four quarters of the globe', () => {
  assert.deepStrictEqual(J.coordinate('+22.2+127.2/'), [22.2, 127.2]);
  assert.deepStrictEqual(J.coordinate('-15.5-170.25/'), [-15.5, -170.25]);
  assert.strictEqual(J.coordinate(''), null);
});

s.test('the newest report of each disturbance is kept, and stale ones are dropped', () => {
  const r = J.parseReport(XML);
  const older = Object.assign({}, r, { issued: '2026-09-25T21:45:00.000Z', points: r.points.map(p => Object.assign({}, p, { lat: p.lat - 1 })) });
  const depression = Object.assign({}, r, { eventId: 'TC2633', number: null, kana: null });
  const cancelled = Object.assign({}, r, { eventId: 'TC2634', infoType: '取消' });
  const drill = Object.assign({}, r, { eventId: 'TC2635', status: '訓練' });
  const now = Date.parse('2026-09-26T02:30:00Z');
  const kept = J.newestPerTyphoon([older, r, depression, cancelled, drill], now);
  assert.deepStrictEqual(kept.map(k => k.eventId), ['TC2632', 'TC2633']);
  assert.strictEqual(kept[0].issued, r.issued);
  // A report whose forecast has run out, or one issued over a day ago, is a storm that ended.
  assert.deepStrictEqual(J.newestPerTyphoon([r], Date.parse('2026-09-26T13:00:00Z')), []);
  assert.deepStrictEqual(J.newestPerTyphoon([r], Date.parse('2026-09-27T01:00:00Z')), []);
});

s.test('the feed lists entries with title, link and time', () => {
  const feed = `<feed><entry><title>台風解析・予報情報（５日予報）（Ｈ３０）</title><updated>2026-09-26T00:41:20Z</updated>
    <link type="application/xml" href="https://www.data.jma.go.jp/developer/xml/data/x.xml"/></entry>
    <entry><title>府県天気予報（Ｒ１）</title><link href="https://example/y.xml"/><updated>2026-09-26T00:40:00Z</updated></entry></feed>`;
  const entries = J.parseFeed(feed);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].link, 'https://www.data.jma.go.jp/developer/xml/data/x.xml');
  assert.ok(/台風解析・予報情報/.test(entries[0].title));
});

s.test('the bundled file, fetched or not, is one the page can read', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'data', 'jma-typhoon.json'), 'utf8'));
  assert.ok(Array.isArray(data.storms));
});

s.run();
