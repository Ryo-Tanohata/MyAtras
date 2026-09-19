#!/usr/bin/env node
'use strict';
// How the clouds moved between each pair of consecutive bundled observations,
// estimated from the observations themselves, for the Unity model to carry them by.
//
//   node scripts/build-motion.cjs                       # dist/weather/sequence -> dist/data/motion
//   node scripts/build-motion.cjs --in DIR --out DIR
//
// The observed wind explains only part of how the clouds actually moved between two
// observations: carried by it, the earlier observation still differs from the later
// one almost as much as if it had not moved at all, and the model has to be pulled
// back at every step. This measures the motion the two observations themselves show.
//
// For every 8-degree block, on a 3-degree grid between 66 S and 66 N, the earlier
// observation's clouds are shifted by every displacement up to 650 km (60 m/s over
// three hours) and compared with the later observation's; the shift that matches best
// is the block's motion. A block counts only as far as it has clouds to match and its
// best match stands out from the others - a clear block, or one that matches equally
// well whichever way it is shifted, says nothing and is left to the observed wind. A
// cloud pattern that did not move is a real answer, zero, and is kept. Outliers are
// replaced by the median of their neighbours and the field is smoothed, weighted by
// confidence.
//
// Clouds are what the globe draws: the 0.38-0.82 brightness threshold, the same as the
// shader. This is an estimate of the motion between two observed times, not an
// observation, and the page says so. It is computed from the bundled files alone, so
// it can be rebuilt anywhere and needs no network.
//
// Output, one per interval, 180 x 90 RGB (2 degrees per texel, row 0 the northernmost):
//   red, green   eastward and northward speed of the cloud pattern, -80..+80 m/s
//   blue         confidence, 0..1
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const png = require('../tools/png.cjs');
const { encodePng } = require('./wind-grid.cjs');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback;
};

const RES = 0.5;              // degrees per sample of the cloud grids
const LAT_MIN = -72;
const ROWS = 288;             // 72 S to 72 N
const COLS = 720;
const STEP = 3;               // degrees between block centres
const BLOCK_REACH = 8;        // samples either side of a block centre: 4 degrees
const MAX_KM = 650;           // furthest a block is searched: 60 m/s for three hours
const KM_PER_DEGREE = 111.195;
const SCALE = 80;             // m/s either way that red and green span
const OUT_W = 180;
const OUT_H = 90;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/// The clouds of one observation on a regular latitude-longitude grid, as the shader
/// draws them. The observations are Web Mercator images.
function cloudGrid(image) {
  const grid = new Float32Array(ROWS * COLS);
  const { width, height, channels, data } = image;
  for (let r = 0; r < ROWS; r++) {
    const lat = LAT_MIN + (r + 0.5) * RES;
    const my = 0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI);
    const fy = my * height - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    for (let c = 0; c < COLS; c++) {
      const lon = -180 + (c + 0.5) * RES;
      const fx = (lon / 360 + 0.5) * width - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      let value = 0;
      for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
        const x = ((x0 + dx) % width + width) % width;
        const y = Math.min(height - 1, Math.max(0, y0 + dy));
        const i = (y * width + x) * channels;
        const luma = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        const alpha = channels === 4 ? data[i + 3] / 255 : 1;
        value += w * smooth(0.38, 0.82, luma) * alpha;
      }
      grid[r * COLS + c] = value;
    }
  }
  return grid;
}

const wrapCol = c => ((c % COLS) + COLS) % COLS;
const clampRow = r => Math.min(ROWS - 1, Math.max(0, r));

/// The best shift of one block from the earlier grid to the later one, in samples.
function matchBlock(earlier, later, row, col, lat) {
  const cos = Math.max(Math.cos(lat * Math.PI / 180), 0.2);
  // Samples of the block, 1 degree apart north-south and about as far east-west.
  const xStep = Math.max(2, Math.round(2 / cos));
  const offsets = [];
  for (let ey = -BLOCK_REACH; ey <= BLOCK_REACH; ey += 2) {
    for (let ex = -BLOCK_REACH; ex <= BLOCK_REACH; ex += 2) offsets.push([ey, Math.round(ex / 2) * xStep]);
  }
  const target = offsets.map(([ey, ex]) => later[clampRow(row + ey) * COLS + wrapCol(col + ex)]);
  const source = offsets.map(([ey, ex]) => earlier[clampRow(row + ey) * COLS + wrapCol(col + ex)]);

  // Is there anything to match? Clouds in either observation, with some structure.
  const all = target.concat(source);
  const mean = all.reduce((s, v) => s + v, 0) / all.length;
  const spread = Math.sqrt(all.reduce((s, v) => s + (v - mean) ** 2, 0) / all.length);
  if (mean < 0.02) return { dy: 0, dx: 0, confidence: 0 };

  const error = (dy, dx) => {
    let sum = 0;
    for (let k = 0; k < offsets.length; k++) {
      const [ey, ex] = offsets[k];
      sum += Math.abs(target[k] - earlier[clampRow(row + ey - dy) * COLS + wrapCol(col + ex - dx)]);
    }
    return sum / offsets.length;
  };

  // Coarse: about a degree apart in both directions, out to MAX_KM.
  const yReach = Math.round(MAX_KM / (KM_PER_DEGREE * RES));
  const xReach = Math.min(COLS / 4, Math.round(yReach / cos));
  const coarseX = Math.max(2, Math.round(2 / cos));
  let best = { dy: 0, dx: 0, e: error(0, 0) };
  let total = 0, count = 0;
  for (let dy = -yReach; dy <= yReach; dy += 2) {
    for (let dx = -Math.round(xReach / coarseX) * coarseX; dx <= xReach; dx += coarseX) {
      // Only within the reach as a distance, not the corners of the search box.
      const km = Math.hypot(dy * RES, dx * RES * cos) * KM_PER_DEGREE;
      if (km > MAX_KM) continue;
      const e = error(dy, dx);
      total += e; count++;
      if (e < best.e - 1e-9) best = { dy, dx, e };
    }
  }
  // Fine: half a degree around the coarse answer.
  const coarseBest = best;
  for (let dy = coarseBest.dy - 2; dy <= coarseBest.dy + 2; dy++) {
    for (let dx = coarseBest.dx - coarseX; dx <= coarseBest.dx + coarseX; dx++) {
      const e = error(dy, dx);
      if (e < best.e - 1e-9) best = { dy, dx, e };
    }
  }

  // Confidence: structure to match, and a best match that stands out from the rest.
  const typical = total / Math.max(1, count);
  const distinct = (typical - best.e) / (typical + 1e-6);
  const confidence = smooth(0.03, 0.12, spread) * smooth(0.1, 0.45, distinct);
  return { dy: best.dy, dx: best.dx, confidence };
}

/// The motion between two observations `seconds` apart, as block velocities in m/s.
function blockMotion(earlier, later, seconds) {
  const lats = [], lons = [];
  for (let lat = -66; lat <= 66; lat += STEP) lats.push(lat);
  for (let lon = -180; lon < 180; lon += STEP) lons.push(lon);
  const u = new Float32Array(lats.length * lons.length);
  const v = new Float32Array(u.length);
  const w = new Float32Array(u.length);
  lats.forEach((lat, i) => {
    const row = Math.round((lat - LAT_MIN) / RES - 0.5);
    const cos = Math.max(Math.cos(lat * Math.PI / 180), 0.2);
    lons.forEach((lon, j) => {
      const col = Math.round((lon + 180) / RES - 0.5);
      const m = matchBlock(earlier, later, row, col, lat);
      const k = i * lons.length + j;
      u[k] = m.dx * RES * KM_PER_DEGREE * 1000 * cos / seconds;
      v[k] = m.dy * RES * KM_PER_DEGREE * 1000 / seconds;
      w[k] = m.confidence;
    });
  });
  return { lats, lons, u, v, w };
}

const median = values => { const s = values.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/// Outliers replaced by the median of their confident neighbours, then smoothed with
/// weights by confidence. Longitude wraps.
function tidy({ lats, lons, u, v, w }) {
  const n = lons.length, at = (i, j) => i * n + ((j % n) + n) % n;
  const mu = new Float32Array(u.length), mv = new Float32Array(u.length);
  for (let i = 0; i < lats.length; i++) {
    for (let j = 0; j < n; j++) {
      const nu = [], nv = [];
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ii = i + di; if (ii < 0 || ii >= lats.length) continue;
        if (w[at(ii, j + dj)] > 0.2) { nu.push(u[at(ii, j + dj)]); nv.push(v[at(ii, j + dj)]); }
      }
      const k = at(i, j);
      if (nu.length >= 3) {
        const cu = median(nu), cv = median(nv);
        // A block far from what its neighbours say is taken to have matched the wrong thing.
        const off = Math.hypot(u[k] - cu, v[k] - cv) > 8;
        mu[k] = off ? cu : u[k]; mv[k] = off ? cv : v[k];
      } else { mu[k] = u[k]; mv[k] = v[k]; }
    }
  }
  const su = new Float32Array(u.length), sv = new Float32Array(u.length), sw = new Float32Array(u.length);
  for (let i = 0; i < lats.length; i++) {
    for (let j = 0; j < n; j++) {
      let tu = 0, tv = 0, tw = 0, wsum = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        const ii = i + di; if (ii < 0 || ii >= lats.length) continue;
        const g = Math.exp(-(di * di + dj * dj) / 2);
        const k = at(ii, j + dj), c = w[k] * g;
        tu += mu[k] * c; tv += mv[k] * c; tw += c; wsum += g;
      }
      const k = at(i, j);
      su[k] = tw > 0 ? tu / tw : 0; sv[k] = tw > 0 ? tv / tw : 0;
      sw[k] = wsum > 0 ? tw / wsum : 0;
    }
  }
  return { lats, lons, u: su, v: sv, w: sw };
}

const encode = speed => Math.round(Math.min(1, Math.max(0, speed / (2 * SCALE) + 0.5)) * 255);

/// The block field on the 2-degree output grid, bilinear, row 0 the northernmost.
function raster({ lats, lons, u, v, w }) {
  const n = lons.length, rgb = Buffer.alloc(OUT_W * OUT_H * 3);
  for (let row = 0; row < OUT_H; row++) {
    const lat = 89 - row * 2;
    for (let col = 0; col < OUT_W; col++) {
      const lon = -179 + col * 2;
      const o = (row * OUT_W + col) * 3;
      const fi = (lat - lats[0]) / STEP;
      if (fi < 0 || fi > lats.length - 1) { rgb[o] = 128; rgb[o + 1] = 128; rgb[o + 2] = 0; continue; }
      const i0 = Math.min(lats.length - 2, Math.floor(fi)), ti = fi - i0;
      const fj = (lon - lons[0]) / STEP, j0 = Math.floor(fj), tj = fj - j0;
      let U = 0, V = 0, W = 0;
      for (const [di, dj, g] of [[0, 0, (1 - ti) * (1 - tj)], [1, 0, ti * (1 - tj)], [0, 1, (1 - ti) * tj], [1, 1, ti * tj]]) {
        const k = (i0 + di) * n + (((j0 + dj) % n) + n) % n;
        U += u[k] * g; V += v[k] * g; W += w[k] * g;
      }
      rgb[o] = encode(U); rgb[o + 1] = encode(V); rgb[o + 2] = Math.round(Math.min(1, W) * 255);
    }
  }
  return rgb;
}

const stampMs = t => Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function build(inDir, outDir) {
  const frames = JSON.parse(fs.readFileSync(path.join(inDir, 'manifest.json'), 'utf8')).globalir
    .slice().sort((a, b) => a.time.localeCompare(b.time));
  fs.mkdirSync(outDir, { recursive: true });
  const grids = frames.map(f => cloudGrid(png.decode(fs.readFileSync(path.join(inDir, f.file)))));
  const intervals = [];
  for (let k = 0; k + 1 < frames.length; k++) {
    const seconds = (stampMs(frames[k + 1].time) - stampMs(frames[k].time)) / 1000;
    const field = tidy(blockMotion(grids[k], grids[k + 1], seconds));
    const bytes = encodePng(OUT_W, OUT_H, raster(field));
    const file = `motion_${frames[k].time.replace('.', '_')}.png`;
    fs.writeFileSync(path.join(outDir, file), bytes);
    const confident = field.w.filter(x => x > 0.5).length / field.w.length;
    intervals.push({
      from: frames[k].time, to: frames[k + 1].time, file,
      // The two observations it was measured from, so a stale field is caught.
      fromSha256: frames[k].sha256, toSha256: frames[k + 1].sha256,
      sha256: sha256(bytes), bytes: bytes.length,
      confidentShare: +confident.toFixed(3),
    });
    process.stdout.write(`  motion ${frames[k].time} -> ${frames[k + 1].time}  ` +
      `${(confident * 100).toFixed(0)}% of blocks confident, ${(bytes.length / 1024).toFixed(0)} KB\n`);
  }
  const keep = new Set(intervals.map(x => x.file));
  for (const name of fs.readdirSync(outDir)) {
    if (name.endsWith('.png') && !keep.has(name)) fs.unlinkSync(path.join(outDir, name));
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    method: 'scripts/build-motion.cjs: block matching of the drawn cloud layer between consecutive ' +
      'observations; 8-degree blocks every 3 degrees within 66 degrees of the equator, searched to ' +
      MAX_KM + ' km; median outlier replacement and confidence-weighted smoothing. An estimate of ' +
      'the motion between two observed times, not an observation.',
    scale: SCALE,
    intervals,
  }, null, 1) + '\n');
  return intervals;
}

module.exports = { build, cloudGrid, blockMotion, tidy, raster, SCALE, OUT_W, OUT_H };

if (require.main === module) {
  const inDir = path.resolve(ROOT, opt('--in', path.join('dist', 'weather', 'sequence')));
  const outDir = path.resolve(ROOT, opt('--out', path.join('dist', 'data', 'motion')));
  const started = Date.now();
  const intervals = build(inDir, outDir);
  console.log(`wrote ${intervals.length} motion fields to ${path.relative(ROOT, outDir) || outDir} ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
