#!/usr/bin/env node
'use strict';
// What dist/typhoon.js needs to carry a storm from its last observation to its end,
// measured from the best track record.
//
//   node scripts/build-typhoon.cjs --tracks ibtracs.since1980.list.v04r01.csv
//   node scripts/build-typhoon.cjs --tracks FILE --out dist/data/typhoon.json --tau 12
//
// Three things, all from IBTrACS (NOAA NCEI) except the coastline:
//
// - Motion: for each 2.5-degree cell, the median motion of storms passing through it,
//   kept separately for storms that were still heading west and storms already heading
//   east. The split is what lets a storm recurve: in the turning zone, west-moving storms
//   start drifting north and then east, and once one is moving east it is read against
//   the storms that had already turned - which accelerate north-east. The condition is
//   the previous six hours' motion, so the record answers "given it was going this way,
//   what did it do next", not "what did it do".
// - Strength over the sea: the median change in six hours of storms of the same strength
//   class in the same place. Warm and cold water are in there without a sea temperature:
//   the cold water off Mexico and north of 30 degrees shows up as places storms weaken.
// - Ends at sea: how often, per hour, a tropical storm in each place went extratropical
//   or fell apart. A median change in strength never shows this - an end is rare in any
//   one six hours - and without it the storms that survive to 35 degrees look typical.
// - The land, at half a degree, from dist/assets/land.png (Natural Earth), for the step
//   onto land and Kaplan and DeMaria's inland decay. Its rate is also measured here from
//   the storms that crossed land, and reported beside the published value.
//
// The archive is 137 MB and changes as decades pass. It is not bundled; this runs in
// .github/workflows/typhoon-model.yml, which downloads it, and commits the few hundred
// kilobytes written here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback;
};

const KM_PER_DEGREE = 111.195;
const CELL = 2.5;
const COLS = 360 / CELL;
const MAX_GAP_HOURS = 6.5;      // best tracks are six-hourly; a longer gap is a broken track
const REACHES = [2, 4, 6, 9];   // degrees: widened until enough storms are found
const MIN_MOTION = 60;          // storm legs a cell needs before its motion is said
const MIN_CHANGE = 40;          // and before its change in strength is said
const CLASSES = [34, 64, 96];
const LAND_CELL = 0.5;
const KD = { alpha: 0.095, R: 0.9, Vb: 26.7 };   // Kaplan and DeMaria (1995)

const toRad = d => d * Math.PI / 180;
const median = values => {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
};
const wrap = lon => ((lon + 540) % 360) - 180;

/// Every storm in the file as its points in time order. All natures are kept - a storm
/// that went extratropical still has a position - with each point's nature beside it.
function parseTracks(csv) {
  const lines = csv.split('\n');
  const head = lines[0].split(',').map(s => s.trim());
  const col = name => head.indexOf(name);
  const C = {
    sid: col('SID'), season: col('SEASON'), basin: col('BASIN'), time: col('ISO_TIME'),
    nature: col('NATURE'), lat: col('LAT'), lon: col('LON'), wind: col('USA_WIND'),
    land: col('DIST2LAND'),
  };
  for (const [k, v] of Object.entries(C)) if (v < 0) throw new Error(`no ${k} column in the track file`);
  // The file has about 170 columns and these are all in the first 25; splitting only that
  // far keeps a 137 MB file from becoming sixty million strings.
  const width = Math.max(...Object.values(C)) + 1;
  const storms = new Map();
  for (let i = 2; i < lines.length; i++) {        // row 1 is the units row
    const c = lines[i].split(',', width);
    if (c.length < width || !c[C.sid]) continue;
    const lat = parseFloat(c[C.lat]), lon = parseFloat(c[C.lon]);
    const t = Date.parse((c[C.time] || '').trim().replace(' ', 'T') + 'Z');
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(t)) continue;
    const sid = c[C.sid].trim();
    if (!storms.has(sid)) {
      storms.set(sid, { sid, season: +c[C.season], basin: (c[C.basin] || '').trim(), points: [] });
    }
    const wind = parseFloat(c[C.wind]);
    const land = parseFloat(c[C.land]);
    storms.get(sid).points.push({
      t, lat, lon: wrap(lon), nature: (c[C.nature] || '').trim(),
      kt: isFinite(wind) ? wind : NaN, landKm: isFinite(land) ? land : NaN,
    });
  }
  const out = [...storms.values()];
  for (const s of out) s.points.sort((a, b) => a.t - b.t);
  return out;
}

/// Displacement between two points as km/h east and north.
function velocity(a, b) {
  const hours = (b.t - a.t) / 3600000;
  const dy = (b.lat - a.lat) * KM_PER_DEGREE;
  const dx = wrap(b.lon - a.lon) * KM_PER_DEGREE * Math.cos(toRad((a.lat + b.lat) / 2));
  return { u: dx / hours, v: dy / hours, hours };
}

/// Six-hourly legs of the tropical part of every storm in the seasons asked for, each with
/// the regime the storm was in during the leg before it.
function legs(storms, fromSeason, toSeason) {
  const motion = [], change = [], landDecay = [], ends = [];
  for (const s of storms) {
    if (s.season < fromSeason || s.season > toSeason) continue;
    const p = s.points;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      const vel = velocity(a, b);
      if (vel.hours <= 0 || vel.hours > MAX_GAP_HOURS) continue;
      const mid = { lat: (a.lat + b.lat) / 2, lon: wrap(a.lon + wrap(b.lon - a.lon) / 2) };
      if (a.nature === 'TS' && b.nature === 'TS') {
        let regime = null;
        if (i >= 2) {
          const before = velocity(p[i - 2], a);
          if (before.hours > 0 && before.hours <= MAX_GAP_HOURS) regime = before.u > 2 ? 'east' : 'west';
        }
        motion.push({ ...mid, u: vel.u, v: vel.v, regime });
      }
      // Ends at sea: every hour a tropical storm of at least 34 kt spent over the sea, and
      // whether the leg is where it went extratropical or fell apart.
      if (a.nature === 'TS' && a.landKm > 0 && a.kt >= CLASSES[0]) {
        ends.push({ ...mid, hours: vel.hours, ended: b.nature === 'ET' || b.nature === 'DS' });
      }
      // Strength: tropical at the start, a measured wind at both ends.
      if (a.nature !== 'TS' || !isFinite(a.kt) || !isFinite(b.kt) || a.kt < CLASSES[0]) continue;
      const per6 = (b.kt - a.kt) * 6 / vel.hours;
      if (a.landKm > 0 && b.landKm > 0) {
        change.push({ ...mid, cls: a.kt >= CLASSES[2] ? 2 : a.kt >= CLASSES[1] ? 1 : 0, per6 });
      } else if (a.landKm === 0 && b.landKm === 0 && a.kt > KD.Vb + 5 && b.kt > KD.Vb) {
        landDecay.push(-Math.log((b.kt - KD.Vb) / (a.kt - KD.Vb)) / vel.hours);
      }
    }
  }
  return { motion, change, landDecay, ends };
}

/// Buckets things with a lat/lon by 2.5-degree cell, for the widening search below.
function bucket(items) {
  const index = new Map();
  for (const it of items) {
    const key = Math.floor((it.lat + 90) / CELL) * COLS + Math.floor((wrap(it.lon) + 180) / CELL) % COLS;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(it);
  }
  return index;
}

/// Everything within a widening reach of a cell centre, until at least `min` are found.
function gather(index, lat, lon, min, keep) {
  for (const reach of REACHES) {
    const found = [];
    const rows = Math.ceil(reach / CELL), cols = Math.ceil(reach * 1.5 / CELL);
    const r0 = Math.floor((lat + 90) / CELL), c0 = Math.floor((lon + 180) / CELL);
    for (let dr = -rows; dr <= rows; dr++) {
      for (let dc = -cols; dc <= cols; dc++) {
        const items = index.get((r0 + dr) * COLS + ((c0 + dc) % COLS + COLS) % COLS);
        if (!items) continue;
        for (const it of items) {
          if (!keep(it)) continue;
          if (Math.abs(it.lat - lat) <= reach && Math.abs(wrap(it.lon - lon)) <= reach * 1.5) found.push(it);
        }
      }
    }
    if (found.length >= min) return found;
  }
  return null;
}

/// The model data from the seasons asked for. Returned as the object dist/typhoon.js reads.
function buildModel(storms, { fromSeason = 1980, toSeason = 9999, tau = 12, land = null } = {}) {
  const { motion, change, landDecay, ends } = legs(storms, fromSeason, toSeason);
  const motionIndex = bucket(motion);
  const changeIndex = bucket(change);
  const endIndex = bucket(ends);
  const hazard = [];
  const grids = { west: [], east: [], all: [] };
  const intensity = [];
  for (let row = 0; row < 180 / CELL; row++) {
    const lat = -90 + (row + 0.5) * CELL;
    if (Math.abs(lat) > 60) continue;
    for (let col = 0; col < COLS; col++) {
      const lon = -180 + (col + 0.5) * CELL;
      for (const regime of ['west', 'east', 'all']) {
        const found = gather(motionIndex, lat, lon, MIN_MOTION,
          regime === 'all' ? () => true : it => it.regime === regime);
        if (!found) continue;
        grids[regime].push(row, col, +median(found.map(f => f.u)).toFixed(2),
          +median(found.map(f => f.v)).toFixed(2), found.length);
      }
      for (let cls = 0; cls < CLASSES.length; cls++) {
        const found = gather(changeIndex, lat, lon, MIN_CHANGE, it => it.cls === cls);
        if (!found) continue;
        intensity.push(row, col, cls, +median(found.map(f => f.per6)).toFixed(2), found.length);
      }
      const seen = gather(endIndex, lat, lon, MIN_MOTION, () => true);
      if (seen) {
        const hours = seen.reduce((sum, e) => sum + e.hours, 0);
        const ended = seen.filter(e => e.ended).length;
        hazard.push(row, col, +(ended / hours).toFixed(5), seen.length);
      }
    }
  }
  const measuredAlpha = median(landDecay.filter(a => isFinite(a)));
  return {
    method: 'scripts/build-typhoon.cjs: median motion of past storms per 2.5-degree cell, split by '
      + 'whether they were heading west or already east; median six-hour change in strength over the '
      + 'sea by strength class; Kaplan and DeMaria inland decay. What past storms did, not a forecast.',
    seasons: [fromSeason, Math.min(toSeason, Math.max(...storms.map(s => s.season)))],
    counts: { motionLegs: motion.length, changeLegs: change.length, landLegs: landDecay.length,
      seaLegs: ends.length, endsAtSea: ends.filter(e => e.ended).length },
    params: {
      tau, alpha: KD.alpha, R: KD.R, Vb: KD.Vb, endKt: CLASSES[0],
      measuredAlpha: isFinite(measuredAlpha) ? +measuredAlpha.toFixed(4) : null,
    },
    motion: { cell: CELL, fields: ['row', 'col', 'uKmH', 'vKmH', 'n'], ...grids },
    intensity: { cell: CELL, classes: CLASSES, fields: ['row', 'col', 'class', 'ktPer6h', 'n'],
      fallback: -4, cells: intensity },
    hazard: { cell: CELL, fields: ['row', 'col', 'perHour', 'n'], cells: hazard },
    land,
  };
}

/// dist/assets/land.png (red 255 over land, equirectangular, -180 at the left, +90 at the
/// top) reduced to a half-degree grid by majority, packed as bits.
function landMask(pngPath = path.join(ROOT, 'dist', 'assets', 'land.png')) {
  const png = require(path.join(ROOT, 'tools', 'png.cjs'));
  const image = png.decode(fs.readFileSync(pngPath));
  const width = Math.round(360 / LAND_CELL), height = Math.round(180 / LAND_CELL);
  const sx = image.width / width, sy = image.height / height;
  const bits = new Uint8Array(Math.ceil(width * height / 8));
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      let land = 0, total = 0;
      for (let y = Math.floor(r * sy); y < Math.floor((r + 1) * sy); y++) {
        for (let x = Math.floor(c * sx); x < Math.floor((c + 1) * sx); x++) {
          if (image.data[(y * image.width + x) * image.channels] > 127) land++;
          total++;
        }
      }
      if (land * 2 > total) { const i = r * width + c; bits[i >> 3] |= 1 << (7 - (i & 7)); }
    }
  }
  return { cell: LAND_CELL, width, height, source: 'dist/assets/land.png (Natural Earth 1:50m)',
    bits: Buffer.from(bits).toString('base64') };
}

module.exports = { parseTracks, legs, buildModel, landMask, velocity, CLASSES, KD };

if (require.main === module) {
  const tracks = opt('--tracks', null);
  if (!tracks) {
    console.error('need --tracks <ibtracs csv>. Download from:');
    console.error('  https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship'
      + '-ibtracs/v04r01/access/csv/ibtracs.since1980.list.v04r01.csv');
    process.exit(2);
  }
  // The persistence time comes from the backtest when there is one: it is chosen there on
  // the older storms only, then used here for the model built from all of them.
  let tau = Number(opt('--tau', NaN));
  const report = path.join(ROOT, 'records', 'typhoon-hindcast.json');
  if (!isFinite(tau) && fs.existsSync(report)) tau = JSON.parse(fs.readFileSync(report, 'utf8')).chosenTau;
  if (!isFinite(tau)) tau = 12;
  const outPath = path.resolve(opt('--out', path.join(ROOT, 'dist', 'data', 'typhoon.json')));
  const bytes = fs.readFileSync(path.resolve(tracks));
  const storms = parseTracks(bytes.toString('utf8'));
  const model = buildModel(storms, { fromSeason: 1980, tau, land: landMask() });
  model.source = {
    archive: 'IBTrACS v04r01, NOAA NCEI',
    file: path.basename(tracks),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    storms: storms.filter(s => s.season >= 1980).length,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(model) + '\n');
  console.log(`${model.source.storms} storms from ${model.seasons[0]} to ${model.seasons[1]}`);
  console.log(`motion cells: west ${model.motion.west.length / 5}, east ${model.motion.east.length / 5}, `
    + `all ${model.motion.all.length / 5}; strength cells ${model.intensity.cells.length / 5}`);
  console.log(`ends at sea: ${model.counts.endsAtSea} in ${model.counts.seaLegs} legs; `
    + `hazard cells ${model.hazard.cells.length / 4}`);
  console.log(`inland decay: published ${KD.alpha}/h, measured ${model.params.measuredAlpha}/h `
    + `from ${model.counts.landLegs} legs over land; persistence ${tau} h`);
  console.log(`wrote ${path.relative(ROOT, outPath)} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
}
