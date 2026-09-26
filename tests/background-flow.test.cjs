'use strict';
// The background flow (dist/background-flow.js) against what a rotating sphere must do:
// Rossby waves run westward at the speed theory gives, a zonal flow stays as it is, a
// flow straight over the poles goes where it should, and a disturbed jet neither blows up
// nor dies away. Made-up flows only: the bundled observations are scored separately, by
// scripts/hindcast-flow.cjs, since they change whenever new observations are fetched.
const assert = require('assert');
const { suite } = require('./harness.cjs');
const F = require('../dist/background-flow.js');
const { BarotropicFlow, NX, NY, A, OMEGA } = F;
const s = suite('background-flow');

/// Winds of the stream function P * g(lat) * cos(m lon) for g given with its derivative.
function winds(flow, P, m, g, dg, extra = () => 0) {
  const u = new Float64Array(NX * NY), v = new Float64Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const p = flow.lat[j], l = flow.lon[i], k = j * NX + i;
    u[k] = -P * dg(p) * Math.cos(m * l) / A + extra(p);
    v[k] = -P * g(p) * m * Math.sin(m * l) / (A * Math.cos(p));
  }
  return { u, v };
}
// Y(3,2): cos^2 sin; Y(1,1): cos.
const Y32 = [p => Math.cos(p) ** 2 * Math.sin(p), p => -2 * Math.cos(p) * Math.sin(p) ** 2 + Math.cos(p) ** 3];
const Y11 = [p => Math.cos(p), p => -Math.sin(p)];

/// Where the wave's crest is along one row, and how big it is there.
function crest(flow, m, row) {
  let sn = 0, cs = 0;
  for (let i = 0; i < NX; i++) { sn += flow.v[row * NX + i] * Math.sin(m * flow.lon[i]); cs += flow.v[row * NX + i] * Math.cos(m * flow.lon[i]); }
  return { at: Math.atan2(cs, sn) / m, size: Math.hypot(sn, cs) };
}
const turned = (a, b, m) => { let d = b - a; const w = Math.PI / m; while (d > w) d -= 2 * w; while (d < -w) d += 2 * w; return -d; };

s.test('a wave on its own runs westward at the Rossby speed', () => {
  for (const ld of [Infinity, 2000, 1000]) {
    const flow = new BarotropicFlow({ ld, relaxHours: 0 });
    const { u, v } = winds(flow, A, 2, ...Y32);
    flow.setWinds(u, v);
    const row = Math.round(NY * 0.7), before = crest(flow, 2, row);
    for (let t = 0; t < 12; t += 2) flow.step(2);
    const after = crest(flow, 2, row);
    const expected = -2 * OMEGA / (12 + (Number.isFinite(ld) ? (A / ld) ** 2 : 0)) * 12;
    const moved = turned(before.at, after.at, 2);
    assert.ok(Math.abs(moved - expected) < 0.03 * Math.abs(expected),
      `Ld ${ld}: moved ${(moved * 180 / Math.PI).toFixed(2)} degrees, theory ${(expected * 180 / Math.PI).toFixed(2)}`);
    assert.ok(Math.abs(after.size / before.size - 1) < 0.08, `Ld ${ld}: size changed ${(after.size / before.size).toFixed(3)}x`);
  }
});

s.test('a flow straight over the poles goes round as it should', () => {
  // Y(1,1) with no deformation radius: its pattern turns west at the earth's own rate,
  // so its air crosses the poles every step - where a latitude-longitude grid is weakest.
  // A wave that goes round the earth in a day is far faster than any the page will
  // show, so it is stepped by half hours: this is about the poles, not the step (at two
  // hours it runs 5% fast, and did run 8% slow before the step took the wind half way
  // through it).
  const flow = new BarotropicFlow({ ld: Infinity, relaxHours: 0 });
  const { u, v } = winds(flow, A * 30, 1, ...Y11);
  flow.setWinds(u, v);
  const row = Math.round(NY * 0.5), before = crest(flow, 1, row);
  for (let t = 0; t < 6; t += 0.5) flow.step(0.5);
  const after = crest(flow, 1, row);
  const moved = turned(before.at, after.at, 1), expected = -OMEGA * 6;
  assert.ok(Math.abs(moved - expected) < 0.03 * Math.abs(expected),
    `moved ${(moved * 180 / Math.PI).toFixed(1)} degrees, theory ${(expected * 180 / Math.PI).toFixed(1)}`);
  assert.ok(Math.abs(after.size / before.size - 1) < 0.05);
});

s.test('a flow along the latitudes stays as it is', () => {
  // Any zonal flow is a steady state of the equation: the jets must not drift or decay.
  const flow = new BarotropicFlow({ relaxHours: 0 });
  const u = new Float64Array(NX * NY), v = new Float64Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) u[j * NX + i] = F.climate(flow.lat[j] * 180 / Math.PI);
  flow.setWinds(u, v);
  const start = flow.u.slice();
  for (let t = 0; t < 48; t += 2) flow.step(2);
  let worst = 0;
  for (let k = 0; k < NX * NY; k++) worst = Math.max(worst, Math.abs(flow.u[k] - start[k]), Math.abs(flow.v[k]));
  assert.ok(worst < 0.05, `changed by ${worst.toFixed(3)} km/h in two days`);
});

s.test('the rotational part of a wind comes back from its vorticity', () => {
  const flow = new BarotropicFlow({ relaxHours: 0 });
  const { u, v } = winds(flow, A * 20, 3, ...Y32, p => 60 * Math.cos(p));
  flow.setWinds(u, v);
  let err = 0, size = 0;
  for (let k = 0; k < NX * NY; k++) {
    const lat = flow.lat[Math.floor(k / NX)];
    if (Math.abs(lat) > 1.3) continue;           // the rows next to the poles are one-sided
    err += (flow.u[k] - u[k]) ** 2 + (flow.v[k] - v[k]) ** 2; size += u[k] ** 2 + v[k] ** 2;
  }
  assert.ok(Math.sqrt(err / size) < 0.03, `${(100 * Math.sqrt(err / size)).toFixed(1)}% off`);
});

s.test('a disturbed jet keeps circulating for a month without blowing up or dying away', () => {
  const flow = new BarotropicFlow();
  const u = new Float64Array(NX * NY), v = new Float64Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const lat = flow.lat[j] * 180 / Math.PI, lon = flow.lon[i];
    const bump = Math.exp(-(((Math.abs(lat) - 45) / 12) ** 2));
    u[j * NX + i] = F.climate(lat) + 40 * bump * Math.cos(5 * lon);
    v[j * NX + i] = 50 * bump * Math.sin(6 * lon + lat / 10);
  }
  flow.setWinds(u, v);
  const e0 = flow.energy();
  for (let t = 0; t < 720; t += 2) flow.step(2);
  let fastest = 0;
  for (let k = 0; k < NX * NY; k++) {
    assert.ok(Number.isFinite(flow.u[k]) && Number.isFinite(flow.v[k]));
    fastest = Math.max(fastest, Math.hypot(flow.u[k], flow.v[k]));
  }
  const ratio = flow.energy() / e0;
  assert.ok(ratio > 0.6 && ratio < 1.1, `energy x${ratio.toFixed(2)} after 30 days`);
  assert.ok(fastest < 400, `${fastest.toFixed(0)} km/h somewhere`);
});

s.test('with no measured motion the flow is the typical circulation; with it, the motion', () => {
  const none = F.startingWinds([]);
  const lat = -90 + (NY * 0.75 + 0.5) * 180 / NY, k = Math.floor(NY * 0.75) * NX + 5;
  assert.ok(Math.abs(none.u[k] - F.climate(-90 + (Math.floor(NY * 0.75) + 0.5) * 180 / NY)) < 1e-9);
  assert.strictEqual(none.v[k], 0);
  const W = 180, H = 90, field = { width: W, height: H, u: new Float64Array(W * H).fill(30), v: new Float64Array(W * H).fill(-20), w: new Float64Array(W * H).fill(1) };
  const seen = F.startingWinds([field, field]);
  assert.ok(Math.abs(seen.u[k] - 30) < 1e-9 && Math.abs(seen.v[k] + 20) < 1e-9, `${seen.u[k]}, ${seen.v[k]} at ${lat.toFixed(1)}`);
  // And the motion images decode as scripts/build-motion.cjs wrote them: 128 is still.
  const px = new Uint8Array([128, 0, 255]);
  const decoded = F.motionField(px, 1, 1, 3, 80);
  assert.ok(Math.abs(decoded.u[0] - 0.5 / 255 * 160 * 3.6) < 1e-9 && Math.abs(decoded.v[0] + 80 * 3.6) < 1e-9 && decoded.w[0] === 1);
});

s.test('the winds reach the GPU to within a hundredth of a km/h', () => {
  const flow = new BarotropicFlow();
  for (let k = 0; k < NX * NY; k++) { flow.u[k] = 300 * Math.sin(k); flow.v[k] = -250 * Math.cos(k * 0.7); }
  const t = flow.texture();
  const back = (hi, lo) => (hi / 255 + lo / 255 / 255) * 800 - 400;
  for (let k = 0; k < NX * NY; k++) {
    assert.ok(Math.abs(back(t[k * 4], t[k * 4 + 1]) - flow.u[k]) < 0.02);
    assert.ok(Math.abs(back(t[k * 4 + 2], t[k * 4 + 3]) - flow.v[k]) < 0.02);
  }
});

s.run();
