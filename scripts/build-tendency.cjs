#!/usr/bin/env node
'use strict';
// Where tropical cyclones have gone, from where they were: a grid of what storms
// typically did in each part of the world, measured from the best track record.
//
//   node scripts/build-tendency.cjs --tracks path/to/ibtracs.since1980.list.v04r01.csv
//   node scripts/build-tendency.cjs --tracks FILE --out dist/data/tendency.json
//
// The globe can find a storm in the observations but has no idea what one does next, and
// the measured cloud motion does not tell it: at a storm's core, block matching has no
// pattern to match and reports nothing. What a storm does next is not in this week's
// pictures at all. It is in the record of the storms that came before.
//
// So this reads IBTrACS - the archive that gathers every agency's best tracks into one
// file - and asks, for each patch of ocean, which way storms went through it and how
// fast. The answer is the textbook picture, but measured rather than drawn: west-north-west
// under the subtropical ridge, turning north as they reach its western edge, then
// north-east and accelerating once the westerlies take them.
//
// It also keeps how much they disagreed, which matters more than the middle. Over the
// deep tropics four storms in five ran within 45 degrees of the same heading; through the
// turn, barely half did. Whether a storm recurves before Japan or carries on west is
// genuinely not settled by where it is, and a drawing that hid that would be lying. The
// spread is stored so it can be drawn.
//
// Not a forecast, and not this storm. The median of 1,452 storms in the north-west
// Pacific alone, none of them the one on screen. It knows nothing of the ridge this week,
// of what is steering anything now, or of the storm's own size and strength. Carried
// forward from the JMA's analysed position for typhoon 25 of 2026 it landed 126 km from
// their 12-hour forecast and 109 km from their 45-hour one, which is close enough to be
// worth drawing and far enough to be worth labelling.
//
// The archive is a few hundred megabytes and changes only as decades pass, so it is not
// bundled and this is not part of the publish workflow: it is run by hand, and the few
// kilobytes it writes are committed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback;
};

const FROM_SEASON = 1980;     // the steady satellite era, so early tracks do not skew it
const MAX_GAP_HOURS = 6.5;    // best tracks are six-hourly; a longer gap is a broken track
const CELL = 2.5;             // degrees a grid cell spans
const MIN_STEPS = 150;        // how many storm-hours a cell needs before it says anything
const REACHES = [3, 5, 8, 12];// degrees: widened until that many are found
const KM_PER_DEGREE = 111.195;

const toRad = d => d * Math.PI / 180;
const median = values => {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
};
/// Headings are angles: 350 and 10 average to 0, not to 180.
const medianBearing = bearings => {
  const x = median(bearings.map(b => Math.sin(toRad(b))));
  const y = median(bearings.map(b => Math.cos(toRad(b))));
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
};
const turn = (a, b) => ((a - b) + 540) % 360 - 180;
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/// Every six-hourly leg of every tropical cyclone in the file, as a heading and a pace.
function legs(csv) {
  const lines = csv.split('\n');
  const head = lines[0].split(',');
  const col = name => head.indexOf(name);
  const C = {
    sid: col('SID'), season: col('SEASON'), time: col('ISO_TIME'),
    nature: col('NATURE'), lat: col('LAT'), lon: col('LON'), wind: col('USA_WIND'),
  };
  for (const [k, v] of Object.entries(C)) if (v < 0) throw new Error(`no ${k} column in the track file`);
  const tracks = new Map();
  let storms = 0;
  for (let i = 2; i < lines.length; i++) {   // row 1 is the units row
    const c = lines[i].split(',');
    if (c.length < 10 || !c[C.sid]) continue;
    if (+c[C.season] < FROM_SEASON) continue;
    // Tropical only. Once a storm goes extratropical it is steered as a midlatitude low
    // and belongs to a different picture.
    if ((c[C.nature] || '').trim() !== 'TS') continue;
    const lat = parseFloat(c[C.lat]), lon = parseFloat(c[C.lon]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const t = Date.parse((c[C.time] || '').trim().replace(' ', 'T') + 'Z');
    if (!isFinite(t)) continue;
    if (!tracks.has(c[C.sid])) { tracks.set(c[C.sid], []); storms++; }
    tracks.get(c[C.sid]).push({ t, lat, lon, wind: parseFloat(c[C.wind]) || 0 });
  }
  const out = [];
  for (const points of tracks.values()) {
    points.sort((a, b) => a.t - b.t);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const hours = (b.t - a.t) / 3600000;
      if (hours <= 0 || hours > MAX_GAP_HOURS) continue;
      const dy = (b.lat - a.lat) * KM_PER_DEGREE;
      const dx = ((((b.lon - a.lon) + 540) % 360) - 180) * KM_PER_DEGREE
        * Math.cos(toRad((a.lat + b.lat) / 2));
      const km = Math.hypot(dx, dy);
      if (km < 1) continue;                  // a storm that stalled says nothing about heading
      out.push({
        lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2,
        bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
        speed: km / hours,
      });
    }
  }
  return { legs: out, storms };
}

/// What storms did around one point, widening the window until enough of them have been
/// there. A cell with too few even at the widest reach is left out rather than guessed at.
function around(index, lat, lon) {
  for (const reach of REACHES) {
    const found = [];
    const rows = Math.ceil(reach / CELL), cols = Math.ceil(reach * 1.5 / CELL);
    for (let dr = -rows; dr <= rows; dr++) {
      for (let dc = -cols; dc <= cols; dc++) {
        const bucket = index.get(`${Math.floor((lat + 90) / CELL) + dr},${Math.floor((lon + 180) / CELL) + dc}`);
        if (!bucket) continue;
        for (const leg of bucket) {
          if (Math.abs(leg.lat - lat) <= reach
            && Math.abs(((leg.lon - lon + 540) % 360) - 180) <= reach * 1.5) found.push(leg);
        }
      }
    }
    if (found.length >= MIN_STEPS) {
      const bearing = medianBearing(found.map(l => l.bearing));
      const spread = found.map(l => turn(l.bearing, bearing)).sort((a, b) => a - b);
      return {
        bearing, speed: median(found.map(l => l.speed)), n: found.length, reach,
        band50: [quantile(spread, 0.25), quantile(spread, 0.75)],
        band80: [quantile(spread, 0.10), quantile(spread, 0.90)],
      };
    }
  }
  return null;
}

function build(csvPath, outPath) {
  const bytes = fs.readFileSync(csvPath);
  const { legs: all, storms } = legs(bytes.toString('utf8'));
  const index = new Map();
  for (const leg of all) {
    const key = `${Math.floor((leg.lat + 90) / CELL)},${Math.floor((leg.lon + 180) / CELL)}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(leg);
  }
  const cells = {};
  for (let row = 0; row < 180 / CELL; row++) {
    for (let colIndex = 0; colIndex < 360 / CELL; colIndex++) {
      const lat = -90 + (row + 0.5) * CELL, lon = -180 + (colIndex + 0.5) * CELL;
      if (Math.abs(lat) > 60) continue;      // cyclones are tropical; beyond this there are none
      const t = around(index, lat, lon);
      if (!t) continue;
      cells[`${row},${colIndex}`] = [
        +t.bearing.toFixed(1), +t.speed.toFixed(1),
        Math.round(t.band50[0]), Math.round(t.band50[1]),
        Math.round(t.band80[0]), Math.round(t.band80[1]), t.n,
      ];
    }
  }
  const out = {
    method: 'scripts/build-tendency.cjs: the median heading and pace of tropical-stage best '
      + 'track legs near each cell, with how widely they differed. Climatology, not a '
      + 'forecast: the middle of many past storms, none of them the one on screen.',
    source: {
      archive: 'IBTrACS v04r01, NOAA NCEI',
      file: path.basename(csvPath),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      seasonsFrom: FROM_SEASON,
      storms, legs: all.length,
    },
    cell: CELL,
    fields: ['bearing', 'speedKmH', 'band50Low', 'band50High', 'band80Low', 'band80High', 'legs'],
    cells,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out) + '\n');
  return out;
}

/// The tendency at a point, for a grid already built. Returns null off the edge of it.
function tendencyAt(grid, lat, lon) {
  const row = Math.floor((lat + 90) / grid.cell);
  const col = Math.floor((((lon + 180) % 360 + 360) % 360) / grid.cell);
  const cell = grid.cells[`${row},${col}`];
  if (!cell) return null;
  return {
    bearing: cell[0], speed: cell[1],
    band50: [cell[2], cell[3]], band80: [cell[4], cell[5]], legs: cell[6],
  };
}

if (require.main === module) {
  const tracks = opt('--tracks', null);
  if (!tracks) {
    console.error('need --tracks <ibtracs csv>. Download from:');
    console.error('  https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship'
      + '-ibtracs/v04r01/access/csv/ibtracs.since1980.list.v04r01.csv');
    process.exit(2);
  }
  const outPath = path.resolve(opt('--out', path.join(ROOT, 'dist', 'data', 'tendency.json')));
  const out = build(path.resolve(tracks), outPath);
  console.log(`${out.source.storms} storms, ${out.source.legs} legs since ${FROM_SEASON}`);
  console.log(`${Object.keys(out.cells).length} cells of ${CELL} degrees`);
  for (const [name, lat, lon] of [['日本の南', 27.5, 137.5], ['フィリピンの東', 12.5, 132.5],
    ['カリブ海', 17.5, -72.5], ['日本の東', 37.5, 147.5]]) {
    const t = tendencyAt(out, lat, lon);
    console.log(`  ${name.padEnd(12)} ${t ? `${t.bearing.toFixed(0)}° ${t.speed.toFixed(1)} km/h `
      + `(ばらつき ${t.band50[0]}〜+${t.band50[1]}°, ${t.legs}区間)` : '記録なし'}`);
  }
  console.log(`wrote ${path.relative(ROOT, outPath)} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
}

module.exports = { build, legs, around, tendencyAt, medianBearing, turn, CELL, FROM_SEASON, MIN_STEPS };
