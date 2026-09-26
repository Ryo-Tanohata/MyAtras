#!/usr/bin/env node
'use strict';
// The Japan Meteorological Agency's current typhoon forecasts, for the simulation to follow.
//
//   node scripts/fetch-jma-typhoon.cjs                 # -> dist/data/jma-typhoon.json
//   node scripts/fetch-jma-typhoon.cjs --dump          # also prints the newest report
//
// The typhoon object of dist/typhoon.js moves the way past storms moved through the same
// place, and knows nothing of this week's pressure pattern: on 2026-09-26 it carried
// typhoon 26 north-west into China while the agency forecast it to turn north-east
// towards Japan. Where the agency has a forecast, the simulation now follows it.
//
// Read from the agency's disaster-information XML (気象防災情報XML), the documented feed
// its own services are built on: the long-term feed lists every "台風解析・予報情報" issued
// over the past days, and each report holds the analysed centre and the forecast centres,
// forecast circles, central pressure and maximum wind out to five days. Only the newest
// report of each typhoon is kept.
//
// Run where the agency can be reached - the GitHub runner, from the publishing workflow;
// agent containers get 403. Best effort: a failure writes a file with no storms and the
// reason, and exits 0, so the site is still published and the simulation falls back to
// the typhoon object's own motion. The page says whose forecast it is following.
const fs = require('fs');
const path = require('path');

const FEEDS = [
  'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml',
  'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
];
const OUT = path.join(__dirname, '..', 'dist', 'data', 'jma-typhoon.json');
const TITLE = /台風解析・予報情報/;
const MAX_REPORTS = 40;
const KNOTS_PER_MS = 1 / 0.514444;

/// Undoes the XML escapes a text node can hold.
const text = s => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

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

/// "+21.5+126.5/" (or with an altitude, or "-" signs) as [lat, lon].
function coordinate(value) {
  const m = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(value || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const first = (re, s) => { const m = re.exec(s); return m ? text(m[1]) : null; };
const number = (re, s) => { const v = first(re, s); return v === null || v === '' ? null : Number(v); };

/// One report: the typhoon it is about and its centre at each time it gives.
function parseReport(xml) {
  const issued = first(/<Head\b[^>]*>[\s\S]*?<ReportDateTime>([^<]+)<\/ReportDateTime>/, xml)
    || first(/<ReportDateTime>([^<]+)<\/ReportDateTime>/, xml);
  const status = first(/<Control>[\s\S]*?<Status>([^<]+)<\/Status>/, xml);
  const infoType = first(/<Head\b[^>]*>[\s\S]*?<InfoType>([^<]+)<\/InfoType>/, xml);
  // The agency's own identifier for the disturbance, kept from a tropical depression's
  // first report to its last as a typhoon; the typhoon number only comes when it is named.
  const eventId = first(/<Head\b[^>]*>[\s\S]*?<EventID>([^<]+)<\/EventID>/, xml);
  const numberText = first(/<TyphoonNamePart>[\s\S]*?<Number>([^<]*)<\/Number>/, xml);
  const name = first(/<TyphoonNamePart>[\s\S]*?<Name>([^<]*)<\/Name>/, xml);
  const kana = first(/<TyphoonNamePart>[\s\S]*?<NameKana>([^<]*)<\/NameKana>/, xml);
  const infos = /<MeteorologicalInfos[^>]*type="台風情報"[^>]*>([\s\S]*?)<\/MeteorologicalInfos>/.exec(xml);
  const points = [];
  for (const m of (infos ? infos[1] : xml).matchAll(/<MeteorologicalInfo>([\s\S]*?)<\/MeteorologicalInfo>/g)) {
    const body = m[1];
    const when = /<DateTime[^>]*type="([^"]*)"[^>]*>([^<]+)<\/DateTime>/.exec(body);
    if (!when) continue;
    const kind = /実況/.test(when[1]) ? 'analysis' : /推定/.test(when[1]) ? 'estimate' : /予報/.test(when[1]) ? 'forecast' : null;
    if (!kind) continue;
    const where = coordinate(first(/type="中心位置（度）"[^>]*>([^<]+)</, body));
    if (!where) continue;
    // Attributes come in any order: the agency writes unit before type.
    const wind = unit => {
      for (const w of body.matchAll(/<jmx_eb:WindSpeed([^>]*)>([^<]*)</g)) {
        if (/type="最大風速"/.test(w[1]) && w[1].includes(`unit="${unit}"`) && w[2].trim() !== '') return Number(w[2]);
      }
      return null;
    };
    let windKt = wind('ノット');
    if (windKt === null) {
      const ms = wind('m/s');
      if (ms !== null) windKt = Math.round(ms * KNOTS_PER_MS);
    }
    const circle = /<ProbabilityCircle[^>]*type="予報円"[^>]*>([\s\S]*?)<\/ProbabilityCircle>/.exec(body);
    points.push({
      time: new Date(when[2]).toISOString(),
      kind,
      lat: where[0], lon: where[1],
      pressure: number(/type="中心気圧"[^>]*>([^<]*)</, body),
      windKt,
      circleKm: circle ? number(/<jmx_eb:Radius[^>]*unit="km"[^>]*>([^<]*)</, circle[1]) : null,
      class: first(/<jmx_eb:TyphoonClass[^>]*>([^<]*)</, body),
    });
  }
  points.sort((a, b) => a.time.localeCompare(b.time));
  return {
    eventId, number: numberText || null, name, kana,
    issued: issued ? new Date(issued).toISOString() : null,
    status, infoType, points,
  };
}

/// The newest usable report of each typhoon, from reports already parsed. Cancellations
/// and drills are left out, as is a report with no centre in it, and - given now - one
/// issued more than a day before or whose forecast has already run out: the feed keeps
/// days of reports, and a storm that stopped being reported has ended.
function newestPerTyphoon(reports, now = null) {
  const best = new Map();
  for (const r of reports) {
    if (!r.issued || !r.points.some(p => p.kind === 'analysis')) continue;
    if (now !== null && (Date.parse(r.issued) < now - 24 * 3600000 || Date.parse(r.points[r.points.length - 1].time) < now)) continue;
    if (r.status && r.status !== '通常') continue;
    if (r.infoType && /取消/.test(r.infoType)) continue;
    const key = r.eventId || r.number || `${r.name}|${r.points[0].lat}`;
    if (!best.has(key) || best.get(key).issued < r.issued) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => (a.eventId || a.number || '').localeCompare(b.eventId || b.number || ''));
}

async function get(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'MyAtras (+https://github.com/Ryo-Tanohata/MyAtras)' } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.text();
}

async function main() {
  const dump = process.argv.includes('--dump');
  const out = { source: '気象庁 気象防災情報XML（台風解析・予報情報）', feed: FEEDS[0], fetched: new Date().toISOString(), storms: [] };
  try {
    const seen = new Set(), entries = [];
    for (const feed of FEEDS) {
      try {
        for (const e of parseFeed(await get(feed))) if (TITLE.test(e.title) && !seen.has(e.link)) { seen.add(e.link); entries.push(e); }
      } catch (error) { console.log(`feed ${feed}: ${error.message}`); }
    }
    entries.sort((a, b) => b.updated.localeCompare(a.updated));
    console.log(`${entries.length} typhoon reports listed`);
    const reports = [];
    for (const e of entries.slice(0, MAX_REPORTS)) {
      try {
        const xml = await get(e.link);
        const r = parseReport(xml);
        r.url = e.link;
        reports.push(r);
        if (dump && reports.length === 1) console.log(xml.slice(0, 12000));
      } catch (error) { console.log(`report ${e.link}: ${error.message}`); }
    }
    out.storms = newestPerTyphoon(reports, Date.now());
    for (const s of out.storms) {
      const a = s.points.find(p => p.kind === 'analysis');
      console.log(`${s.eventId} typhoon ${s.number} ${s.kana || s.name || ''}: issued ${s.issued}, centre ${a.lat}N ${a.lon}E at ${a.time}, ` +
        `${s.points.filter(p => p.kind === 'forecast').length} forecast points to ${s.points.at(-1).time}`);
    }
  } catch (error) {
    out.error = error.message;
    console.log(`not fetched: ${error.message}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${out.storms.length} typhoons`);
}

if (require.main === module) main();
module.exports = { parseFeed, parseReport, newestPerTyphoon, coordinate };
