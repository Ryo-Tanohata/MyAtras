'use strict';
// The field that keeps a front's cloud where the agency's charts put the front
// (dist/fronts.js), and reading those charts (scripts/fetch-jma-fronts.cjs). The charts
// here are made up, with answers known by construction; the parser is also run on the
// head of a real chart as the agency writes it.
const assert = require('assert');
const { suite } = require('./harness.cjs');
const { FrontField } = require('../dist/fronts.js');
const J = require('../scripts/fetch-jma-fronts.cjs');
const s = suite('fronts');

const START = Date.UTC(2026, 8, 25, 20);
const iso = hours => new Date(START + hours * 3600000).toISOString();
// A stationary front along a parallel, from 120E to 160E.
const along = (lat, from = 120, to = 160) => Array.from({ length: (to - from) * 2 + 1 }, (_, i) => [lat, from + i / 2]);
const chart = (hours, lines, kind = 'forecast') => ({ title: kind === 'analysis' ? '地上実況図' : '地上２４時間予想図', kind,
  valid: iso(hours), issued: iso(hours - 6), fronts: lines.map(points => ({ type: '停滞前線', points })) });
const cell = (f, px, lat, lon) => {
  const x = Math.floor((lon + 180) / 360 * f.width), y = Math.floor((lat + 90) / 180 * f.height), i = (y * f.width + x) * 4;
  return { weight: px[i] / 255, north: (px[i + 1] - 128) / 127 * FrontField.SHIFT_DEG,
    east: ((px[i + 2] << 8 | px[i + 3]) - 32768) / 32767 * FrontField.SHIFT_EAST_DEG };
};

s.test('on a front its cloud is kept whole, and none far from it', () => {
  const f = new FrontField({ charts: [chart(4, [along(33)], 'analysis')] }, START);
  const px = f.pixels(4);
  assert.ok(cell(f, px, 33, 140).weight > 0.95, 'on the front');
  assert.strictEqual(cell(f, px, 40, 140).weight, 0, '780 km off');
  assert.strictEqual(cell(f, px, 33, 175).weight, 0, 'beyond its end');
  // The cell there is centred 2.86 degrees (318 km) off: between NEAR_KM and FAR_KM.
  const edge = cell(f, px, 36, 140).weight;
  assert.ok(edge > 0 && edge < 0.5, `318 km off, partly: ${edge}`);
});

s.test('a front that has moved takes its cloud from where the first chart had it', () => {
  const f = new FrontField({ charts: [chart(4, [along(33)], 'analysis'), chart(28, [along(35)])] }, START);
  const moved = cell(f, f.pixels(28), 35, 140);
  assert.ok(moved.weight > 0.95);
  // Matched along the fronts by distance from their western ends: 20 degrees of longitude
  // are 3% shorter at 35N than at 33N, so half a degree of drift by 140E.
  assert.ok(Math.abs(moved.north - 2) < 0.15 && Math.abs(moved.east) < 0.6, JSON.stringify(moved));
  // Halfway between the charts, both count: the band is spread between them.
  const half = f.pixels(16);
  assert.ok(cell(f, half, 34, 140).weight > 0.4);
});

s.test('a front with none near it on the first chart keeps what is under it', () => {
  const f = new FrontField({ charts: [chart(4, [along(33)], 'analysis'), chart(28, [along(50, 120, 140)])] }, START);
  const fresh = cell(f, f.pixels(28), 50, 130);
  assert.ok(fresh.weight > 0.95);
  assert.ok(Math.abs(fresh.north) < 0.1 && Math.abs(fresh.east) < 0.1, JSON.stringify(fresh));
});

s.test('past the end of the first chart\'s front, the cloud comes from as far back inside the band', () => {
  // The first chart's front ends at 140E; a later one runs on to 160E. At 150E, 10 degrees
  // beyond the end, the cloud is taken from 130E, 10 degrees inside: moved 20 east.
  const f = new FrontField({ charts: [chart(4, [along(33, 120, 140)], 'analysis'), chart(28, [along(33, 120, 160)])] }, START);
  const px = f.pixels(28), beyond = cell(f, px, 33, 150), near = cell(f, px, 33, 142);
  assert.ok(beyond.weight > 0.95);
  const centre = (Math.floor((150 + 180) / 360 * f.width) + 0.5) / f.width * 360 - 180;   // 149.77E
  assert.ok(Math.abs(beyond.east - 2 * (centre - 140)) < 0.3 && Math.abs(beyond.north) < 0.2, JSON.stringify(beyond));
  assert.ok(near.east > 0 && near.east < 6, 'just past the end, from just inside: ' + JSON.stringify(near));
  // Neighbouring cells take neighbouring cloud, not all the same column.
  const next = cell(f, px, 33, 151.5);
  assert.ok(Math.abs(next.east - beyond.east) > 2, JSON.stringify([beyond, next]));
});

s.test('past the last chart its fronts are held, then fade', () => {
  const f = new FrontField({ charts: [chart(4, [along(33)], 'analysis'), chart(52, [along(34)])] }, START);
  const at = h => cell(f, f.pixels(h), 34, 140).weight;
  assert.ok(at(52 + FrontField.HOLD_HOURS) > 0.95, 'held');
  const mid = at(52 + FrontField.HOLD_HOURS + FrontField.FADE_HOURS / 2);
  assert.ok(mid > 0.4 && mid < 0.6, `half faded: ${mid}`);
  assert.strictEqual(at(52 + FrontField.HOLD_HOURS + FrontField.FADE_HOURS + 1), 0);
});

s.test('no charts, no field', () => {
  const f = new FrontField({ charts: [] }, START);
  assert.ok(f.empty);
  assert.ok(f.pixels(10).every((v, i) => i % 4 === 0 ? v === 0 : true));
});

s.test('across the date line a front is one front', () => {
  const f = new FrontField({ charts: [chart(4, [[[40, 170], [40, 179.5], [40, -179.5], [40, -170]]], 'analysis')] }, START);
  const px = f.pixels(4);
  assert.ok(cell(f, px, 40, 179.9).weight > 0.95 && cell(f, px, 40, -175).weight > 0.95);
});

// The head and the first front of a real chart, as the agency wrote it on 2026-09-27; the
// isobars and all but one front cut. The head's target time is the initial time, and the
// time the chart is for is in the body: read the other way round, the first run filed a
// chart for 9/28 12Z as one for 9/26 12Z.
const REAL = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_add="http://xml.kishou.go.jp/jmaxml1/addition1/">
    <Control>
        <Title>地上４８時間予想図</Title>
        <DateTime>2026-09-26T20:51:25Z</DateTime>
        <Status>通常</Status>
        <EditorialOffice>気象庁本庁</EditorialOffice>
        <PublishingOffice>気象庁</PublishingOffice>
    </Control>
    <Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
        <Title>地上４８時間予想図</Title>
        <ReportDateTime>2026-09-27T05:51:25+09:00</ReportDateTime>
        <TargetDateTime>2026-09-26T21:00:00+09:00</TargetDateTime>
        <EventID></EventID>
        <InfoType>発表</InfoType>
    </Head>
    <Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
        <MeteorologicalInfos type="天気図情報">
            <MeteorologicalInfo>
                <DateTime type="予想　４８時間後">2026-09-28T21:00:00+09:00</DateTime>
                <Item>
                    <Kind>
                        <Property>
                            <Type>等圧線</Type>
                            <IsobarPart>
                                <jmx_eb:Pressure type="気圧" unit="hPa">964</jmx_eb:Pressure>
                                <jmx_eb:Line type="位置（度）">+26.94+130.99/+26.94+130.99/+26.93+130.97/</jmx_eb:Line>
                            </IsobarPart>
                        </Property>
                    </Kind>
                </Item>
                <Item>
                    <Kind>
                        <Property>
                            <Type>停滞前線</Type>
                            <CoordinatePart>
                                <jmx_eb:Line type="前線（停滞前線）">+29.13+108.01/+30.50+120.00/+33.20+135.00/+34.95+166.44/</jmx_eb:Line>
                            </CoordinatePart>
                        </Property>
                    </Kind>
                </Item>
            </MeteorologicalInfo>
        </MeteorologicalInfos>
    </Body>
</Report>`;

s.test('a real chart: its time, the time it is for, and its fronts but not its isobars', () => {
  const c = J.parseChart(REAL);
  assert.strictEqual(c.kind, 'forecast');
  assert.strictEqual(c.hours, 48);
  assert.strictEqual(c.base, '2026-09-26T12:00:00.000Z');
  assert.strictEqual(c.valid, '2026-09-28T12:00:00.000Z');
  assert.strictEqual(c.issued, '2026-09-26T20:51:25.000Z');
  assert.deepStrictEqual(c.fronts, [{ type: '停滞前線', points: [[29.13, 108.01], [30.5, 120], [33.2, 135], [34.95, 166.44]] }]);
});

s.test('the charts for the observations: forecasts from the nearest initial time, and its analysis', () => {
  const at = J.stampMs('20260925.200000');
  const c = (kind, hours, base, extra = {}) => Object.assign({ title: kind, kind, hours, status: '通常', fronts: [{ type: '停滞前線', points: [[30, 130], [31, 140]] }],
    base: new Date(base).toISOString(), valid: new Date(base + hours * 3600000).toISOString(), issued: new Date(base + 8 * 3600000).toISOString() }, extra);
  const b0 = Date.UTC(2026, 8, 26, 0), b12 = Date.UTC(2026, 8, 25, 12);
  const kept = J.forObservations([c('forecast', 24, b12), c('forecast', 48, b12), c('forecast', 24, b0), c('forecast', 48, b0),
    c('analysis', 0, b12), c('analysis', 0, b0), c('forecast', 24, b0, { status: '訓練' })], at);
  assert.deepStrictEqual(kept.map(k => [k.kind, k.hours, k.base]), [
    ['analysis', 0, '2026-09-26T00:00:00.000Z'], ['forecast', 24, '2026-09-26T00:00:00.000Z'], ['forecast', 48, '2026-09-26T00:00:00.000Z']]);
});

s.test('only a few files are fetched: those that can be for the observations', () => {
  const at = J.stampMs('20260925.200000');
  const e = (title, code, hour) => ({ title, link: `https://x/2026_0_${code}_010000.xml`, updated: new Date(Date.UTC(2026, 8, 25) + hour * 3600000).toISOString() });
  const kept = J.wanted([
    e('地上２４時間予想図', 'VZSF50', 31), e('地上４８時間予想図', 'VZSF51', 32),   // from 26 00Z
    e('地上２４時間予想図', 'VZSF50', 19), e('地上実況図', 'VZSA50', 14),          // from 25 12Z
    e('アジア太平洋地上実況図', 'VZSA60', 26.5),                                   // 26 00Z analysis
    e('地上２４時間予想図', 'VZSF50', 43), e('地上実況図', 'VZSA50', 38),          // 26 12Z: too late
    e('地上実況図', 'VZSA50', 2),                                                   // 25 00Z: too early
  ], at);
  assert.deepStrictEqual(kept.map(k => k.updated.slice(8, 13)), ['26T07', '26T08', '25T19', '25T14', '26T02']);
});

s.run();
