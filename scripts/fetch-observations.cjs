#!/usr/bin/env node
'use strict';
// Replace the bundled observations with the newest ones SSEC is serving.
//
//   node scripts/fetch-observations.cjs                  # the 13 newest observations
//   node scripts/fetch-observations.cjs --frames 25      # more of them
//   node scripts/fetch-observations.cjs --every 30       # one every 30 minutes
//   node scripts/fetch-observations.cjs --frames 25 --every 30   # 12 hours, twice as fine
//   node scripts/fetch-observations.cjs --wind           # also rebuild dist/data/amv.json
//   node scripts/fetch-observations.cjs --out /tmp/try   # write somewhere else
//   node scripts/fetch-observations.cjs --region         # also a close-up of Japan
//
//   # Three days, one observation every three hours, with the wind at each of them:
//   node scripts/fetch-observations.cjs --span 72 --frames 24 --every 180 --winds
//
// --span is how many hours back SSEC is asked to list (24 unless given). SSEC keeps
// about a week of the infrared images and three days of the wind. --winds stores the
// observed wind at every bundled observation's time as a one-degree image
// (scripts/wind-grid.cjs) in dist/data/wind/, which the Unity globe carries the
// clouds with between observations, and rebuilds dist/data/amv.json from the wind at
// the middle of the sequence for the JavaScript version's wind model.
//
// What a run costs, measured 2026-09-22: the images are light (71 global frames 14.0 MB,
// 12 close-up frames 4.5 MB, 2 snapshots 1.2 MB, 85 requests), and the wind is not - one
// /api/shapes answer is 19.9 MB for AMV-LLlow and 3.3 MB for AMV-LLmid, so --winds at 71
// times downloads about 1.6 GB to keep 3.2 MB of one-degree grids. Hours already stored
// are therefore kept rather than asked for again (--refetch-winds forces the download),
// and a full re-fetch of the wind is worth doing rarely.
//
// Without --every the newest listed observations are taken as they come, whatever
// spacing SSEC is publishing. The run prints that spacing, so the cadence actually
// on offer is visible before choosing. Every frame is around 200 KB and the page
// loads all of them before playback starts, so more frames means a longer wait on a
// phone and a larger repository.
//
// --region additionally stores a crop of the same observations over one part of the
// world at the resolution SSEC actually holds, which is what the page shows once it
// is zoomed in past the whole globe. The global frames are 512 px for the entire
// Earth - about 63 km to a pixel at Japan - so zoomed in they are squares. The crop
// is the same product, the same times and the same server; only the bounds and the
// pixel count differ, and it carries its own manifest with each file's URL and
// SHA-256. --region-bounds (south,west,north,east), --region-width and
// --region-frames set it; the defaults are Japan, 1280 px across, and the newest 12
// observations. About 2 km to a pixel, which is as fine as the infrared band gets.
//
// Run it where SSEC is reachable - the agent containers used for this repository
// cannot reach realearth.ssec.wisc.edu - then commit dist/weather/ (and dist/data/
// with --wind). Pushing to main republishes the site with those observations.
//
// Every frame is checked against the RE-Time header SSEC returns with the image: if
// the server hands back a different observation than the one asked for, the run
// stops rather than storing it under the requested time. Nothing is relabelled, and
// the manifest records the exact URL and SHA-256 of what was stored, which is what
// scripts/export-html.py re-checks when it builds the standalone page.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const RegionBox = require('../dist/region-box.js');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const flag = name => ARGS.includes(name);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback;
};

const BASE = process.env.MYATRAS_API_BASE || 'https://realearth.ssec.wisc.edu/api/';
const OUT = path.resolve(ROOT, opt('--out', 'dist/weather'));
const FRAMES = Number(opt('--frames', 13));
// Minutes between kept frames. 0 keeps the listing's own spacing.
const EVERY = Number(opt('--every', 0));
const WIND = flag('--wind');
const WINDS = flag('--winds');
const SPAN = Number(opt('--span', 24));
// With --out the winds go beside the observations, so a trial run touches nothing else.
const WIND_OUT = path.resolve(ROOT, opt('--wind-out',
  ARGS.includes('--out') ? path.join(OUT, 'wind') : path.join('dist', 'data', 'wind')));
const BOUNDS = '-85.05112878,-180,85.05112878,180';
const SEQUENCE_SIZE = 512;   // the frames playback cycles through
const SNAPSHOT_SIZE = 1024;  // the single observation the globe opens with

// The close-up. Japan whole by default, from south of Yonaguni to north of Wakkanai,
// which is the view dist/app.js opens on.
const REGION = flag('--region');
const REGION_NAME = opt('--region-name', 'japan');
const REGION_BOUNDS = opt('--region-bounds', '24,122,46,148');
const REGION_WIDTH = Number(opt('--region-width', 1280));
const REGION_FRAMES = Number(opt('--region-frames', 12));
// The wind is what a run actually costs: one /api/shapes answer is about 20 MB for
// AMV-LLlow and 3 MB for AMV-LLmid, so 71 observation times come to some 1.6 GB - and a
// refresh usually asks again for hours it already holds. Hours already stored are kept
// as they are unless this says otherwise.
const REFETCH_WINDS = flag('--refetch-winds');
const PRODUCTS = ['globalir', 'globalvis'];
const WIND_PRODUCTS = ['AMV-LLlow', 'AMV-LLmid'];

function imageURL(product, time, size, box) {
  const params = new URLSearchParams({
    products: product + '_' + time.replace('.', '_'),
    bounds: box ? `${box.south},${box.west},${box.north},${box.east}` : BOUNDS,
    width: String(box ? box.width : size),
    height: String(box ? box.height : size),
    format: 'png',
  });
  return BASE + 'image?' + params;
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/// The observation times SSEC currently lists for a product, oldest first.
async function times(product) {
  const data = await json(`${BASE}products?products=${encodeURIComponent(product)}&timespan=-${SPAN}h`);
  if (!Array.isArray(data)) throw new Error(`unexpected product listing for ${product}`);
  const entry = data.find(x => x && x.id === product);
  const list = [...new Set((entry?.times || []).filter(t => /^\d{8}[._]\d{6}$/.test(t)))].sort();
  if (!list.length) throw new Error(`SSEC lists no observation times for ${product}`);
  return list;
}

const digits = value => String(value).replace(/\D/g, '');

/// Downloads one observation and returns what the manifest needs to record.
async function download(product, time, size, destination, box) {
  const source = imageURL(product, time, size, box);
  const response = await fetch(source);
  if (!response.ok) throw new Error(`${product} ${time} answered ${response.status}`);

  // SSEC names the observation it actually served. A mismatch means the requested
  // time is gone or was rounded to another one, and storing it under the requested
  // name would be a relabelled observation.
  const served = response.headers.get('re-time');
  if (!served) {
    throw new Error(
      `${product} ${time} came back without an RE-Time header, so the observation it ` +
      `holds cannot be confirmed. Headers: ${[...response.headers.keys()].join(', ')}`);
  }
  if (digits(served) !== digits(time)) {
    throw new Error(`${product}: asked for ${time}, served ${served}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return {
    source,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

/// Deletes the frames a previous run left behind, so the directory holds exactly
/// what the new manifest names.
function prune(directory, keep) {
  if (!fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(directory)) {
    if (name.endsWith('.png') && !keep.has(name)) {
      fs.unlinkSync(path.join(directory, name));
      removed++;
    }
  }
  return removed;
}

/// "20260918.063000" as milliseconds, so spacings can be compared.
function stamp(time) {
  const [date, clock] = time.split(/[._]/);
  return Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8),
    +clock.slice(0, 2), +clock.slice(2, 4), +clock.slice(4, 6));
}

/// The gap SSEC is currently publishing at, in minutes - the most common one, so a
/// single missing observation does not misreport it.
function cadence(listed) {
  const gaps = listed.slice(1).map((t, i) => (stamp(t) - stamp(listed[i])) / 60000);
  if (!gaps.length) return 0;
  const counts = new Map();
  for (const gap of gaps) counts.set(gap, (counts.get(gap) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/// The newest observations, thinned to one every `every` minutes when asked. Walking
/// back from the newest keeps the most recent observation whatever the spacing is.
function choose(listed, count, every) {
  if (!every) return listed.slice(-count);
  const kept = [];
  let last = null;
  for (let i = listed.length - 1; i >= 0 && kept.length < count; i--) {
    const time = listed[i];
    // A tolerance of a minute: published times drift by seconds around the cadence.
    if (last === null || (last - stamp(time)) >= (every - 1) * 60000) {
      kept.push(time);
      last = stamp(time);
    }
  }
  return kept.reverse();
}

async function sequence() {
  const listed = await times('globalir');
  const spacing = cadence(listed);
  console.log(`  SSEC lists ${listed.length} observation times` +
    (spacing ? `, about ${spacing} minutes apart` : ''));

  const wanted = choose(listed, FRAMES, EVERY);
  if (wanted.length < 2) throw new Error('playback needs at least two observation times');
  if (EVERY && wanted.length < FRAMES) {
    console.log(`  only ${wanted.length} of the ${FRAMES} asked for fit in what is listed`);
  }

  const directory = path.join(OUT, 'sequence');
  const entries = [];
  for (const time of wanted) {
    const file = `globalir_${time.replace('.', '_')}.png`;
    const stored = await download('globalir', time, SEQUENCE_SIZE, path.join(directory, file));
    entries.push({ time, file, source: stored.source, sha256: stored.sha256, bytes: stored.bytes });
    process.stdout.write(`  sequence globalir ${time}  ${stored.bytes} bytes\n`);
  }

  const removed = prune(directory, new Set(entries.map(e => e.file)));
  fs.writeFileSync(path.join(directory, 'manifest.json'),
    JSON.stringify({ globalir: entries }, null, 1) + '\n');
  const hours = (stamp(entries.at(-1).time) - stamp(entries[0].time)) / 3600000;
  const megabytes = entries.reduce((sum, e) => sum + e.bytes, 0) / (1024 * 1024);
  return {
    count: entries.length,
    first: entries[0].time,
    last: entries.at(-1).time,
    span: `${hours.toFixed(1)} hours, ${megabytes.toFixed(1)} MB`,
    removed,
    times: entries.map(e => e.time),
  };
}

/// The close-up: the same observations, the same product and the same server, over a
/// box instead of the whole world. Only the newest REGION_FRAMES of the sequence's
/// times are taken, because a crop is several times the bytes of a global frame and
/// the page loads them only when someone zooms in.
async function region(frameTimes) {
  const [south, west, north, east] = REGION_BOUNDS.split(',').map(Number);
  if (![south, west, north, east].every(Number.isFinite)) {
    throw new Error('--region-bounds wants south,west,north,east in degrees');
  }
  const b = RegionBox.box({ south, west, north, east, width: REGION_WIDTH });
  const wanted = frameTimes.slice(-Math.max(1, REGION_FRAMES));
  console.log(`  close-up ${REGION_NAME}: ${b.width}x${b.height} px over ` +
    `${south}..${north}N ${west}..${east}E, ` +
    `${RegionBox.kmPerPixel(b, (south + north) / 2).toFixed(1)} km per pixel at its middle`);

  const directory = path.join(OUT, 'region');
  const entries = [];
  for (const time of wanted) {
    const file = `${REGION_NAME}_globalir_${time.replace('.', '_')}.png`;
    const stored = await download('globalir', time, 0, path.join(directory, file), b);
    entries.push({ time, file, source: stored.source, sha256: stored.sha256, bytes: stored.bytes });
    process.stdout.write(`  region globalir ${time}  ${stored.bytes} bytes\n`);
  }

  const removed = prune(directory, new Set(entries.map(e => e.file)));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    name: REGION_NAME,
    product: 'globalir',
    bounds: { south, west, north, east },
    width: b.width,
    height: b.height,
    kmPerPixel: Number(RegionBox.kmPerPixel(b, (south + north) / 2).toFixed(2)),
    frames: entries,
  }, null, 1) + '\n');
  const megabytes = entries.reduce((sum, e) => sum + e.bytes, 0) / (1024 * 1024);
  return { count: entries.length, megabytes, removed, kmPerPixel: RegionBox.kmPerPixel(b, (south + north) / 2) };
}

/// A crop belongs to the observations it was cut from. A run that replaces those and
/// does not ask for a new crop leaves none behind: the directory is emptied and the
/// manifest says so, which is also what stops the page asking for a file that is not
/// there.
function noRegion() {
  const directory = path.join(OUT, 'region');
  const removed = prune(directory, new Set());
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    frames: [],
    note: 'No close-up is bundled. scripts/fetch-observations.cjs --region cuts one ' +
      'from the same observations; the page offers its switch only when this list is not empty.',
  }, null, 1) + '\n');
  return removed;
}

async function snapshot() {
  const directory = path.join(OUT, 'snapshot');
  const manifest = {};
  const keep = new Set();
  for (const product of PRODUCTS) {
    const time = (await times(product)).at(-1);
    const name = `${product}_${time.replace('.', '_')}.png`;
    const stored = await download(product, time, SNAPSHOT_SIZE, path.join(directory, name));
    manifest[product] = {
      time,
      file: `snapshot/${name}`,
      source: stored.source,
      sha256: stored.sha256,
    };
    keep.add(name);
    process.stdout.write(`  snapshot ${product} ${time}  ${stored.bytes} bytes\n`);
  }
  const removed = prune(directory, keep);
  fs.writeFileSync(path.join(OUT, 'snapshot.json'), JSON.stringify(manifest, null, 1) + '\n');
  return { times: Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, v.time])), removed };
}

/// The observed wind, through the validator that already exists for it: this only
/// downloads the two GeoJSON responses and hands them to scripts/build-amv.cjs,
/// which is what decides which observations are kept.
async function wind() {
  const listed = await Promise.all(WIND_PRODUCTS.map(times));
  const common = listed[0].filter(t => listed.every(l => l.includes(t)));
  if (!common.length) throw new Error('the two pressure bands share no observation time');
  const time = common.at(-1);

  const downloads = [];
  for (const product of WIND_PRODUCTS) {
    const url = `${BASE}shapes?products=${product}_${time.replace('.', '_')}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${product} ${time} answered ${response.status}`);
    const file = path.join(OUT, `.${product}.geojson`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    downloads.push(file);
    process.stdout.write(`  wind ${product} ${time}\n`);
  }

  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'build-amv.cjs'), time, ...downloads],
      { stdio: 'inherit' });
  } finally {
    for (const file of downloads) fs.rmSync(file, { force: true });
  }
  return time;
}

/// A few at a time: the low band's GeoJSON is over 20 MB for every time.
async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], i);
    }
  }));
  return results;
}

async function shapes(product, time) {
  const url = `${BASE}shapes?products=${product}_${time.replace('.', '_')}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${product} ${time} answered ${response.status}`);
  return { url, text: await response.text() };
}

/// The observed wind at each bundled observation's time, as images. cloud-model.js's
/// normalize() is what decides which vectors are kept, and it keeps only those whose
/// own DAY and TIME are the requested time: the wind's equivalent of the RE-Time check,
/// so no wind is ever stored under a time it was not observed at. A time with no wind
/// listed, or none kept, is recorded as missing rather than filled from another hour.
async function winds(frameTimes) {
  const M = require(path.join(ROOT, 'dist', 'cloud-model.js'));
  const W = require('./wind-grid.cjs');
  const listed = await Promise.all(WIND_PRODUCTS.map(times));
  const common = new Set(listed[0].filter(t => listed.every(l => l.includes(t))));
  fs.mkdirSync(WIND_OUT, { recursive: true });

  const middle = frameTimes[Math.floor((frameTimes.length - 1) / 2)];

  // What a previous run already gridded. A wind is an observation at a fixed hour, so a
  // stored grid whose file still matches the SHA-256 in the manifest is the same wind that
  // would come back from asking again - and asking again costs 23 MB for that hour. The
  // middle time is always fetched, because amv.json is rebuilt from its two responses.
  const held = new Map();
  if (!REFETCH_WINDS) {
    try {
      const before = JSON.parse(fs.readFileSync(path.join(WIND_OUT, 'manifest.json'), 'utf8'));
      for (const entry of before.winds || []) {
        const file = path.join(WIND_OUT, entry.file);
        if (!fs.existsSync(file) || entry.time === middle) continue;
        const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (digest === entry.sha256) held.set(entry.time, entry);
      }
    } catch { /* no manifest, or one that cannot be read: fetch everything */ }
  }
  const reused = [];

  const missing = [];
  const made = await pool(frameTimes, 3, async time => {
    if (!common.has(time)) { missing.push(time); return null; }
    if (held.has(time)) { reused.push(time); return held.get(time); }
    const points = [], vectors = {}, sources = {}, texts = {};
    for (const product of WIND_PRODUCTS) {
      const { url, text } = await shapes(product, time);
      // normalize() throws when nothing at all was observed at this time; that is a
      // missing wind, not a failed run.
      let kept = { points: [] };
      try { kept = M.normalize(JSON.parse(text), product, time); } catch { /* none kept */ }
      points.push(...kept.points);
      vectors[product] = kept.points.length;
      sources[product] = url;
      texts[product] = text;
    }
    const grid = W.grid(points);
    if (!grid.nearTexels) { missing.push(time); return null; }
    // The middle one also becomes amv.json, through the script that already builds it.
    if (time === middle) {
      for (const product of WIND_PRODUCTS) {
        fs.writeFileSync(path.join(WIND_OUT, `.${product}.geojson`), texts[product]);
      }
    }
    const file = `wind_${time.replace('.', '_')}.png`;
    const bytes = W.encodePng(grid.width, grid.height, grid.rgb);
    fs.writeFileSync(path.join(WIND_OUT, file), bytes);
    process.stdout.write(`  wind ${time}  ${points.length} vectors, ${(bytes.length / 1024).toFixed(0)} KB\n`);
    return {
      time, file, sources, vectors,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      nearTexels: grid.nearTexels,
      spreadTexels: grid.spreadTexels,
    };
  });

  const entries = made.filter(Boolean);
  if (reused.length) {
    // 23 MB is one AMV-LLlow answer plus one AMV-LLmid answer, measured 2026-09-22.
    process.stdout.write(`  wind  ${reused.length} hour(s) already stored, kept as they were` +
      ` (about ${Math.round(reused.length * 23)} MB not asked for again)\n`);
  }
  prune(WIND_OUT, new Set(entries.map(e => e.file)));
  fs.writeFileSync(path.join(WIND_OUT, 'manifest.json'), JSON.stringify({
    source: 'SSEC RealEarth, UW-Madison: AMV-LLlow and AMV-LLmid',
    method: 'scripts/wind-grid.cjs: 1-degree grid; within ' + W.NEAR + ' degrees the vectors there, ' +
      'further out spread from within ' + W.FAR + ' degrees by a ' + W.SPREAD + '-degree Gaussian',
    winds: entries,
    missing: missing.sort(),
  }, null, 1) + '\n');

  const low = path.join(WIND_OUT, '.AMV-LLlow.geojson'), mid = path.join(WIND_OUT, '.AMV-LLmid.geojson');
  let amvTime = null;
  try {
    if (fs.existsSync(low) && fs.existsSync(mid)) {
      execFileSync('node', [path.join(ROOT, 'scripts', 'build-amv.cjs'), middle, low, mid,
        path.join(WIND_OUT, '..', 'amv.json')], { stdio: 'inherit' });
      amvTime = middle;
    }
  } catch (error) {
    // The images are still good; amv.json simply stays as it was.
    console.log(`  amv.json not rebuilt: ${error.message.split('\n')[0]}`);
  } finally {
    fs.rmSync(low, { force: true });
    fs.rmSync(mid, { force: true });
  }
  return { count: entries.length, missing: missing.sort(), amvTime, reused: reused.length };
}

async function main() {
  console.log(`fetching from ${BASE}`);
  console.log(`writing to   ${path.relative(ROOT, OUT) || OUT}`);

  const frames = await sequence();
  const closeUp = REGION ? await region(frames.times) : (noRegion(), null);
  const snapshots = await snapshot();
  const windTime = WIND ? await wind() : null;
  const windSet = WINDS ? await winds(frames.times) : null;

  console.log('\nstored');
  console.log(`  ${frames.count} frames  ${frames.first} → ${frames.last}  (${frames.span})`);
  if (closeUp) {
    console.log(`  close-up   ${closeUp.count} frames, ${closeUp.megabytes.toFixed(1)} MB, ` +
      `${closeUp.kmPerPixel.toFixed(1)} km per pixel`);
  }
  console.log(`  snapshots  ${Object.entries(snapshots.times).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (windTime) console.log(`  observed wind  ${windTime}`);
  if (windSet) {
    console.log(`  winds  ${windSet.count} of ${frames.count} observation times` +
      (windSet.reused ? `, ${windSet.reused} of them already stored` : '') +
      (windSet.missing.length ? `; none kept for ${windSet.missing.join(', ')}` : ''));
    if (windSet.amvTime) console.log(`  amv.json  ${windSet.amvTime}, the middle of the sequence`);
  }
  const removed = frames.removed + snapshots.removed;
  if (removed) console.log(`  ${removed} file(s) from an earlier run removed`);
  console.log('\nNext: python scripts/export-html.py, node tools/check-webgl.cjs, then commit dist/.');
}

main().catch(error => {
  console.error('\nfetch-observations failed:', error.message);
  console.error('Nothing was relabelled; the files already stored are untouched apart from any');
  console.error('frames written before the failure, which the next successful run replaces.');
  process.exit(1);
});
