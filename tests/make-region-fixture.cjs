#!/usr/bin/env node
'use strict';
// Builds a stand-in for the close-up (dist/weather/region/) so the page that shows one
// can be opened and measured here, where SSEC is unreachable.
//
// IT IS NOT AN OBSERVATION AT THAT RESOLUTION. Each frame is the bundled global
// observation for the same time, cut to the box and blown up: the same picture with
// no detail added, which is exactly what a placement test wants. Whether a real crop
// carries more detail is a question only a fetch from SSEC can answer
// (scripts/fetch-observations.cjs --region, on a machine that can reach it).
//
//   node tests/make-region-fixture.cjs                 # into a copy of dist/ in /tmp
//   node tests/make-region-fixture.cjs --shift 6       # deliberately 6 degrees wrong
//   node tests/make-region-fixture.cjs --frames 4      # how many times to build
//
// It never writes inside dist/: it copies dist/ to a temporary directory and puts the
// stand-in there, prints the path, and the browser check is pointed at it with --dir.
// The manifest it writes says fixture: true, and the page ignores that field.
const fs = require('fs');
const path = require('path');
const os = require('os');
const png = require('../tools/png.cjs');
const wind = require('../scripts/wind-grid.cjs');
const RegionBox = require('../dist/region-box.js');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback;
};

const BOUNDS = { south: 24, west: 122, north: 46, east: 148 };
const WIDTH = Number(opt('--width', 640));
const FRAMES = Number(opt('--frames', 4));
// Degrees of longitude to place the crop wrong by, for checking that the check would
// notice. 0 is the honest placement.
const SHIFT = Number(opt('--shift', 0));

function copyDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), destination = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirectory(source, destination);
    else if (entry.isFile()) fs.copyFileSync(source, destination);
  }
}

/// One frame: the global observation read back out over the box, nearest pixel.
function crop(image, box) {
  const out = Buffer.alloc(box.width * box.height * 3);
  for (let y = 0; y < box.height; y++) {
    // The Mercator y of this row, then where that falls in the global frame.
    const v = box.v0 + (box.v1 - box.v0) * ((y + 0.5) / box.height);
    const sy = Math.min(image.height - 1, Math.max(0, Math.floor(v * image.height)));
    for (let x = 0; x < box.width; x++) {
      const u = box.u0 + (box.u1 - box.u0) * ((x + 0.5) / box.width);
      const sx = Math.min(image.width - 1, Math.max(0, Math.floor(u * image.width)));
      const from = (sy * image.width + sx) * image.channels;
      const to = (y * box.width + x) * 3;
      out[to] = image.data[from];
      out[to + 1] = image.data[from + 1];
      out[to + 2] = image.data[from + 2];
    }
  }
  return out;
}

function main() {
  const sequence = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dist/weather/sequence/manifest.json'), 'utf8')).globalir;
  const frames = sequence.slice(-Math.max(1, FRAMES));

  const honest = RegionBox.box({ ...BOUNDS, width: WIDTH });
  // A wrong placement is built by reading the wrong part of the globe while still
  // declaring the honest bounds - which is what a mapping mistake looks like.
  const read = RegionBox.box({ ...BOUNDS, west: BOUNDS.west + SHIFT, east: BOUNDS.east + SHIFT, width: WIDTH });

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'myatras-region-'));
  const dist = path.join(out, 'dist');
  copyDirectory(path.join(ROOT, 'dist'), dist);
  const directory = path.join(dist, 'weather', 'region');
  fs.mkdirSync(directory, { recursive: true });

  const entries = [];
  for (const frame of frames) {
    const image = png.decode(fs.readFileSync(path.join(ROOT, 'dist/weather/sequence', path.basename(frame.file))));
    const bytes = wind.encodePng(honest.width, honest.height, crop(image, read));
    const file = `fixture_globalir_${frame.time.replace('.', '_')}.png`;
    fs.writeFileSync(path.join(directory, file), bytes);
    entries.push({ time: frame.time, file, source: 'tests/make-region-fixture.cjs', bytes: bytes.length });
  }

  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    name: 'japan',
    product: 'globalir',
    fixture: true,
    made: 'tests/make-region-fixture.cjs: the bundled global frames cut to this box and ' +
      'enlarged. Not an observation at this resolution.',
    shiftedDegrees: SHIFT,
    bounds: BOUNDS,
    width: honest.width,
    height: honest.height,
    kmPerPixel: Number(RegionBox.kmPerPixel(honest, (BOUNDS.south + BOUNDS.north) / 2).toFixed(2)),
    frames: entries,
  }, null, 1) + '\n');

  console.log(`stand-in close-up: ${entries.length} frames, ${honest.width}x${honest.height} px` +
    (SHIFT ? `, deliberately ${SHIFT} degrees east of where it says it is` : ''));
  console.log(`  ${dist}`);
  console.log(`\nnode tools/check-webgl.cjs --dir ${dist}`);
}

main();
