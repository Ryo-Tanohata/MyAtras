#!/usr/bin/env node
'use strict';
// The Japan Meteorological Agency's surface charts - the analysis and the 24 and 48 hour
// forecasts - for the fronts on them, for the simulation to keep a front's cloud where the
// agency expects the front to be.
//
//   node scripts/fetch-jma-fronts.cjs                     # -> dist/data/jma-fronts.json
//   node scripts/fetch-jma-fronts.cjs --dump              # also prints each chart read
//   node scripts/fetch-jma-fronts.cjs --for 20260925.200000
//
// The simulation carries the last observation's clouds and makes none, so a stationary
// front's cloud - which in the atmosphere forms again where the front lies as fast as the
// wind carries it off - streams away downwind and leaves a gap. On 2026-09-26 the agency
// expected the autumn front to stay along Honshu's south coast; the simulation showed its
// band ending east of Kanto.
//
// Read from the agency's disaster-information XML (気象防災情報XML): 地上実況図 (VZSA50),
// 地上２４時間予想図 (VZSF50) and 地上４８時間予想図 (VZSF51), which give the fronts,
// isobars and pressure centres as latitude-longitude lines. Only the fronts are kept.
//
// As with the typhoon forecast, not the newest charts: those for the bundled
// observations. The forecasts from the initial time nearest the last observation, and the
// analysis at that time. The publishing workflow fetches them when the observations
// change, a few small files each time; visitors' browsers never ask the agency anything.
//
// Run where the agency can be reached - the GitHub runner; agent containers get 403. Best
// effort: a failure writes a file with no charts and the reason, and exits 0.
const fs = require('fs');
const path = require('path');

const FEEDS = [
  'https://www.data.jma.go.jp/developer/xml/feed/regular_l.xml',
  'https://www.data.jma.go.jp/developer/xml/feed/regular.xml',
];
const OUT = path.join(__dirname, '..', 'dist', 'data', 'jma-fronts.json');
const SEQUENCE = path.join(__dirname, '..', 'dist', 'weather', 'sequence', 'manifest.json');
// Full-width or half-width digits, as the agency writes either.
const TITLE = /地上(実況図|[２2][４4]時間予想図|[４4][８8]時間予想図)/;
const HOUR = 3600000;

const text = s => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const first = (re, s) => { const m = re.exec(s); return m ? text(m[1]) : null; };

/// The feed's entries: title, link and when each was updated.
function parseFeed(xml) {
  const entries = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = m[1];
    const title = text((/<title>([\s\S]*?)<\/title>/.exec(body) || [])[1]);
    const link = (/<link[^>]*href="([^"]+)"/.exec(body) || [])[1];
    const updated = text((/<updated>([\s\S]*?)<\/updated>/.exec(body) || [])[1]);
    if (title && link) entries.push({ title, link: text(link), updated });
  }
  return entries;
}

/// Every "+lat+lon" in a line, as [lat, lon].
function coordinates(value) {
  return [...(value || '').matchAll(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/g)].map(m => [Number(m[1]), Number(m[2])]);
}

/// Which chart a title names: the analysis, or a forecast so many hours ahead.
function chartKind(title) {
  const t = (title || '').replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
  if (/実況図/.test(t)) return { kind: 'analysis', hours: 0 };
  const m = /(\d+)時間予想図/.exec(t);
  return m ? { kind: 'forecast', hours: Number(m[1]) } : null;
}

/// One chart: when it is for, and each front on it as a line of points.
function parseChart(xml) {
  const title = first(/<Control>[\s\S]*?<Title>([^<]+)<\/Title>/, xml) || first(/<Head\b[^>]*>[\s\S]*?<Title>([^<]+)<\/Title>/, xml);
  const status = first(/<Control>[\s\S]*?<Status>([^<]+)<\/Status>/, xml);
  const issued = first(/<Head\b[^>]*>[\s\S]*?<ReportDateTime>([^<]+)<\/ReportDateTime>/, xml);
  // The head's target time is the chart's initial time; the time it is for is in the body
  // ("予想　４８時間後"). The first run read the head's as the time a forecast was for,
  // and took a chart for 9/27 12Z to be for 9/26 12Z.
  const initial = first(/<Head\b[^>]*>[\s\S]*?<TargetDateTime>([^<]+)<\/TargetDateTime>/, xml);
  const target = first(/<MeteorologicalInfo>[\s\S]*?<DateTime[^>]*>([^<]+)<\/DateTime>/, xml) || initial;
  const k = chartKind(title) || { kind: null, hours: null };
  const fronts = [];
  // Each item names what it is (Type) and gives its line; the fronts are the ones whose
  // type ends in 前線 (寒冷, 温暖, 停滞, 閉塞).
  for (const m of xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
    const body = m[1];
    for (const p of body.matchAll(/<Property>([\s\S]*?)<\/Property>/g)) {
      const type = first(/<Type>([^<]+)<\/Type>/, p[1]);
      if (!type || !/前線/.test(type)) continue;
      for (const line of p[1].matchAll(/<jmx_eb:Line\b[^>]*>([^<]*)<\/jmx_eb:Line>/g)) {
        const points = coordinates(line[1]);
        if (points.length >= 2) fronts.push({ type, points });
      }
    }
  }
  const valid = target ? new Date(target).toISOString() : null;
  const base = initial ? new Date(initial).toISOString()
    : valid && k.hours !== null ? new Date(Date.parse(valid) - k.hours * HOUR).toISOString() : null;
  return { title, status, kind: k.kind, hours: k.hours, issued: issued ? new Date(issued).toISOString() : null, valid, base, fronts };
}

/// Of the feed's charts, the ones that can be for a simulation starting at `at`: the
/// charts are made from the 00 and 12 UTC analyses, so for each of the two initial times
/// either side of `at`, the forecasts issued in the half day after it and the analyses
/// issued in the six hours after it. A few files rather than the thirty around - each is
/// 140 to 300 KB, and the first run fetched 9 MB where 2 would have done.
function wanted(entries, at) {
  const b1 = Math.floor(at / (12 * HOUR)) * 12 * HOUR, bases = [b1, b1 + 12 * HOUR];
  return entries.filter(e => {
    const u = Date.parse(e.updated), code = (/_(VZS[AF]\d\d)_/.exec(e.link) || [])[1] || '';
    const forecast = /^VZSF/.test(code) || /予想図/.test(e.title);
    return bases.some(b => forecast ? u >= b + 2 * HOUR && u <= b + 14 * HOUR : u >= b && u <= b + 6 * HOUR);
  });
}

/// "20260925.200000" as milliseconds.
function stampMs(t) {
  const m = /^(\d{4})(\d\d)(\d\d)[._](\d\d)(\d\d)(\d\d)$/.exec(t || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/// The charts for a simulation starting at `at` (ms, the last observation): the forecasts
/// from the initial time nearest it that has any, and the analysis at that time (or,
/// without one, the analysis nearest it). Drills and cancellations left out; of charts for
/// the same time, the latest issued.
function forObservations(charts, at) {
  const usable = charts.filter(c => c.kind && c.valid && (!c.status || c.status === '通常'));
  const latest = new Map();
  for (const c of usable) {
    const key = `${c.kind}|${c.hours}|${c.valid}|${c.title}`, held = latest.get(key);
    if (!held || (c.issued || '') > (held.issued || '')) latest.set(key, c);
  }
  const all = [...latest.values()];
  const forecasts = all.filter(c => c.kind === 'forecast');
  if (!forecasts.length) return [];
  const base = forecasts.map(c => Date.parse(c.base)).sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || b - a)[0];
  const chosen = forecasts.filter(c => Date.parse(c.base) === base);
  const analyses = all.filter(c => c.kind === 'analysis');
  // Of analyses for the same time (the Japan area and the wider Asia-Pacific chart), the
  // one with the most front drawn.
  const extent = c => c.fronts.reduce((n, f) => n + f.points.length, 0);
  const analysis = analyses.filter(c => Date.parse(c.valid) === base).sort((a, b) => extent(b) - extent(a))[0]
    || analyses.sort((a, b) => Math.abs(Date.parse(a.valid) - at) - Math.abs(Date.parse(b.valid) - at))[0];
  return [analysis, ...chosen].filter(Boolean).sort((a, b) => a.valid.localeCompare(b.valid));
}

async function get(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'MyAtras (+https://github.com/Ryo-Tanohata/MyAtras)' } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.text();
}

async function main() {
  const dump = process.argv.includes('--dump');
  const i = process.argv.indexOf('--for');
  const forTime = i > 0 ? process.argv[i + 1] : JSON.parse(fs.readFileSync(SEQUENCE, 'utf8')).globalir.at(-1).time;
  const at = stampMs(forTime);
  if (!Number.isFinite(at)) throw new Error(`not an observation time: ${forTime}`);
  const out = { source: '気象庁 気象防災情報XML（地上実況図・地上２４時間予想図・地上４８時間予想図）', feed: FEEDS[0], for: forTime,
    fetched: new Date().toISOString(), charts: [] };
  let bytes = 0, requests = 0;
  try {
    const seen = new Set(), entries = [];
    for (const feed of FEEDS) {
      try {
        const xml = await get(feed); bytes += xml.length; requests++;
        for (const e of parseFeed(xml)) if (TITLE.test(e.title) && !seen.has(e.link)) { seen.add(e.link); entries.push(e); }
      } catch (error) { console.log(`feed ${feed}: ${error.message}`); }
    }
    const near = wanted(entries, at);
    console.log(`${entries.length} surface charts listed, ${near.length} issued around ${forTime}`);
    const charts = [];
    const dumped = new Set();
    for (const e of near) {
      try {
        const xml = await get(e.link); bytes += xml.length; requests++;
        const c = parseChart(xml);
        c.url = e.link;
        charts.push(c);
        if (dump && !dumped.has(c.kind + c.hours)) {
          dumped.add(c.kind + c.hours);
          // All but the isobars, which are most of the file: the head, the fronts and centres.
          const lean = xml.replace(/<Item>(?:(?!<\/Item>)[\s\S])*?<Type>等圧線<\/Type>[\s\S]*?<\/Item>\s*/g, '');
          console.log(`----- ${e.title} ${e.link} (${xml.length} bytes, ${lean.length} without isobars)\n${lean.slice(0, 60000)}\n----- end`);
        }
      } catch (error) { console.log(`chart ${e.link}: ${error.message}`); }
    }
    out.charts = forObservations(charts, at);
    for (const c of out.charts) {
      console.log(`${c.title}: ${c.kind} ${c.hours}h from ${c.base}, for ${c.valid}, issued ${c.issued}: ` +
        `${c.fronts.length} fronts (${c.fronts.map(f => `${f.type} ${f.points.length} points`).join(', ')})`);
    }
  } catch (error) {
    out.error = error.message;
    console.log(`not fetched: ${error.message}`);
  }
  console.log(`asked the agency ${requests} times for ${(bytes / 1024).toFixed(0)} KB`);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${out.charts.length} charts`);
}

if (require.main === module) main();
module.exports = { parseFeed, parseChart, chartKind, coordinates, forObservations, wanted, stampMs };
