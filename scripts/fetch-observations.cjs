#!/usr/bin/env node
'use strict';
// Replace the bundled observations with the newest ones SSEC is serving.
//
//   node scripts/fetch-observations.cjs            # 13 hourly frames + both snapshots
//   node scripts/fetch-observations.cjs --frames 8
//   node scripts/fetch-observations.cjs --wind     # also rebuild dist/data/amv.json
//   node scripts/fetch-observations.cjs --out /tmp/try   # write somewhere else
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
const WIND = flag('--wind');
const BOUNDS = '-85.05112878,-180,85.05112878,180';
const SEQUENCE_SIZE = 512;   // the frames playback cycles through
const SNAPSHOT_SIZE = 1024;  // the single observation the globe opens with
const PRODUCTS = ['globalir', 'globalvis'];
const WIND_PRODUCTS = ['AMV-LLlow', 'AMV-LLmid'];

function imageURL(product, time, size) {
  const params = new URLSearchParams({
    products: product + '_' + time.replace('.', '_'),
    bounds: BOUNDS,
    width: String(size),
    height: String(size),
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
  const data = await json(`${BASE}products?products=${encodeURIComponent(product)}&timespan=-24h`);
  if (!Array.isArray(data)) throw new Error(`unexpected product listing for ${product}`);
  const entry = data.find(x => x && x.id === product);
  const list = [...new Set((entry?.times || []).filter(t => /^\d{8}[._]\d{6}$/.test(t)))].sort();
  if (!list.length) throw new Error(`SSEC lists no observation times for ${product}`);
  return list;
}

const digits = value => String(value).replace(/\D/g, '');

/// Downloads one observation and returns what the manifest needs to record.
async function download(product, time, size, destination) {
  const source = imageURL(product, time, size);
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

async function sequence() {
  const listed = await times('globalir');
  const wanted = listed.slice(-FRAMES);
  if (wanted.length < 2) throw new Error('playback needs at least two observation times');

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
  return { count: entries.length, first: entries[0].time, last: entries.at(-1).time, removed };
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

async function main() {
  console.log(`fetching from ${BASE}`);
  console.log(`writing to   ${path.relative(ROOT, OUT) || OUT}`);

  const frames = await sequence();
  const snapshots = await snapshot();
  const windTime = WIND ? await wind() : null;

  console.log('\nstored');
  console.log(`  ${frames.count} hourly frames  ${frames.first} → ${frames.last}`);
  console.log(`  snapshots  ${Object.entries(snapshots.times).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (windTime) console.log(`  observed wind  ${windTime}`);
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
