#!/usr/bin/env node
'use strict';
// Turn two downloaded SSEC AMV GeoJSON responses into dist/data/amv.json.
//
//   node scripts/build-amv.cjs TIME LOW_GEOJSON MID_GEOJSON [OUT_JSON]
//   TIME is the product time both files were requested for, e.g. 20260916.190000
//
// Observations whose own DAY/TIME differ from TIME are discarded, never relabeled
// as current. One observed vector per 2-degree cell per pressure band is kept.
const fs = require('fs');
const path = require('path');
const M = require('../dist/cloud-model.js');

const [, , time, lowPath, midPath, outPath] = process.argv;
if (!time || !lowPath || !midPath) {
  console.error('usage: node scripts/build-amv.cjs TIME LOW_GEOJSON MID_GEOJSON');
  process.exit(2);
}
if (!M.timeISO(time)) {
  console.error('TIME must look like 20260916.190000');
  process.exit(2);
}

const files = { 'AMV-LLlow': lowPath, 'AMV-LLmid': midPath };
const points = [];
const counts = [];
for (const product of M.PRODUCTS) {
  const collection = JSON.parse(fs.readFileSync(files[product], 'utf8'));
  const result = M.normalize(collection, product, time);
  points.push(...result.points);
  counts.push({
    product,
    selected: result.points.length,
    matching: result.matching,
    old: result.old,
    invalid: result.invalid
  });
  console.log(
    product + ': ' + result.points.length + ' representative vectors from ' +
    result.matching + ' matching observations (' + result.old + ' old, ' +
    result.invalid + ' rejected)'
  );
}

const bundle = {
  time,
  source: 'SSEC RealEarth, UW-Madison',
  units: { speed: 'm/s', altitude: 'km', pressure: 'hPa' },
  method: 'AMV point tracers; one observed vector per 2-degree cell per pressure band; only exact observation times',
  points,
  counts
};
M.validateBundle(bundle);
const out = outPath ? path.resolve(outPath) : path.join(__dirname, '..', 'dist', 'data', 'amv.json');
fs.writeFileSync(out, JSON.stringify(bundle));
console.log('wrote ' + path.relative(path.join(__dirname, '..'), out) + ' with ' + points.length + ' tracers at ' + M.timeISO(time));
