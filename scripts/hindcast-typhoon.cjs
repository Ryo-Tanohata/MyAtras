#!/usr/bin/env node
'use strict';
// Tries dist/typhoon.js on storms it has never seen, and says how far wrong it was.
//
//   node scripts/hindcast-typhoon.cjs --tracks ibtracs.since1980.list.v04r01.csv
//   node scripts/hindcast-typhoon.cjs --tracks FILE --report somewhere/else.json
//
// The model is built from the storms of 1980-2014 only, then started on every storm of
// 2015 onward at every twelfth hour it was at typhoon strength (64 kt or more) - the
// point at which a storm is plain to anyone living under it - with its true position,
// strength and last twelve hours of motion, and let run until it dies. Its position is
// compared with where the storm really was 12 to 120 hours later, and its end with the
// storm's real end.
//
// Two baselines run on the same cases:
// - persistence: carry on in a straight line at the last twelve hours' motion
// - climatology: the same model but ignoring which way the storm was heading, which is
//   what the page's current outlook does (dist/storms.js, tendency.json)
// The model has to beat both to be worth drawing.
//
// The one number chosen here, the persistence time, is chosen on the older storms
// (2005-2014), never on the ones it is then scored on: at least six hours, so the hand-over
// from the last observation does not kink; then the smallest error over 24 to 120 hours
// among those that turn at least 70% as many storms as really turned, or failing that the
// one that turns most. Written to
// records/typhoon-hindcast.json; scripts/build-typhoon.cjs reads the choice from there.
const fs = require('fs');
const path = require('path');
const B = require('./build-typhoon.cjs');
const { TyphoonModel, KM_PER_DEGREE } = require('../dist/typhoon.js');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(name);
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : fallback;
};

const TRAIN = [1980, 2014];
const TUNE = [2005, 2014];      // older storms, to choose the persistence time on
const TEST_FROM = 2015;
const LEADS = [12, 24, 48, 72, 96, 120];
const TAUS = [0, 3, 6, 12, 24, 48, 72, 96];
const RECURVE_FLOOR = 0.7;      // of the real storms' turns, how many the model must make
// The shortest persistence allowed, whatever the scores say. The object takes over from
// the last observation, and with none it swings at once from the storm's real motion to
// the local average - a kink at the one moment everyone is watching. Six hours bends it
// round over about six hours instead. On 2005-2014 it costs 68% -> 61% of real turns.
const MIN_TAU = 6;
const START_KT = 64;

const toRad = d => d * Math.PI / 180;
const wrap = lon => ((lon + 540) % 360) - 180;
const km = (a, b) => {
  const dy = (a.lat - b.lat) * KM_PER_DEGREE;
  const dx = wrap(a.lon - b.lon) * KM_PER_DEGREE * Math.cos(toRad((a.lat + b.lat) / 2));
  return Math.hypot(dx, dy);
};
const median = v => { if (!v.length) return NaN; const s = v.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
const mean = v => v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;

/// When a storm stops being a tropical storm: it goes extratropical or dissipates, or its
/// wind drops below 34 kt. The last point if neither happens before the record stops.
function trueEnd(points, from) {
  for (let i = from + 1; i < points.length; i++) {
    const p = points[i];
    if (p.nature === 'ET' || p.nature === 'DS' || (isFinite(p.kt) && p.kt < B.CLASSES[0])) return p.t;
  }
  return points[points.length - 1].t;
}

/// Every twelfth hour a storm spent at typhoon strength with twelve hours of track behind it.
function starts(storms, fromSeason, toSeason) {
  const out = [];
  for (const s of storms) {
    if (s.season < fromSeason || s.season > toSeason) continue;
    let last = -Infinity;
    for (let i = 1; i < s.points.length; i++) {
      const p = s.points[i];
      if (p.nature !== 'TS' || !(p.kt >= START_KT)) continue;
      // Twelve hours back by time, not by count: IBTrACS gives a point every three
      // hours (the six-hourly analyses with interpolated ones between), so counting two
      // back lands six hours earlier and every case was thrown out.
      const target = p.t - 12 * 3600000;
      let before = null;
      for (let j = i - 1; j >= 0; j--) {
        if (s.points[j].t > target + 3600000) continue;
        if (Math.abs(s.points[j].t - target) <= 3600000) before = s.points[j];
        break;
      }
      if (!before) continue;
      if (p.t - last < 12 * 3600000) continue;
      last = p.t;
      const vel = B.velocity(before, p);
      out.push({ sid: s.sid, basin: s.basin, points: s.points, i,
        init: { lat: p.lat, lon: p.lon, kt: p.kt, u: vel.u, v: vel.v }, end: trueEnd(s.points, i) });
    }
  }
  return out;
}

function truthAt(start, lead) {
  const t = start.points[start.i].t + lead * 3600000;
  for (const p of start.points) if (Math.abs(p.t - t) <= 3600000) return p;
  return null;
}

/// Runs one method on every case and returns its positions at each lead (null once gone).
function positions(cases, runner) {
  return cases.map(c => {
    const run = runner(c);
    const at = {};
    for (const lead of LEADS) at[lead] = run.points && run.points[lead] ? run.points[lead] : null;
    return { at, end: run.end, points: run.points };
  });
}

function persistence(c) {
  const points = [];
  let { lat, lon } = c.init;
  for (let t = 0; t <= 120; t++) {
    points.push({ t, lat, lon, kt: c.init.kt });
    lat += c.init.v / KM_PER_DEGREE;
    lon = wrap(lon + c.init.u / (KM_PER_DEGREE * Math.max(0.2, Math.cos(toRad(lat)))));
  }
  return { points, end: { t: 120, reason: 'straight line' } };
}

function trackErrors(cases, runs) {
  const rows = [];
  for (const lead of LEADS) {
    const byMethod = Object.fromEntries(Object.keys(runs).map(k => [k, []]));
    let aliveTruth = 0, aliveModel = 0, total = 0;
    cases.forEach((c, i) => {
      const truth = truthAt(c, lead);
      if (!truth) return;
      total++;
      if (truth.t <= c.end) aliveTruth++;
      if (runs.model[i].at[lead]) aliveModel++;
      // One sample for all methods: every method must still have the storm, or none count.
      if (Object.values(runs).some(r => !r[i].at[lead])) return;
      for (const [k, r] of Object.entries(runs)) byMethod[k].push(km(r[i].at[lead], truth));
    });
    const row = { lead, n: byMethod.model.length, cases: total,
      aliveTruth: total ? +(aliveTruth / total).toFixed(3) : null,
      aliveModel: total ? +(aliveModel / total).toFixed(3) : null };
    for (const [k, v] of Object.entries(byMethod)) row[k] = { median: Math.round(median(v)), mean: Math.round(mean(v)) };
    rows.push(row);
  }
  return rows;
}

/// Whether a track recurved: somewhere before it ended, twelve hours in which it moved
/// east faster than 5 km/h. Judged the same way for the model and the real storm, so a
/// single three-hour wobble in a real track does not count. Points carry t in hours.
function recurves(pts) {
  for (let k = 0; k < pts.length; k++) {
    const later = pts.find(q => q.t >= pts[k].t + 12);
    if (!later) break;
    const hours = later.t - pts[k].t;
    const east = wrap(later.lon - pts[k].lon) * KM_PER_DEGREE
      * Math.cos(toRad((later.lat + pts[k].lat) / 2)) / hours;
    if (east > 5) return true;
  }
  return false;
}
const inHours = (points, from) => points.map(q => ({ ...q, t: (q.t - from) / 3600000 }));
/// The real storm from a start until it ended, in hours from the start.
const realTrack = c => inHours(c.points.slice(c.i).filter(q => q.t <= c.end), c.points[c.i].t);

function main() {
  const tracks = opt('--tracks', null);
  if (!tracks) { console.error('need --tracks <ibtracs csv>'); process.exit(2); }
  const storms = B.parseTracks(fs.readFileSync(path.resolve(tracks), 'utf8'));
  const land = B.landMask();
  const latest = Math.max(...storms.map(s => s.season));

  const trained = new TyphoonModel(B.buildModel(storms, { fromSeason: TRAIN[0], toSeason: TRAIN[1], land }));

  // The persistence time, chosen on older storms. Two things are asked of it.
  // Position: the median error averaged over 24 to 120 hours - scored at 48 hours alone,
  // a long persistence wins, carrying on as it was being good for two days.
  // Turning: of the storms still heading west when started, the model must turn at least
  // RECURVE_FLOOR as many as really did. Scored on position alone the fifth backtest chose
  // 48 h and turned 384 storms against 1,227 real turns: each track looked natural, but
  // the storms that should swing north-east past Japan mostly ran on into China. Among the
  // persistence times that turn enough, the one with the smallest error is chosen; if none
  // do, the one that turns most.
  const tune = starts(storms, TUNE[0], TUNE[1]);
  const tauScores = {};
  const TUNE_LEADS = [24, 48, 72, 96, 120];
  const westward = tune.filter(c => c.init.u < 0);
  const realTurns = westward.filter(c => recurves(realTrack(c))).length;
  for (const tau of TAUS) {
    const byLead = TUNE_LEADS.map(() => []);
    for (const c of tune) {
      const run = trained.run(c.init, { tau, hours: 120 });
      TUNE_LEADS.forEach((lead, k) => {
        const truth = truthAt(c, lead);
        if (truth && run.points[lead]) byLead[k].push(km(run.points[lead], truth));
      });
    }
    const turns = westward.filter(c => recurves(trained.run(c.init, { tau }).points)).length;
    tauScores[tau] = { km: Math.round(mean(byLead.map(median))),
      turnRatio: realTurns ? +(turns / realTurns).toFixed(3) : 0 };
  }
  const ranked = Object.entries(tauScores).map(([tau, sc]) => ({ tau: +tau, ...sc }))
    .filter(r => r.tau >= MIN_TAU);
  const turning = ranked.filter(r => r.turnRatio >= RECURVE_FLOOR).sort((a, b) => a.km - b.km);
  const chosenTau = turning.length ? turning[0].tau
    : ranked.sort((a, b) => b.turnRatio - a.turnRatio || a.km - b.km)[0].tau;

  const cases = starts(storms, TEST_FROM, latest);
  // A backtest with nothing in it must fail loudly rather than write an empty score -
  // the first run on the real archive did exactly that, and committed it.
  if (!tune.length || !cases.length) {
    console.error(`no cases to score: ${tune.length} to tune on, ${cases.length} to test on`);
    process.exit(1);
  }
  const runs = {
    model: positions(cases, c => trained.run(c.init, { tau: chosenTau })),
    climatology: positions(cases, c => trained.run(c.init, { tau: 0, regime: 'all' })),
    persistence: positions(cases, persistence),
  };

  // How long it lasts, for the cases whose real end is inside the fifteen days the model runs.
  const lifetimes = [], constant = [];
  const trainStarts = starts(storms, TRAIN[0], TRAIN[1]);
  const typical = median(trainStarts.map(c => (c.end - c.points[c.i].t) / 3600000));
  cases.forEach((c, i) => {
    const remaining = (c.end - c.points[c.i].t) / 3600000;
    if (remaining > 360) return;
    lifetimes.push(runs.model[i].end.t - remaining);
    constant.push(Math.abs(typical - remaining));
  });

  // Strength along the way, against keeping it as it was.
  const intensity = [24, 48, 72].map(lead => {
    const model = [], still = [];
    cases.forEach((c, i) => {
      const truth = truthAt(c, lead);
      const m = runs.model[i].at[lead];
      if (!truth || !m || !isFinite(truth.kt) || truth.t > c.end) return;
      model.push(Math.abs(m.kt - truth.kt));
      still.push(Math.abs(c.init.kt - truth.kt));
    });
    return { lead, n: model.length, modelMAE: +mean(model).toFixed(1), persistenceMAE: +mean(still).toFixed(1) };
  });

  // Things that would be plainly wrong on screen.
  let crossed = 0, modelRecurved = 0, trueRecurved = 0, counted = 0;
  const reasons = {};
  cases.forEach((c, i) => {
    const pts = runs.model[i].points;
    reasons[runs.model[i].end.reason] = (reasons[runs.model[i].end.reason] || 0) + 1;
    if (pts.some(p => Math.sign(p.lat) !== Math.sign(c.init.lat))) crossed++;
    if (c.init.u >= 0) return;                 // only storms still heading west can recurve
    counted++;
    if (recurves(realTrack(c))) trueRecurved++;
    if (recurves(pts)) modelRecurved++;
  });

  const report = {
    method: 'scripts/hindcast-typhoon.cjs: model built from ' + TRAIN.join('-') + ', started on every '
      + `storm of ${TEST_FROM}-${latest} at every twelfth hour at ${START_KT} kt or more, compared with the `
      + 'best track. Errors in km are great-circle distance at each lead, on the cases every method still had.',
    trainedOn: TRAIN, testedOn: [TEST_FROM, latest], starts: cases.length,
    tauScores: tauScores, recurveFloor: RECURVE_FLOOR, minTau: MIN_TAU, chosenTau,
    track: trackErrors(cases, runs),
    lifetime: { n: lifetimes.length, medianAbsErrorH: Math.round(median(lifetimes.map(Math.abs))),
      medianBiasH: Math.round(median(lifetimes)), constantBaselineAbsErrorH: Math.round(median(constant)),
      typicalRemainingH: Math.round(typical) },
    intensity,
    plausibility: { crossedEquator: crossed, recurvedModel: modelRecurved, recurvedTruth: trueRecurved,
      westwardStarts: counted, endReasons: reasons },
  };
  const reportPath = path.resolve(opt('--report', path.join(ROOT, 'records', 'typhoon-hindcast.json')));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + '\n');

  console.log(`trained ${TRAIN.join('-')}, tested ${TEST_FROM}-${latest}: ${cases.length} starts at >= ${START_KT} kt`);
  console.log(`persistence time chosen on ${TUNE.join('-')}: ${chosenTau} h`);
  for (const [tau, sc] of Object.entries(tauScores)) {
    console.log(`  tau ${String(tau).padStart(2)} h: ${sc.km} km over 24-120 h, turns ${(sc.turnRatio * 100).toFixed(0)}% as often as real storms`);
  }
  console.log('\nlead   n     model  climatology  persistence   alive model/truth');
  for (const r of report.track) {
    console.log(`${String(r.lead).padStart(4)}h ${String(r.n).padStart(5)}  ${String(r.model.median).padStart(6)}`
      + `  ${String(r.climatology.median).padStart(11)}  ${String(r.persistence.median).padStart(11)}`
      + `   ${r.aliveModel} / ${r.aliveTruth}`);
  }
  const L = report.lifetime;
  console.log(`\nlifetime: median |error| ${L.medianAbsErrorH} h (bias ${L.medianBiasH} h) over ${L.n}; `
    + `a constant ${L.typicalRemainingH} h would be ${L.constantBaselineAbsErrorH} h off`);
  for (const r of intensity) console.log(`strength ${r.lead}h: model ${r.modelMAE} kt, unchanged ${r.persistenceMAE} kt (n ${r.n})`);
  const P = report.plausibility;
  console.log(`equator crossings ${P.crossedEquator}; recurved ${P.recurvedModel} in the model, `
    + `${P.recurvedTruth} in reality, of ${P.westwardStarts} starts heading west`);
  console.log(`how the model's storms ended: ${JSON.stringify(P.endReasons)}`);
}

if (require.main === module) main();
module.exports = { trueEnd, starts, persistence };
