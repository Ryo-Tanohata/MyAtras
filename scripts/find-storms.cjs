#!/usr/bin/env node
'use strict';
// The tropical cyclones in the bundled observations, found from the observations alone.
//
//   node scripts/find-storms.cjs                        # dist/weather/sequence -> dist/data/storms.json
//   node scripts/find-storms.cjs --in DIR --out FILE
//
// A globe drawn from hourly pictures has no idea what a typhoon is: between two
// observations the measured motion at a storm's core is near zero, because block
// matching needs a pattern to match and a thick canopy is as featureless as clear sky,
// so the model leaves the storm where it is and the crossfade does the rest. Knowing
// where the storm is, and where it has been going, is the first thing needed before it
// can be carried any better than that.
//
// One picture will not say. At 512 pixels for the whole globe a typhoon is about seven
// pixels across, far too few to read a spiral from, and a compact mass of deep cold
// cloud is the commonest thing in the tropics - afternoon storms over Africa, clusters
// along the intertropical convergence zone. What separates a cyclone from those is not
// its shape in one frame but what it does over days: it holds together, and it travels.
// Convection over land comes and goes in the same place; a cluster lasts hours.
//
// So there are two stages, because neither does both jobs:
//
//   find    connected areas of cloud colder than the threshold, to notice a system that
//           is not yet being followed. Used for seeding only.
//   follow  once a system is known, the cold core nearest to where it was heading,
//           weighted towards the predicted point. This is what keeps the centre on the
//           storm when its canopy merges into a frontal band - the connected area's
//           centroid would run away down the front, this does not.
//
// A track is then judged on: how long it lasted, how few hours it went missing, how
// straight it ran, how fast, how steadily (a track that hops between separate bursts of
// convection lurches; a cyclone does not), whether it moved polewards, and whether it
// stayed clear of the equator, where the Coriolis force is too weak for a cyclone to
// form at all.
//
// What this is not. The position is the centre of the cold cloud, which is the storm's
// centre only while the storm is organised. Measured against the Japan Meteorological
// Agency's own analysed track for typhoon 25 (Dujuan) of 2026 - used to check this, not
// shipped or depended on - the mature storm came back to a median 74 km, about one pixel,
// every hour of it inside 200 km. The same storm three days earlier, while it was still a
// developing depression, came back to a median 596 km: wind shear sets the deep convection
// away from the circulation, and this follows the convection.
//
// Nothing here tells those two cases apart. Each point carries how disc-like its core is,
// on the guess that an organised storm would look rounder, but over those two windows the
// measure barely moves - a median of 2.54 against 2.22, on distributions that overlap
// almost entirely - so it is recorded as a hint and must not be read as a confidence. A
// track is equally confident when it is 74 km out and when it is 596 km out, and until
// that is solved none of this is a storm position in the sense a forecaster means. The
// thresholds below were chosen against those two windows and no others.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const png = require('../tools/png.cjs');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback;
};

const COLD = 206;             // 8-bit brightness: only deep, cold cloud tops
const MIN_PIXELS = 6;         // smaller than this is noise, not a system
const POLE = 50;              // degrees: beyond this a system is no longer tropical
const SEED_KM = 200;          // a new system must be this far from every one already followed
const GAP = 6;                // hours a core may stay below the threshold and still be the same storm
const REACH_KM = 260;         // how far from the predicted point the core is looked for
const SIGMA_KM = 140;         // and how sharply that search is weighted towards it
const MERGE_KM = 250;         // two tracks this close, this often, are one storm seen twice

// A cyclone, as opposed to everything else that is cold and lasts:
const MIN_SPAN = 24;          // hours from first sighting to last
const MIN_SEEN = 0.7;         // of those hours, the share it was actually found in
const MIN_SPEED = 6;          // km/h - slower than this is convection sitting still
const MAX_SPEED = 45;         // km/h - faster is a track hopping between systems
const MAX_WOBBLE = 0.8;       // spread of the hourly speeds over their mean
const MIN_STRAIGHT = 0.35;    // end-to-end distance over distance travelled
const MIN_POLEWARD = -1;      // degrees: cyclones drift polewards, on the whole
const MIN_ABS_LAT = 8;        // no cyclone forms on the equator

const KM_PER_DEGREE = 111.195;

const km = (aLat, aLon, bLat, bLon) => {
  const dy = (aLat - bLat) * KM_PER_DEGREE;
  const dx = ((((aLon - bLon) + 540) % 360) - 180) * KM_PER_DEGREE
    * Math.cos((aLat + bLat) / 2 * Math.PI / 180);
  return Math.hypot(dx, dy);
};

/// One observation, with the Web Mercator arithmetic that turns pixels into degrees.
function frame(file) {
  const im = png.decode(fs.readFileSync(file));
  const { width: W, height: H, channels: C, data } = im;
  const lats = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    lats[y] = (2 * Math.atan(Math.exp((0.5 - (y + 0.5) / H) * 2 * Math.PI)) - Math.PI / 2) * 180 / Math.PI;
  }
  const kmPerPixel = 40075 / W;
  return {
    W, H, kmPerPixel, lats,
    at: (x, y) => data[(y * W + (((x % W) + W) % W)) * C],
    lonOf: x => ((x + 0.5) / W) * 360 - 180,
    xOf: lon => Math.round(((lon + 180) / 360) * W - 0.5),
    yOf: lat => Math.round((0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI)) * H - 0.5),
  };
}

/// How much of a disc a set of weighted points is: 2 for a uniform disc, less as it
/// stretches out. This is what separates an organised storm from scattered convection.
function discLike(points, area, cLat, cLon) {
  let r2 = 0, wt = 0;
  for (const p of points) {
    const dy = (p.lat - cLat) * KM_PER_DEGREE;
    const dx = ((((p.lon - cLon) + 540) % 360) - 180) * KM_PER_DEGREE
      * Math.cos((p.lat + cLat) / 2 * Math.PI / 180);
    r2 += p.w * (dx * dx + dy * dy);
    wt += p.w;
  }
  const rms = Math.sqrt(r2 / Math.max(wt, 1e-9));
  return { rms, circ: rms > 0 ? area / (Math.PI * rms * rms) : 0 };
}

/// Weighted mean position on the sphere, so a system astride the antimeridian does not
/// average out to the far side of the world.
function centre(points) {
  let sx = 0, sy = 0, sz = 0, w = 0;
  for (const p of points) {
    const la = p.lat * Math.PI / 180, lo = p.lon * Math.PI / 180;
    sx += p.w * Math.cos(la) * Math.cos(lo);
    sy += p.w * Math.cos(la) * Math.sin(lo);
    sz += p.w * Math.sin(la);
    w += p.w;
  }
  const n = Math.hypot(sx, sy, sz);
  if (!n || !w) return null;
  return { lat: Math.asin(sz / n) * 180 / Math.PI, lon: Math.atan2(sy, sx) * 180 / Math.PI };
}

/// Stage one: every connected area of deep cold cloud. Seeding only - most of what comes
/// back is ordinary tropical convection, which the track tests throw away later.
function find(F) {
  const { W, H, at, lats, lonOf, kmPerPixel } = F;
  const seen = new Uint8Array(W * H);
  const out = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || at(s % W, (s / W) | 0) < COLD) continue;
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    const cells = [];
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      const y = (k / W) | 0, x = k % W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        const nx = (((x + dx) % W) + W) % W, nk = ny * W + nx;
        if (!seen[nk] && at(nx, ny) >= COLD) { seen[nk] = 1; stack.push(nk); }
      }
    }
    if (cells.length < MIN_PIXELS) continue;
    // A Mercator pixel covers cos^2(lat) of what one at the equator does.
    const points = cells.map(k => {
      const lat = lats[(k / W) | 0], c = Math.cos(lat * Math.PI / 180);
      return { lat, lon: lonOf(k % W), w: c * c };
    });
    const c = centre(points);
    if (!c || Math.abs(c.lat) > POLE) continue;
    const area = points.reduce((s2, p) => s2 + p.w, 0) * kmPerPixel * kmPerPixel;
    out.push({ ...c, area, ...discLike(points, area, c.lat, c.lon) });
  }
  return out;
}

/// Stage two: the cold core near where the storm was heading. Brightness above the
/// threshold, weighted towards the predicted point, so a front joining the canopy cannot
/// drag the centre off the storm.
function follow(F, lat0, lon0, reachKm = REACH_KM) {
  const { W, H, at, lats, lonOf, xOf, yOf, kmPerPixel } = F;
  const y0 = yOf(lat0), x0 = xOf(lon0);
  const span = Math.ceil(reachKm / (kmPerPixel * 0.5)) + 1;
  const points = [];
  let peak = 0;
  for (let y = Math.max(0, y0 - span); y <= Math.min(H - 1, y0 + span); y++) {
    const lat = lats[y], c = Math.cos(lat * Math.PI / 180);
    for (let x = x0 - span; x <= x0 + span; x++) {
      const b = at(x, y);
      if (b < COLD) continue;
      const lon = lonOf(((x % W) + W) % W);
      const d = km(lat, lon, lat0, lon0);
      if (d > reachKm) continue;
      if (b > peak) peak = b;
      points.push({ lat, lon, w: (b - COLD + 1) * Math.exp(-(d * d) / (2 * SIGMA_KM * SIGMA_KM)) * c * c,
        area: c * c });
    }
  }
  // By area, not by how many pixels: a pixel near the pole covers a fraction of one at
  // the equator, and counting pixels would let a track drop the storm at the very hours
  // its core thins - which is when it is about to be handed to a fresh track instead.
  const area = points.reduce((s, p) => s + p.area, 0) * kmPerPixel * kmPerPixel;
  if (area < MIN_PIXELS * kmPerPixel * kmPerPixel * 0.5) return null;
  const c = centre(points);
  if (!c) return null;
  return { ...c, area, peak, ...discLike(points, area, c.lat, c.lon) };
}

/// Follow every system through the sequence, then keep the ones that behave like cyclones.
function track(files, times) {
  const tracks = [];
  files.forEach((file, fi) => {
    const F = frame(file);
    for (const t of tracks) {
      const skip = fi - t.last;
      if (skip < 1 || skip > GAP) continue;
      const n = t.points.length, a = t.points[n - 1], b = n > 1 ? t.points[n - 2] : null;
      const lat = b ? a.lat + (a.lat - b.lat) * skip : a.lat;
      const lon = b ? a.lon + (a.lon - b.lon) * skip : a.lon;
      const c = follow(F, lat, lon, REACH_KM + 70 * (skip - 1));
      if (c) { t.points.push({ ...c, time: times[fi], index: fi }); t.last = fi; }
    }
    const live = tracks.filter(t => fi - t.last <= GAP);
    for (const c of find(F)) {
      const last = t => t.points[t.points.length - 1];
      if (live.some(t => km(last(t).lat, last(t).lon, c.lat, c.lon) < SEED_KM)) continue;
      tracks.push({ points: [{ ...c, time: times[fi], index: fi }], first: fi, last: fi });
    }
  });
  return judge(dedupe(tracks));
}

/// One storm followed by two tracks - a core drops out for longer than the gap and is
/// seeded afresh while the older track is still near - counts once, as the longer track.
function dedupe(tracks) {
  const order = tracks.slice().sort((a, b) => b.points.length - a.points.length);
  const keep = [];
  for (const t of order) {
    const twin = keep.some(k => {
      let both = 0, near = 0;
      for (const p of t.points) {
        const q = k.points.find(x => x.index === p.index);
        if (!q) continue;
        both++;
        if (km(p.lat, p.lon, q.lat, q.lon) < MERGE_KM) near++;
      }
      return both >= 3 && near / both > 0.5;
    });
    if (!twin) keep.push(t);
  }
  return keep;
}

/// A single pixel of wobble in the weighted centre is tens of kilometres, which would
/// swamp a storm moving 20 km/h. Smooth over three hours before judging how it moved.
function smooth(points) {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], c = points[Math.min(points.length - 1, i + 1)];
    return { ...p, lat: (a.lat + p.lat + c.lat) / 3, lon: (a.lon + p.lon + c.lon) / 3 };
  });
}

function judge(tracks) {
  return tracks.map(t => {
    const points = smooth(t.points);
    const n = points.length;
    const span = t.last - t.first + 1;
    const net = km(points[0].lat, points[0].lon, points[n - 1].lat, points[n - 1].lon);
    const steps = [];
    let path = 0;
    for (let i = 1; i < n; i++) {
      const d = km(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      steps.push(d / Math.max(1, points[i].index - points[i - 1].index));
      path += d;
    }
    const speed = steps.length ? steps.reduce((s, v) => s + v, 0) / steps.length : 0;
    const wobble = speed > 0 && steps.length
      ? Math.sqrt(steps.reduce((s, v) => s + (v - speed) ** 2, 0) / steps.length) / speed
      : Infinity;
    const meanAbsLat = points.reduce((s, p) => s + Math.abs(p.lat), 0) / n;
    // The whole track has to stay out of the equatorial band, not average its way out of
    // it. A mean let a system through that reached down to 7.4 degrees over northern
    // South America, where the Coriolis force cannot hold a cyclone together and the
    // ITCZ makes cold round cloud every afternoon; the track that ran through it was
    // convection, not a storm. tests/find-storms.test.cjs already asked for every point
    // of every bundled track to be off the band, which is this rule and not the mean.
    const minAbsLat = points.reduce((s, p) => Math.min(s, Math.abs(p.lat)), Infinity);
    const shape = points.reduce((s, p) => s + p.circ, 0) / n;
    const m = {
      span, seen: n, completeness: n / span, net, straightness: path > 0 ? net / path : 0,
      speed, wobble, poleward: Math.abs(points[n - 1].lat) - Math.abs(points[0].lat),
      meanAbsLat, minAbsLat, shape,
    };
    return {
      ...m,
      cyclone: span >= MIN_SPAN && m.completeness >= MIN_SEEN && speed >= MIN_SPEED
        && speed <= MAX_SPEED && wobble <= MAX_WOBBLE && m.straightness >= MIN_STRAIGHT
        && m.poleward > MIN_POLEWARD && minAbsLat >= MIN_ABS_LAT,
      points: points.map(p => ({
        time: p.time,
        lat: +p.lat.toFixed(2),
        lon: +p.lon.toFixed(2),
        circ: +p.circ.toFixed(2),       // how disc-like the core is: high where the centre can be trusted
      })),
    };
  }).sort((a, b) => (b.cyclone - a.cyclone) || (b.span * b.straightness - a.span * a.straightness));
}

const METHOD = 'scripts/find-storms.cjs: cold-cloud areas seeded from each observation and '
  + 'followed through the sequence by the cold core nearest where each system was heading; '
  + 'kept when it lasts, travels, and does so steadily. The centre of the cold cloud, which '
  + 'is the storm centre only while the storm is organised - see the circ of each point. '
  + 'Not a storm position in the sense a forecaster means, and not a forecast.';

function build(inDir, outPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(inDir, 'manifest.json'), 'utf8')).globalir
    .slice().sort((a, b) => a.time.localeCompare(b.time));
  const files = manifest.map(f => path.join(inDir, f.file));
  const found = track(files, manifest.map(f => f.time));
  const storms = found.filter(s => s.cyclone);
  const out = {
    method: METHOD,
    from: manifest[0].time,
    to: manifest[manifest.length - 1].time,
    frames: manifest.map(f => ({ time: f.time, sha256: f.sha256 })),
    candidates: found.length,
    storms: storms.map(s => ({
      from: s.points[0].time,
      to: s.points[s.points.length - 1].time,
      hours: s.span,
      seen: s.seen,
      travelledKm: Math.round(s.net),
      speedKmH: +s.speed.toFixed(1),
      straightness: +s.straightness.toFixed(2),
      polewardDegrees: +s.poleward.toFixed(1),
      shape: +s.shape.toFixed(2),
      points: s.points,
    })),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
  return out;
}

if (require.main === module) {
  const inDir = path.resolve(opt('--in', path.join(ROOT, 'dist', 'weather', 'sequence')));
  const outPath = path.resolve(opt('--out', path.join(ROOT, 'dist', 'data', 'storms.json')));
  const out = build(inDir, outPath);
  console.log(`${out.frames.length} observations ${out.from} -> ${out.to}`);
  console.log(`  ${out.candidates} systems followed, ${out.storms.length} behaved like a cyclone`);
  for (const s of out.storms) {
    const a = s.points[0], b = s.points[s.points.length - 1];
    console.log(`  ${s.from} -> ${s.to}  ${s.hours}h  ${a.lat}N ${a.lon}E -> ${b.lat}N ${b.lon}E`
      + `  ${s.travelledKm} km, ${s.speedKmH} km/h, shape ${s.shape}`);
  }
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

module.exports = {
  build, track, frame, find, follow, km, discLike,
  COLD, GAP, MIN_SPAN, MIN_ABS_LAT, MIN_SPEED, MAX_SPEED, METHOD,
};
