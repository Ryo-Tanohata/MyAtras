'use strict';
// A typhoon as an abstract object: where it is, how strong, and which way it was going,
// carried forward from the last hour it was observed until it dies.
//
// This is the first of three steps. Here the object moves the way past storms moved
// through the same place - all of them, until its own motion turns east, and from then on
// the ones that had already turned (recurved), which run north-east and faster. So the
// turn from west-north-west through north to north-east is not drawn. It happens where
// past storms turned.
//
// Not "the storms still heading west" before the turn: that set can never turn, because
// a storm that turns leaves it the moment it does, so its median runs west at every
// latitude (-5 km/h at 35N in the real record) and an object following it never turns
// either. The first real backtest caught that - 117 turns against 1,330 real ones. The
// median of a fork cannot show the fork; the median of all storms turns where most do.
//
// The
// beta effect - the drift a vortex makes on a rotating sphere, north-west in the northern
// hemisphere and south-west in the southern - is inside that record, because the real
// storms made it. Step three replaces the record with a live flow and adds the drift
// explicitly; betaDrift() is here for that.
//
// Strength changes over the sea the way past storms of the same strength changed in the
// same place, which carries warm and cold water with it without needing a sea temperature.
// Over land it decays by Kaplan and DeMaria's inland model. It ends when it falls below
// 34 knots, or when it has gone as far along its path as half the storms there got before
// turning extratropical or falling apart, or if it is carried to the equator.
//
// Not a forecast and not this storm: what past storms in this place did.
(function (root) {
  const KM_PER_DEGREE = 111.195;
  const END_KT = 34;            // below this it is no longer a tropical storm
  const MAX_HOURS = 360;        // fifteen days; nothing in the record outlives that by much
  const HYSTERESIS = 2;         // km/h of eastward motion before a storm counts as recurved
  const CLASSES = [34, 64, 96]; // knots: tropical storm, typhoon, strong typhoon
  const JOIN_HOURS = 12;        // how long a storm seen off a forecast takes to join it
  const DECAY_HOURS = 36;       // how long a typhoon takes to die after its forecast, typically
  const DECAY_KMH = 35;         // the pace a recurving storm speeds up to, typically

  const toRad = d => d * Math.PI / 180;
  const wrapLon = lon => ((lon + 540) % 360) - 180;

  /// Base64 to a bit array, in Node and in the browser alike.
  function decodeBits(base64, count) {
    let bytes;
    if (typeof Buffer !== 'undefined') bytes = Buffer.from(base64, 'base64');
    else {
      const text = atob(base64);
      bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    }
    const bits = new Uint8Array(count);
    for (let i = 0; i < count; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
    return bits;
  }

  /// The drift a vortex makes on a rotating sphere with no flow around it: toward the
  /// pole and west, about 2 m/s. Its size and exact direction depend on the storm, which
  /// is why step one takes it from the record instead; step three adds it to a live flow.
  function betaDrift(lat, kmh = 7.2) {
    const pole = lat >= 0 ? 1 : -1;
    return { u: -kmh * Math.SQRT1_2, v: pole * kmh * Math.SQRT1_2 };
  }

  class TyphoonModel {
    constructor(data) {
      this.data = data;
      this.params = Object.assign({ tau: 12, alpha: 0.095, R: 0.9, Vb: 26.7, endKt: END_KT },
        data.params || {});
      const motion = data.motion || {};
      this.motionCell = motion.cell || 2.5;
      this.motionCols = Math.round(360 / this.motionCell);
      this.motion = {};
      for (const regime of ['east', 'all']) {
        const flat = motion[regime] || [];
        const map = new Map();
        for (let i = 0; i + 5 <= flat.length; i += 5) {
          map.set(flat[i] * this.motionCols + flat[i + 1], { u: flat[i + 2], v: flat[i + 3], n: flat[i + 4] });
        }
        this.motion[regime] = map;
      }
      const intensity = data.intensity || {};
      this.intensityCell = intensity.cell || 2.5;
      this.intensityCols = Math.round(360 / this.intensityCell);
      this.intensity = new Map();
      const flat = intensity.cells || [];
      for (let i = 0; i + 5 <= flat.length; i += 5) {
        this.intensity.set((flat[i] * this.intensityCols + flat[i + 1]) * CLASSES.length + flat[i + 2],
          flat[i + 3]);
      }
      this.defaultChange = typeof intensity.fallback === 'number' ? intensity.fallback : -4;
      // How often a tropical storm here stopped being one, by any road, per hour at sea.
      // The median change in strength cannot carry this: an end is a rare event in any one
      // six hours, so a median never sees it, and the storms still counted as tropical at
      // 35 degrees are exactly the ones that did not end.
      const hazard = data.hazard || {};
      this.hazardCell = hazard.cell || 2.5;
      this.hazardCols = Math.round(360 / this.hazardCell);
      this.hazard = new Map();
      const hz = hazard.cells || [];
      for (let i = 0; i + 4 <= hz.length; i += 4) this.hazard.set(hz[i] * this.hazardCols + hz[i + 1], hz[i + 2]);
      const land = data.land;
      if (land && land.bits) {
        this.landCell = land.cell;
        this.landWidth = land.width;
        this.landHeight = land.height;
        this.landBits = decodeBits(land.bits, land.width * land.height);
      }
    }

    /// Past storms' motion here, in km/h east (u) and north (v), for storms heading the
    /// given way. Interpolated between cell centres so a track bends rather than kinks;
    /// a corner with no record is left out. Null where there is no record at all.
    motionAt(lat, lon, regime) {
      return this.bilinear(this.motion[regime], this.motionCell, this.motionCols, lat, lon);
    }

    bilinear(map, cell, cols, lat, lon) {
      if (!map || !map.size) return null;
      const y = (lat + 90) / cell - 0.5, x = (wrapLon(lon) + 180) / cell - 0.5;
      const r0 = Math.floor(y), c0 = Math.floor(x), fy = y - r0, fx = x - c0;
      let u = 0, v = 0, weight = 0;
      for (const [dr, dc, w] of [[0, 0, (1 - fy) * (1 - fx)], [0, 1, (1 - fy) * fx],
        [1, 0, fy * (1 - fx)], [1, 1, fy * fx]]) {
        const col = ((c0 + dc) % cols + cols) % cols;
        const found = map.get((r0 + dr) * cols + col);
        if (!found || w <= 0) continue;
        u += found.u * w; v += found.v * w; weight += w;
      }
      return weight > 0.05 ? { u: u / weight, v: v / weight } : null;
    }

    /// How past storms of this strength changed here over the sea, in knots per six hours.
    intensityChangeAt(lat, lon, kt) {
      const cls = kt >= CLASSES[2] ? 2 : kt >= CLASSES[1] ? 1 : 0;
      const row = Math.floor((lat + 90) / this.intensityCell);
      const col = Math.floor((wrapLon(lon) + 180) / this.intensityCell) % this.intensityCols;
      const found = this.intensity.get((row * this.intensityCols + col) * CLASSES.length + cls);
      return typeof found === 'number' ? found : null;
    }

    /// The chance per hour, at sea here, that a tropical storm stops being one.
    hazardAt(lat, lon) {
      const row = Math.floor((lat + 90) / this.hazardCell);
      const col = Math.floor((wrapLon(lon) + 180) / this.hazardCell) % this.hazardCols;
      const found = this.hazard.get(row * this.hazardCols + col);
      return typeof found === 'number' ? found : 0;
    }

    isLand(lat, lon) {
      if (!this.landBits) return false;
      const row = Math.min(this.landHeight - 1, Math.max(0, Math.floor((90 - lat) / this.landCell)));
      const col = Math.min(this.landWidth - 1, Math.max(0, Math.floor((wrapLon(lon) + 180) / this.landCell)));
      return this.landBits[row * this.landWidth + col] === 1;
    }

    /// Carries a storm forward an hour at a time until it dies. init is {lat, lon, kt, u, v}:
    /// where it was last seen, how strong, and its recent motion in km/h. Returns the hourly
    /// points and why it ended.
    run(init, options = {}) {
      const p = Object.assign({}, this.params, options);
      const hours = Math.min(options.hours || MAX_HOURS, MAX_HOURS);
      const regimeFixed = options.regime || null;
      let { lat, lon, kt } = init;
      let u = init.u || 0, v = init.v || 0;
      // Persistence is a departure from how storms move here, and it fades: each hour the
      // storm keeps exp(-1/tau) of how differently it was moving. Fading towards the local
      // motion rather than holding the first hour's motion is what lets it turn - held,
      // a storm running west keeps a share of that for days and runs straight past the
      // place where storms turn.
      const keep = p.tau > 0 ? Math.exp(-1 / p.tau) : 0;
      let survival = 1;
      let regime = regimeFixed || (u > HYSTERESIS ? 'east' : 'all');
      let wasLand = this.isLand(lat, lon);
      const points = [{ t: 0, lat, lon, kt, land: wasLand, regime }];
      let reason = 'time';
      for (let t = 1; t <= hours; t++) {
        const here = this.motionAt(lat, lon, regime) || this.motionAt(lat, lon, 'all');
        if (!here) { reason = 'left the record'; break; }
        u = here.u + (u - here.u) * keep;
        v = here.v + (v - here.v) * keep;
        if (!regimeFixed) {
          if (regime === 'all' && u > HYSTERESIS) regime = 'east';
          else if (regime === 'east' && u < -HYSTERESIS) regime = 'all';
        }
        const before = lat;
        lat += v / KM_PER_DEGREE;
        lon = wrapLon(lon + u / (KM_PER_DEGREE * Math.max(0.2, Math.cos(toRad(lat)))));
        // No cyclone lives on the equator: the spin it needs comes from the earth's
        // rotation, which is nothing there. An object carried that far has ended.
        if (Math.abs(lat) < 4 || Math.sign(lat) !== Math.sign(before)) {
          points.push({ t, lat: before, lon, kt, land: wasLand, regime });
          reason = 'reached the equator';
          break;
        }
        const land = this.isLand(lat, lon);
        if (land) {
          if (!wasLand) kt *= p.R;                       // the step onto land
          if (kt > p.Vb) kt = p.Vb + (kt - p.Vb) * Math.exp(-p.alpha);
        } else {
          const change = this.intensityChangeAt(lat, lon, kt);
          kt += (change === null ? this.defaultChange : change) / 6;
          survival *= Math.exp(-this.hazardAt(lat, lon));
        }
        kt = Math.min(kt, 185);
        wasLand = land;
        points.push({ t, lat, lon, kt, land, regime });
        if (kt < p.endKt) { reason = 'weakened'; break; }
        // Past the point where half the storms on this path would have ended, this one has.
        if (survival < 0.5) { reason = 'as storms here end'; break; }
        if (Math.abs(lat) > 60) { reason = 'left the tropics'; break; }
        if (t === hours) reason = 'time';
      }
      return { points, end: { t: points[points.length - 1].t, reason } };
    }
  }

  /// Great-circle distance in km.
  function distanceKm(a, b) {
    const p1 = toRad(a.lat), p2 = toRad(b.lat), dp = p2 - p1, dl = toRad(wrapLon(b.lon - a.lon));
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /// A storm moved along an issued forecast - the Japan Meteorological Agency's, from
  /// scripts/fetch-jma-typhoon.cjs - rather than by the record: its analysed and forecast
  /// centres joined smoothly in time, its strength as forecast between them.
  ///
  /// forecast: { points: [{ time (ISO), kind, lat, lon, windKt, class }] }
  /// startMs: the hour the simulation starts, which may fall before the analysis (the
  ///   observations are older than the forecast) or after it (newer).
  /// seen: where the storm was seen at startMs, if it was; the path then starts there
  ///   and eases onto the forecast over JOIN_HOURS. Seen and analysed centres can be a
  ///   hundred kilometres apart - the cloud mass is not the centre - and joined at the
  ///   analysis hour, a few hours on, the path overshot and doubled back.
  /// model: a TyphoonModel, to carry on past the last forecast hour if the forecast
  ///   still has a tropical storm there.
  /// decay: with no model, instead of stopping at the last forecast hour a typhoon still
  ///   blowing there fades out the way recurving storms do (points carry `decay`, 0..1).
  ///
  /// Returns { points, end, forecastHours, knotHours } like run(), with points every hour
  /// from the start, or null when the forecast does not cover the start.
  function followForecast(forecast, startMs, { seen = null, model = null, decay = false } = {}) {
    const knots = [];
    for (const p of (forecast && forecast.points) || []) {
      const h = (Date.parse(p.time) - startMs) / 3600000;
      if (!Number.isFinite(h) || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      if (knots.length && Math.abs(h - knots[knots.length - 1].h) < 0.5) continue;
      knots.push({ h, lat: p.lat, lon: p.lon, kt: Number.isFinite(p.windKt) ? p.windKt : 30, cls: p.class || '' });
    }
    if (knots.length < 2) return null;
    // Longitudes made continuous, so a path over the date line does not swing round the earth.
    for (let i = 1; i < knots.length; i++) knots[i].lon = knots[i - 1].lon + wrapLon(knots[i].lon - knots[i - 1].lon);
    const last = knots[knots.length - 1];
    if (last.h < 12 || knots[0].h > 24) return null;
    if (knots[0].h > 0) {
      // Before the analysis, back along the way it was forecast to go.
      const a = knots[0], b = knots[1], k = a.h / (b.h - a.h);
      knots.unshift({ h: 0, lat: a.lat - (b.lat - a.lat) * k, lon: a.lon - (b.lon - a.lon) * k, kt: a.kt, cls: a.cls });
    }
    // Cubic Hermite through the knots, the slope at each from its neighbours in time:
    // smooth through every forecast centre, and exactly on each.
    const slope = (i, key) => {
      const a = knots[Math.max(0, i - 1)], b = knots[Math.min(knots.length - 1, i + 1)];
      return (b[key] - a[key]) / (b.h - a.h);
    };
    const at = h => {
      let i = 0;
      while (i < knots.length - 2 && knots[i + 1].h < h) i++;
      const a = knots[i], b = knots[i + 1], d = b.h - a.h, t = Math.min(1, Math.max(0, (h - a.h) / d));
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
      const lat = h00 * a.lat + h10 * d * slope(i, 'lat') + h01 * b.lat + h11 * d * slope(i + 1, 'lat');
      const lon = h00 * a.lon + h10 * d * slope(i, 'lon') + h01 * b.lon + h11 * d * slope(i + 1, 'lon');
      return { lat, lon: wrapLon(lon), kt: a.kt + (b.kt - a.kt) * t, cls: t < 1 ? a.cls : b.cls };
    };
    const hours = Math.floor(last.h);
    const start = at(0);
    const dLat = seen ? seen.lat - start.lat : 0, dLon = seen ? wrapLon(seen.lon - start.lon) : 0;
    const points = [];
    for (let t = 0; t <= hours; t++) {
      const p = at(t), k = Math.max(0, 1 - t / JOIN_HOURS);
      const lat = p.lat + dLat * k, lon = wrapLon(p.lon + dLon * k);
      points.push({ t, lat, lon, kt: p.kt, land: model ? model.isLand(lat, lon) : false, forecast: true });
    }
    const forecastHours = hours;
    let end = { t: hours, reason: 'the forecast ends' };
    // Still a typhoon when the forecast stops, and asked to: it does not stop dead there,
    // but goes on as recurving storms end - turning north-east (south-east in the south)
    // and speeding up to a typical pace while it weakens to nothing over DECAY_HOURS. The
    // heading starts from the forecast's own last one; only the pace it tends to and how
    // long it takes to die are typical values, not this storm's. A storm still in the
    // tropics and heading west keeps its heading: it has not recurved.
    if (!model && decay && /台風/.test(last.cls) && last.kt >= END_KT && hours > 0) {
      const a = points[points.length - 2], b = points[points.length - 1];
      let u = wrapLon(b.lon - a.lon) * KM_PER_DEGREE * Math.cos(toRad(b.lat)), v = (b.lat - a.lat) * KM_PER_DEGREE;
      const pole = b.lat >= 0 ? 1 : -1, recurved = u > 0 || Math.abs(b.lat) >= 25;
      const pace = Math.max(Math.hypot(u, v), recurved ? DECAY_KMH : 0);
      const tu = recurved ? pace * Math.SQRT1_2 : u * pace / Math.max(1e-6, Math.hypot(u, v));
      const tv = recurved ? pole * pace * Math.SQRT1_2 : v * pace / Math.max(1e-6, Math.hypot(u, v));
      const ease = 1 - Math.exp(-1 / 12);
      let lat = b.lat, lon = b.lon;
      for (let t = 1; t <= DECAY_HOURS; t++) {
        u += (tu - u) * ease; v += (tv - v) * ease;
        lat += v / KM_PER_DEGREE;
        lon = wrapLon(lon + u / (KM_PER_DEGREE * Math.max(0.2, Math.cos(toRad(lat)))));
        const k = t / DECAY_HOURS;
        points.push({ t: hours + t, lat, lon, kt: b.kt * (1 - k), land: false, decay: k });
      }
      end = { t: hours + DECAY_HOURS, reason: 'weakened after the forecast, as recurving storms do' };
    }
    // Still a tropical storm when the forecast stops: carried on by the record from there.
    if (model && /台風/.test(last.cls) && last.kt >= END_KT && hours > 0) {
      const a = points[points.length - 2] || points[points.length - 1], b = points[points.length - 1];
      const u = wrapLon(b.lon - a.lon) * KM_PER_DEGREE * Math.cos(toRad(b.lat)), v = (b.lat - a.lat) * KM_PER_DEGREE;
      const run = model.run({ lat: b.lat, lon: b.lon, kt: b.kt, u, v }, { hours: Math.max(1, MAX_HOURS - hours) });
      for (const p of run.points.slice(1)) points.push(Object.assign({}, p, { t: p.t + hours }));
      end = { t: points[points.length - 1].t, reason: run.end.reason };
    }
    // The forecast's own hours, for marks on the path the agency's map would have.
    const knotHours = knots.map(k => Math.round(k.h)).filter(h => h > 0 && h <= hours);
    return { points, end, forecastHours, knotHours };
  }

  const Typhoon = { TyphoonModel, betaDrift, decodeBits, followForecast, distanceKm, END_KT, CLASSES, KM_PER_DEGREE };
  root.Typhoon = Typhoon;
  if (typeof module !== 'undefined') module.exports = Typhoon;
})(typeof window === 'undefined' ? globalThis : window);
