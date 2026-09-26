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

s.test('for each disturbance, the report nearest the last observation that covers it', () => {
  const r = J.parseReport(XML);   // analysed 2026-09-26 00:00Z, forecast to 12:00Z
  const shift = (report, hours, extra = {}) => Object.assign({}, report, extra, {
    issued: new Date(Date.parse(report.issued) + hours * 3600000).toISOString(),
    points: report.points.map(p => Object.assign({}, p, { time: new Date(Date.parse(p.time) + hours * 3600000).toISOString() })),
  });
  const lastObs = J.stampMs('20260925.200000');
  const earlier = shift(r, -9), later = shift(r, 6);
  const depression = shift(r, 0, { eventId: 'TC2633', number: null, kana: null });
  const cancelled = shift(r, 0, { eventId: 'TC2634', infoType: '取消' });
  const drill = shift(r, 0, { eventId: 'TC2635', status: '訓練' });
  const kept = J.forObservations([later, r, earlier, depression, cancelled, drill], lastObs);
  assert.deepStrictEqual(kept.map(k => k.eventId), ['TC2632', 'TC2633']);
  // Analysed 4 h after the last observation beats 10 h after (later) and 5 h before
  // (earlier, whose forecast runs out 7 h after it - less than the 12 needed).
  assert.strictEqual(kept[0].issued, r.issued);
  // Not the newest: a day on, the newest no longer covers these observations.
  assert.deepStrictEqual(J.forObservations([shift(r, 30)], lastObs), []);
  // Observations a day older than every report: nothing covers them.
  assert.deepStrictEqual(J.forObservations([r], J.stampMs('20260924.200000')), []);
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
