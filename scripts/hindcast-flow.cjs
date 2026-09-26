#!/usr/bin/env node
'use strict';
// How well the background flow (dist/background-flow.js) carries on the motion the
// observations showed, scored on the bundled observations themselves.
//
//   node scripts/hindcast-flow.cjs            # prints the table
//   node scripts/hindcast-flow.cjs --write    # also records/background-flow-hindcast.json
//
// From every third hour with six hours of measured cloud motion behind it and enough
// ahead, the flow is started from those six hours and run on; 12, 24 and 48 hours later
// it is compared with the motion measured then (six hours around it, averaged), where
// that measurement is confident and within 60 degrees of the equator. The measured
// motion is an estimate from the images (scripts/build-motion.cjs), not a wind
// observation, and the same for every method, so the comparison is fair even though
// no method can reach zero.
//
// Against: the starting motion held as it was (persistence), its rotational part held
// (what the flow starts as, so dropping the rest is not mistaken for the flow's doing),
// and the typical circulation by latitude (what the clouds rode before).
const fs = require('fs');
const path = require('path');
const png = require('../tools/png.cjs');
const Flow = require('../dist/background-flow.js');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'dist', 'data', 'motion');
const LEADS = [12, 24, 48];
const LDS = [Infinity, 2000, 1000, 500];
const CHOSEN_LD = 1000;
const WINDOW = 6;

function load() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  return manifest.intervals.map(iv => {
    const image = png.decode(fs.readFileSync(path.join(DIR, iv.file)));
    return Flow.motionField(image.data, image.width, image.height, image.channels, manifest.scale);
  });
}

/// The measured motion on the flow's grid and how far it can be trusted there.
function measured(fields) {
  const { NX, NY } = Flow;
  const u = new Float64Array(NX * NY), v = new Float64Array(NX * NY), w = new Float64Array(NX * NY);
  const lats = new Float64Array(NY);
  for (let j = 0; j < NY; j++) {
    const lat = -90 + (j + 0.5) * 180 / NY; lats[j] = lat;
    for (let i = 0; i < NX; i++) {
      const lon = -180 + (i + 0.5) * 360 / NX;
      let su = 0, sv = 0, sw = 0;
      for (const f of fields) {
        const y = Math.min(f.height - 1, Math.max(0, Math.round((90 - lat) / (180 / f.height) - 0.5)));
        const x = ((Math.round((lon + 180) / (360 / f.width) - 0.5) % f.width) + f.width) % f.width;
        const k = y * f.width + x;
        su += f.u[k] * f.w[k]; sv += f.v[k] * f.w[k]; sw += f.w[k];
      }
      const k = j * NX + i;
      u[k] = sw ? su / sw : 0; v[k] = sw ? sv / sw : 0; w[k] = sw / fields.length;
    }
  }
  return { u, v, w, lats };
}

function rms(pu, pv, target) {
  let s = 0, n = 0;
  for (let k = 0; k < pu.length; k++) {
    const lat = target.lats[Math.floor(k / Flow.NX)];
    if (target.w[k] < 0.5 || Math.abs(lat) > 60) continue;
    s += (pu[k] - target.u[k]) ** 2 + (pv[k] - target.v[k]) ** 2; n++;
  }
  return n ? Math.sqrt(s / n) : NaN;
}

function run() {
  const fields = load();
  const { NX, NY } = Flow;
  const climate = { u: new Float64Array(NX * NY), v: new Float64Array(NX * NY) };
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) climate.u[j * NX + i] = Flow.climate(-90 + (j + 0.5) * 180 / NY);
  const starts = [];
  for (let s = WINDOW; s + Math.max(...LEADS) + WINDOW / 2 <= fields.length; s += 3) starts.push(s);
  if (!starts.length) throw new Error(`too few motion intervals (${fields.length}) to score anything`);
  const scores = {};
  const add = (name, lead, value) => { ((scores[name] = scores[name] || {})[lead] = scores[name][lead] || []).push(value); };
  for (const s of starts) {
    const start = Flow.startingWinds(fields.slice(s - WINDOW, s));
    const targets = Object.fromEntries(LEADS.map(L => [L, measured(fields.slice(s + L - WINDOW / 2, s + L + WINDOW / 2))]));
    for (const L of LEADS) {
      add('persistence', L, rms(start.u, start.v, targets[L]));
      add('climatology', L, rms(climate.u, climate.v, targets[L]));
    }
    for (const ld of LDS) {
      const flow = new Flow.BarotropicFlow({ ld });
      flow.setWinds(start.u, start.v);
      for (const L of LEADS) add('rotational part held', L, rms(flow.u, flow.v, targets[L]));
      let t = 0;
      for (const L of LEADS) {
        while (t < L) { flow.step(2); t += 2; }
        add(`flow, Ld ${Number.isFinite(ld) ? ld + ' km' : 'none'}`, L, rms(flow.u, flow.v, targets[L]));
      }
    }
  }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const table = {};
  for (const [name, byLead] of Object.entries(scores)) {
    table[name] = Object.fromEntries(Object.entries(byLead).map(([L, a]) => [L + 'h', +mean(name === 'rotational part held' ? a.slice(0, starts.length) : a).toFixed(1)]));
  }
  return { starts: starts.length, intervals: fields.length, chosenLd: CHOSEN_LD, table };
}

if (require.main === module) {
  const result = run();
  console.log(`${result.starts} starts from ${result.intervals} intervals; RMS vector difference from the measured motion, km/h`);
  for (const [name, row] of Object.entries(result.table)) {
    console.log(`  ${name.padEnd(24)} ${LEADS.map(L => String(row[L + 'h']).padStart(6)).join(' ')}`);
  }
  if (process.argv.includes('--write')) {
    const out = path.join(ROOT, 'records', 'background-flow-hindcast.json');
    fs.writeFileSync(out, JSON.stringify(Object.assign({
      method: 'scripts/hindcast-flow.cjs: started from six hours of measured cloud motion, compared 12/24/48 h later with the motion measured then (confident, within 60 degrees); RMS vector difference in km/h, mean over starts',
    }, result), null, 2) + '\n');
    console.log('wrote', path.relative(ROOT, out));
  }
}

module.exports = { run };
