'use strict';
// Where the Japan Meteorological Agency's surface charts put the fronts, as a field the
// simulation can read: near a front, how strongly the front's cloud should be kept, and
// where on the last observation that cloud lies.
//
// The simulation carries the last observation's clouds and makes none. A stationary
// front's cloud forms again where the front lies as fast as the wind carries it off; carried
// only, it streams away downwind and the band breaks - on 2026-09-26 it ended east of Kanto
// while the agency had the autumn front along Honshu's south coast out to 166E. So near
// each front on the charts (scripts/fetch-jma-fronts.cjs: the analysis and the 24 and 48
// hour forecasts), the cloud the observation had along the first chart's fronts is shown,
// moved as far as the front has moved: each point near a front on a later chart takes the
// cloud from beside the matching point of the first chart's front (see chartField). Where a
// later front runs on past the end of the first chart's - on 2026-09-26 the analysis ended
// the front near Kanto at 144E and the forecasts carried it to 167E - it takes the cloud
// from as far back inside the band as it is beyond the end (a mirror), rather than all
// from the end itself, which would draw one column of the band out into a streak. A front
// with none near it on the first chart keeps what the observation had where it now lies.
//
// Between charts the field is blended in time. After the last one - the agency's charts
// go no further than 48 hours - its fronts are held HOLD_HOURS and then fade over
// FADE_HOURS: nothing says where they go.
(function (root) {
  const KM = 111.195;
  const NEAR_KM = 150, FAR_KM = 380;   // a front's cloud kept whole to NEAR_KM, none past FAR_KM
  const MATCH_KM = 900;                // further than this from the first chart's fronts, a new front
  const SHIFT_DEG = 12;                // the largest move north or south held, in degrees
  const SHIFT_EAST_DEG = 48;           // east or west: a mirror past a front's end reaches further
  const HOLD_HOURS = 24, FADE_HOURS = 48;
  const STEP_DEG = 0.5;                // fronts are thinned to points about this far apart
  const toRad = d => d * Math.PI / 180;
  const wrap = d => ((d + 540) % 360) - 180;
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  /// A front's line with points closer than STEP_DEG dropped, keeping its ends.
  function thin(points) {
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [out[out.length - 1], points[i]];
      if (Math.hypot(b[0] - a[0], wrap(b[1] - a[1]) * Math.cos(toRad(b[0]))) >= STEP_DEG || i === points.length - 1) out.push(b);
    }
    return out;
  }

  const segKm = (a, b) => Math.hypot(b[0] - a[0], wrap(b[1] - a[1]) * Math.cos(toRad((a[0] + b[0]) / 2))) * KM;
  /// The distance along a line to each of its points, in km.
  function lengths(line) {
    const out = [0];
    for (let i = 1; i < line.length; i++) out.push(out[i - 1] + segKm(line[i - 1], line[i]));
    return out;
  }

  /// The nearest point to (lat, lon) on any of the lines: where, how far in km, which line,
  /// and how far along it.
  function nearest(lines, lat, lon, along = lines.map(lengths)) {
    let best = null, bestD = Infinity, which = -1, at = 0;
    const c = Math.cos(toRad(lat));
    lines.forEach((line, n) => {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        // In km on the plane touching this point: good to a few per cent at these distances.
        const ax = wrap(a[1] - lon) * c * KM, ay = (a[0] - lat) * KM;
        const bx = wrap(b[1] - lon) * c * KM, by = (b[0] - lat) * KM;
        const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
        const t = len > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
        const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
        if (d < bestD) {
          bestD = d; best = [lat + py / KM, wrap(lon + px / (c * KM))]; which = n;
          at = along[n][i - 1] + t * (along[n][i] - along[n][i - 1]);
        }
      }
    });
    return { point: best, km: bestD, line: which, at };
  }

  /// The point `km` along a line, turned back at either end as in a mirror, so that any
  /// distance falls somewhere on it.
  function pointAlong(line, along, km) {
    const total = along[along.length - 1];
    if (!(total > 0)) return line[0];
    let u = ((km % (2 * total)) + 2 * total) % (2 * total);
    if (u > total) u = 2 * total - u;
    let i = 1;
    while (i < along.length - 1 && along[i] < u) i++;
    const a = line[i - 1], b = line[i], f = along[i] > along[i - 1] ? (u - along[i - 1]) / (along[i] - along[i - 1]) : 0;
    return [a[0] + (b[0] - a[0]) * f, wrap(a[1] + wrap(b[1] - a[1]) * f)];
  }

  class FrontField {
    /// data: dist/data/jma-fronts.json. startMs: the last observation, the simulation's hour 0.
    constructor(data, startMs, { width = 256, height = 128 } = {}) {
      this.width = width; this.height = height;
      this.charts = ((data && data.charts) || [])
        .map(c => ({ t: (Date.parse(c.valid) - startMs) / 3600000, title: c.title, kind: c.kind, hours: c.hours, valid: c.valid,
          lines: (c.fronts || []).map(f => thin(f.points)).filter(l => l.length >= 2) }))
        .filter(c => Number.isFinite(c.t) && c.lines.length)
        .sort((a, b) => a.t - b.t);
      this.issued = data && data.charts ? data.charts.map(c => c.issued) : [];
      if (!this.charts.length) return;
      const first = this.charts[0].lines;
      for (const chart of this.charts) chart.field = this.chartField(chart.lines, first);
    }

    get empty() { return !this.charts.length; }
    get lastHours() { return this.empty ? -Infinity : this.charts[this.charts.length - 1].t; }

    /// For each cell: the weight, and the move (degrees north and east) to where its cloud
    /// was on the first chart.
    ///
    /// Each front here is matched to the first chart's front it runs closest to for most of
    /// its length, and measured along both from the point where the two come closest: a
    /// point so far along this front takes its cloud from the point as far along that one,
    /// mirrored back at its ends. Continuous along the whole front, so neighbouring cells
    /// take neighbouring cloud. Choosing, cell by cell, the nearest point of whichever first
    /// front was nearest made the source jump where two of them were equally near, and cut
    /// hard vertical edges into the band.
    chartField(lines, first) {
      const { width: W, height: H } = this, weight = new Float32Array(W * H), dlat = new Float32Array(W * H), dlon = new Float32Array(W * H);
      const along = lines.map(lengths), firstAlong = first.map(lengths);
      const source = lines.map(line => {
        const hits = line.map(p => nearest(first, p[0], p[1], firstAlong));
        const votes = new Map();
        for (const h of hits) if (h.km < MATCH_KM) votes.set(h.line, (votes.get(h.line) || 0) + 1);
        if (!votes.size) return null;
        const to = [...votes].sort((a, b) => b[1] - a[1])[0][0];
        let k = -1;
        hits.forEach((h, n) => { if (h.line === to && (k < 0 || h.km < hits[k].km)) k = n; });
        return { to, offset: hits[k].at - along[lines.indexOf(line)][k] };
      });
      let south = 90, north = -90;
      for (const l of lines) for (const p of l) { south = Math.min(south, p[0]); north = Math.max(north, p[0]); }
      const reach = FAR_KM / KM + 1;
      for (let y = 0; y < H; y++) {
        const lat = (y + 0.5) / H * 180 - 90;
        if (lat < south - reach || lat > north + reach || Math.abs(lat) > 80) continue;
        for (let x = 0; x < W; x++) {
          const lon = (x + 0.5) / W * 360 - 180;
          const near = nearest(lines, lat, lon, along);
          if (near.km >= FAR_KM) continue;
          const i = y * W + x;
          weight[i] = 1 - smooth(NEAR_KM, FAR_KM, near.km);
          const src = source[near.line];
          if (!src) continue;   // a front with none near it on the first chart: what is under it
          const from = pointAlong(first[src.to], firstAlong[src.to], near.at + src.offset);
          dlat[i] = Math.max(-SHIFT_DEG, Math.min(SHIFT_DEG, near.point[0] - from[0]));
          dlon[i] = Math.max(-SHIFT_EAST_DEG, Math.min(SHIFT_EAST_DEG, wrap(near.point[1] - from[1])));
        }
      }
      return { weight, dlat, dlon };
    }

    /// How much the fronts count at an hour, past the last chart.
    fadeAt(hours) {
      const past = hours - this.lastHours;
      return past <= HOLD_HOURS ? 1 : Math.max(0, 1 - (past - HOLD_HOURS) / FADE_HOURS);
    }

    /// The field at an hour of the simulation, as bytes for a texture: weight in r, the move
    /// north in g over +-SHIFT_DEG with 128 for none, and the move east over
    /// +-SHIFT_EAST_DEG in b and a, 16 bits (b the high byte), with 32768 for none.
    pixels(hours, into) {
      const { width: W, height: H } = this, out = into || new Uint8Array(W * H * 4);
      out.fill(0);
      for (let i = 0; i < W * H; i++) { out[i * 4 + 1] = 128; out[i * 4 + 2] = 128; out[i * 4 + 3] = 0; }
      if (this.empty) return out;
      const c = this.charts;
      let a = c[0], b = c[0], f = 0;
      if (hours >= c[c.length - 1].t) a = b = c[c.length - 1];
      else for (let k = 1; k < c.length; k++) if (hours < c[k].t) { a = c[k - 1]; b = c[k]; f = Math.max(0, (hours - a.t) / (b.t - a.t)); break; }
      const fade = this.fadeAt(hours);
      const byte = v => Math.max(0, Math.min(255, Math.round(128 + v / SHIFT_DEG * 127)));
      const word = v => Math.max(0, Math.min(65535, Math.round(32768 + v / SHIFT_EAST_DEG * 32767)));
      for (let i = 0; i < W * H; i++) {
        const w = (a.field.weight[i] * (1 - f) + b.field.weight[i] * f) * fade;
        if (w <= 0) continue;
        // The move of whichever chart has the front here, blended where both have.
        const wa = a.field.weight[i] * (1 - f), wb = b.field.weight[i] * f, s = wa + wb || 1;
        out[i * 4] = Math.round(Math.min(1, w) * 255);
        out[i * 4 + 1] = byte((a.field.dlat[i] * wa + b.field.dlat[i] * wb) / s);
        const east = word((a.field.dlon[i] * wa + b.field.dlon[i] * wb) / s);
        out[i * 4 + 2] = east >> 8; out[i * 4 + 3] = east & 255;
      }
      return out;
    }
  }

  FrontField.SHIFT_DEG = SHIFT_DEG;
  FrontField.SHIFT_EAST_DEG = SHIFT_EAST_DEG;
  FrontField.HOLD_HOURS = HOLD_HOURS;
  FrontField.FADE_HOURS = FADE_HOURS;
  FrontField.nearest = nearest;
  FrontField.pointAlong = pointAlong;
  root.FrontField = FrontField;
  if (typeof module !== 'undefined') module.exports = { FrontField };
})(typeof window === 'undefined' ? globalThis : window);
