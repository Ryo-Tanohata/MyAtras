'use strict';
// The wind the clouds ride on once the observations run out: a flow that keeps
// circulating by the one rule a whole-earth flow cannot do without.
//
// Step three of three. Before this the clouds moved by a wind that depended on latitude
// alone - trade winds, westerlies, polar easterlies - which never bends, so after a day
// or two every cloud in the westerlies was drawn out into a thin east-west streak. Here
// the flow starts as the observations were last seen moving and goes on by the
// equivalent barotropic vorticity equation: potential vorticity
//
//   q = laplacian(psi) - psi / Ld^2 + f,        f = 2 Omega sin(latitude)
//
// is carried along by the flow, which is the rotational part of the wind, and the flow
// is read back from q by inverting the operator. That is enough for troughs and ridges
// to travel and meander, for waves to run westward against the flow the way Rossby
// waves do, and for the jet to stay a jet, with no weather in it: no heating, no
// fronts, no rain, one layer. Ld (the deformation radius) keeps the largest waves from
// running round the earth in a day or two, which a single layer with no Ld does.
//
// Carried semi-Lagrangian: each point takes the q from where its air was an hour ago,
// found in three dimensions so the poles are no different from anywhere else. The
// zonal mean is relaxed slowly towards where it started, so the jets neither drift nor
// wear away over a long scene; the waves are left alone.
//
// Grid: 128 x 64, 2.8125 degrees, cell centres, row 0 the southernmost. Units km and
// hours. Not an observation and not a forecast.
(function (root) {
  const A = 6371;                       // km
  const OMEGA = 2 * Math.PI / 23.9345;  // per hour
  const NX = 128, NY = 64;
  const DLON = 2 * Math.PI / NX, DLAT = Math.PI / NY;

  /// Trade winds near 12 degrees, westerlies near 45, polar easterlies, in km/h east:
  /// the same curve the clouds fell back on before, and the Unity globe still does.
  function climate(latDeg) {
    const a = Math.abs(latDeg), t = (a - 12) / 10, w = (a - 45) / 13, p = (a - 75) / 8;
    return 3.6 * (-6 * Math.exp(-t * t) + 14 * Math.exp(-w * w) - 3 * Math.exp(-p * p));
  }

  /// In-place radix-2 FFT of re/im (length a power of two); inverse when sign is +1.
  function fft(re, im, sign) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = sign * 2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  const catmull = (p0, p1, p2, p3, t) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));

  class BarotropicFlow {
    /// options.ld: the deformation radius in km (Infinity for a plain barotropic flow).
    /// options.relaxHours: how slowly the zonal mean returns to where it started.
    constructor(options = {}) {
      this.ld = options.ld === undefined ? 1000 : options.ld;
      this.relaxHours = options.relaxHours === undefined ? 240 : options.relaxHours;
      this.nx = NX; this.ny = NY;
      const n = NX * NY;
      this.lat = new Float64Array(NY); this.cos = new Float64Array(NY); this.f = new Float64Array(NY);
      this.edge = new Float64Array(NY + 1);            // cos at the row edges; zero at the poles
      for (let j = 0; j < NY; j++) {
        this.lat[j] = -Math.PI / 2 + (j + 0.5) * DLAT;
        this.cos[j] = Math.cos(this.lat[j]);
        this.f[j] = 2 * OMEGA * Math.sin(this.lat[j]);
      }
      for (let j = 1; j < NY; j++) this.edge[j] = Math.cos(-Math.PI / 2 + j * DLAT);
      this.lon = new Float64Array(NX);
      for (let i = 0; i < NX; i++) this.lon[i] = -Math.PI + (i + 0.5) * DLON;
      // Each point as a unit vector, for finding where its air came from.
      this.xyz = new Float64Array(n * 3);
      for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
        const k = (j * NX + i) * 3, c = this.cos[j];
        this.xyz[k] = c * Math.cos(this.lon[i]); this.xyz[k + 1] = c * Math.sin(this.lon[i]); this.xyz[k + 2] = Math.sin(this.lat[j]);
      }
      this.q = new Float64Array(n); this.psi = new Float64Array(n);
      this.u = new Float64Array(n); this.v = new Float64Array(n);
      this.qRef = new Float64Array(NY);
      this.hours = 0;
    }

    index(i, j) { return j * NX + i; }

    /// Starts from a wind (km/h east u, north v, on this grid). Only its rotational
    /// part is kept: the part that goes round rather than in or out.
    setWinds(u, v) {
      const zeta = new Float64Array(NX * NY);
      for (let j = 0; j < NY; j++) {
        const c = this.cos[j];
        for (let i = 0; i < NX; i++) {
          const k = j * NX + i;
          const dv = (v[j * NX + (i + 1) % NX] - v[j * NX + (i + NX - 1) % NX]) / (2 * DLON);
          const north = j < NY - 1 ? 0.5 * (u[k] + u[k + NX]) * this.edge[j + 1] : 0;
          const south = j > 0 ? 0.5 * (u[k] + u[k - NX]) * this.edge[j] : 0;
          zeta[k] = (dv - (north - south) / DLAT) / (A * c);
        }
      }
      // psi for that vorticity with no Ld, then q with it: the inversion with Ld gives
      // the same psi back, so the flow starts exactly as fitted.
      const psi = this.invert(zeta, Infinity);
      for (let k = 0; k < NX * NY; k++) {
        const j = Math.floor(k / NX);
        this.q[k] = zeta[k] - (Number.isFinite(this.ld) ? psi[k] / (this.ld * this.ld) : 0) + this.f[j];
      }
      this.psi = psi;
      this.uBefore = this.vBefore = null;
      this.windsFromPsi();
      for (let j = 0; j < NY; j++) {
        let s = 0;
        for (let i = 0; i < NX; i++) s += this.q[j * NX + i];
        this.qRef[j] = s / NX;
      }
      this.hours = 0;
    }

    /// Solves (laplacian - 1/ld^2) psi = rhs on the sphere: Fourier in longitude, then a
    /// tridiagonal system in latitude for each wavenumber.
    invert(rhs, ld) {
      const inv = Number.isFinite(ld) ? 1 / (ld * ld) : 0;
      const re = [], im = [];
      for (let j = 0; j < NY; j++) {
        const r = new Float64Array(NX), m = new Float64Array(NX);
        for (let i = 0; i < NX; i++) r[i] = rhs[j * NX + i];
        fft(r, m, -1);
        re.push(r); im.push(m);
      }
      const outRe = Array.from({ length: NY }, () => new Float64Array(NX));
      const outIm = Array.from({ length: NY }, () => new Float64Array(NX));
      const lower = new Float64Array(NY), upper = new Float64Array(NY), diag = new Float64Array(NY);
      const cp = new Float64Array(NY), dr = new Float64Array(NY), di = new Float64Array(NY);
      for (let m = 0; m < NX / 2; m++) {
        if (m === 0 && inv === 0) {
          // The zonal mean with no Ld: fixed only up to a constant, so integrated
          // directly, once the mean that no flow can hold has been taken off.
          let num = 0, den = 0;
          for (let j = 0; j < NY; j++) { num += re[j][0] * this.cos[j]; den += this.cos[j]; }
          const mean = num / den;
          let flux = 0, psi = 0;
          const col = new Float64Array(NY);
          for (let j = 0; j < NY - 1; j++) {
            flux += (re[j][0] - mean) * this.cos[j] * A * A * DLAT * DLAT;
            psi += flux / this.edge[j + 1];
            col[j + 1] = psi;
          }
          let avg = 0;
          for (let j = 0; j < NY; j++) avg += col[j] * this.cos[j];
          avg /= den;
          for (let j = 0; j < NY; j++) { outRe[j][0] = col[j] - avg; outIm[j][0] = 0; }
          continue;
        }
        for (let j = 0; j < NY; j++) {
          const s = A * A * this.cos[j] * DLAT * DLAT;
          lower[j] = this.edge[j] / s;
          upper[j] = this.edge[j + 1] / s;
          diag[j] = -(lower[j] + upper[j]) - (m * m) / (A * A * this.cos[j] * this.cos[j]) - inv;
        }
        // Thomas, for the real and imaginary parts together.
        cp[0] = upper[0] / diag[0]; dr[0] = re[0][m] / diag[0]; di[0] = im[0][m] / diag[0];
        for (let j = 1; j < NY; j++) {
          const d = diag[j] - lower[j] * cp[j - 1];
          cp[j] = upper[j] / d;
          dr[j] = (re[j][m] - lower[j] * dr[j - 1]) / d;
          di[j] = (im[j][m] - lower[j] * di[j - 1]) / d;
        }
        for (let j = NY - 2; j >= 0; j--) { dr[j] -= cp[j] * dr[j + 1]; di[j] -= cp[j] * di[j + 1]; }
        for (let j = 0; j < NY; j++) {
          outRe[j][m] = dr[j]; outIm[j][m] = di[j];
          if (m > 0) { outRe[j][NX - m] = dr[j]; outIm[j][NX - m] = -di[j]; }
        }
      }
      const psi = new Float64Array(NX * NY);
      for (let j = 0; j < NY; j++) {
        outRe[j][NX / 2] = 0; outIm[j][NX / 2] = 0;       // the shortest wave is left out
        fft(outRe[j], outIm[j], 1);
        for (let i = 0; i < NX; i++) psi[j * NX + i] = outRe[j][i] / NX;
      }
      return psi;
    }

    windsFromPsi() {
      const psi = this.psi;
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const k = j * NX + i;
          // Centred everywhere: beside a pole, the row beyond it is the same row half way
          // round the earth.
          this.u[k] = -(this.at(psi, i, j + 1) - this.at(psi, i, j - 1)) / (2 * DLAT * A);
          this.v[k] = (psi[j * NX + (i + 1) % NX] - psi[j * NX + (i + NX - 1) % NX]) / (2 * DLON * A * this.cos[j]);
        }
      }
    }

    /// A field's value at row j (which may run past a pole) and column i.
    at(field, i, j) {
      if (j < 0) { j = -1 - j; i += NX / 2; } else if (j >= NY) { j = 2 * NY - 1 - j; i += NX / 2; }
      return field[j * NX + ((i % NX) + NX) % NX];
    }

    /// Cubic (Catmull-Rom) interpolation of a scalar at a unit vector.
    sampleCubic(field, x, y, z) {
      const lat = Math.asin(Math.max(-1, Math.min(1, z))), lon = Math.atan2(y, x);
      const fx = (lon + Math.PI) / DLON - 0.5, fy = (lat + Math.PI / 2) / DLAT - 0.5;
      const i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
      const rows = [];
      for (let dj = -1; dj <= 2; dj++) {
        const j = j0 + dj;
        rows.push(catmull(this.at(field, i0 - 1, j), this.at(field, i0, j), this.at(field, i0 + 1, j), this.at(field, i0 + 2, j), tx));
      }
      return catmull(rows[0], rows[1], rows[2], rows[3], ty);
    }

    /// The wind at every point as a vector in three dimensions, for velocity().
    /// The wind half way through the coming step: carried on from the last two steps
    /// (1.5 now - 0.5 before), which keeps fast waves at their speed; with the wind now
    /// alone they fell 8% behind at two-hour steps.
    velocityGrid() {
      const n = NX * NY, g = this.v3 || (this.v3 = new Float64Array(n * 3));
      const pu = this.uBefore, pv = this.vBefore;
      for (let j = 0; j < NY; j++) {
        const sp = Math.sin(this.lat[j]), cp = this.cos[j];
        for (let i = 0; i < NX; i++) {
          const k = j * NX + i;
          const u = pu ? 1.5 * this.u[k] - 0.5 * pu[k] : this.u[k], v = pv ? 1.5 * this.v[k] - 0.5 * pv[k] : this.v[k];
          const sl = Math.sin(this.lon[i]), cl = Math.cos(this.lon[i]);
          // east = (-sin lon, cos lon, 0), north = (-sin lat cos lon, -sin lat sin lon, cos lat)
          g[k * 3] = -u * sl - v * sp * cl; g[k * 3 + 1] = u * cl - v * sp * sl; g[k * 3 + 2] = v * cp;
        }
      }
      return g;
    }

    /// The wind as a vector in three dimensions at a unit vector, bilinear, from the
    /// grid velocityGrid() made.
    velocity(x, y, z, out) {
      const g = this.v3;
      const lat = Math.asin(Math.max(-1, Math.min(1, z))), lon = Math.atan2(y, x);
      const fx = (lon + Math.PI) / DLON - 0.5, fy = (lat + Math.PI / 2) / DLAT - 0.5;
      const i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
      let vx = 0, vy = 0, vz = 0;
      for (let c = 0; c < 4; c++) {
        const di = c & 1, dj = c >> 1, w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
        let i = i0 + di, j = j0 + dj;
        if (j < 0) { j = -1 - j; i += NX / 2; } else if (j >= NY) { j = 2 * NY - 1 - j; i += NX / 2; }
        const k = (j * NX + ((i % NX) + NX) % NX) * 3;
        vx += w * g[k]; vy += w * g[k + 1]; vz += w * g[k + 2];
      }
      // Only the part along the sphere at this point.
      const d = vx * x + vy * y + vz * z;
      out[0] = vx - d * x; out[1] = vy - d * y; out[2] = vz - d * z;
      return out;
    }

    /// Moves the flow on by dt hours.
    step(dt = 1) {
      const n = NX * NY, next = new Float64Array(n), xyz = this.xyz, vel = [0, 0, 0];
      if (this.dtBefore !== dt) this.uBefore = this.vBefore = null;
      this.velocityGrid();
      for (let k = 0; k < n; k++) {
        const x = xyz[k * 3], y = xyz[k * 3 + 1], z = xyz[k * 3 + 2];
        // Where this air was dt ago, by the wind at the middle of the way, twice refined.
        let mx = x, my = y, mz = z;
        for (let it = 0; it < 2; it++) {
          this.velocity(mx, my, mz, vel);
          const h = dt / 2 / A;
          const ax = x - h * vel[0], ay = y - h * vel[1], az = z - h * vel[2];
          const r = Math.hypot(ax, ay, az); mx = ax / r; my = ay / r; mz = az / r;
        }
        this.velocity(mx, my, mz, vel);
        const h = dt / A;
        const dx = x - h * vel[0], dy = y - h * vel[1], dz = z - h * vel[2];
        const r = Math.hypot(dx, dy, dz);
        next[k] = this.sampleCubic(this.q, dx / r, dy / r, dz / r);
      }
      // The zonal mean eased back towards where it began; the waves are untouched.
      const keep = this.relaxHours > 0 ? Math.exp(-dt / this.relaxHours) : 1;
      if (keep < 1) {
        for (let j = 0; j < NY; j++) {
          let s = 0;
          for (let i = 0; i < NX; i++) s += next[j * NX + i];
          const shift = (this.qRef[j] - s / NX) * (1 - keep);
          for (let i = 0; i < NX; i++) next[j * NX + i] += shift;
        }
      }
      this.q = next;
      const rhs = new Float64Array(n);
      for (let k = 0; k < n; k++) rhs[k] = next[k] - this.f[Math.floor(k / NX)];
      this.psi = this.invert(rhs, this.ld);
      // Kept for the next step's estimate, if it is as long as this one.
      this.uBefore = this.u.slice(); this.vBefore = this.v.slice(); this.dtBefore = dt;
      this.windsFromPsi();
      this.hours += dt;
    }

    /// Kinetic energy per unit area, weighted by area: for checks.
    energy() {
      let e = 0, w = 0;
      for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        e += 0.5 * (this.u[k] * this.u[k] + this.v[k] * this.v[k]) * this.cos[j]; w += this.cos[j];
      }
      return e / w;
    }

    /// The winds as a 128 x 64 RGBA texture, row 0 the southernmost: east in red and
    /// green, north in blue and alpha, each 16 bits over -400..+400 km/h.
    texture(out = new Uint8Array(NX * NY * 4)) {
      const put = (value, o) => {
        const c = Math.min(1, Math.max(0, (value + 400) / 800)) * 255;
        const hi = Math.floor(c);
        out[o] = hi; out[o + 1] = Math.min(255, Math.round((c - hi) * 255));
      };
      for (let k = 0; k < NX * NY; k++) { put(this.u[k], k * 4); put(this.v[k], k * 4 + 2); }
      return out;
    }
  }

  /// A starting wind on the flow's grid from fields of observed cloud motion: each a
  /// {width, height, u, v, w} grid in km/h with confidence w, row 0 the northernmost at
  /// 90 - (row + 0.5) * 180 / height (the layout of dist/data/motion). Averaged by
  /// confidence, and eased into the typical circulation where the confidence runs out.
  function startingWinds(fields) {
    const u = new Float64Array(NX * NY), v = new Float64Array(NX * NY);
    for (let j = 0; j < NY; j++) {
      const latDeg = (-Math.PI / 2 + (j + 0.5) * DLAT) * 180 / Math.PI;
      for (let i = 0; i < NX; i++) {
        const lonDeg = (-Math.PI + (i + 0.5) * DLON) * 180 / Math.PI;
        let su = 0, sv = 0, sw = 0;
        for (const f of fields) {
          const fy = (90 - latDeg) / (180 / f.height) - 0.5, fx = (lonDeg + 180) / (360 / f.width) - 0.5;
          const y0 = Math.floor(fy), x0 = Math.floor(fx), ty = fy - y0, tx = fx - x0;
          for (const [dx, dy, g] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
            const y = Math.min(f.height - 1, Math.max(0, y0 + dy)), x = ((x0 + dx) % f.width + f.width) % f.width;
            const k = y * f.width + x, c = f.w[k] * g;
            su += f.u[k] * c; sv += f.v[k] * c; sw += c;
          }
        }
        const confidence = fields.length ? Math.min(1, 1.5 * sw / fields.length) : 0;
        const k = j * NX + i;
        const mu = sw > 0 ? su / sw : 0, mv = sw > 0 ? sv / sw : 0;
        u[k] = confidence * mu + (1 - confidence) * climate(latDeg);
        v[k] = confidence * mv;
      }
    }
    return { u, v };
  }

  /// A motion image (dist/data/motion, RGB: east, north over +-scale m/s, confidence) as
  /// a field for startingWinds. pixels: RGB or RGBA bytes.
  function motionField(pixels, width, height, channels, scale) {
    const n = width * height, u = new Float64Array(n), v = new Float64Array(n), w = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const o = k * channels;
      u[k] = (pixels[o] / 255 - 0.5) * 2 * scale * 3.6;
      v[k] = (pixels[o + 1] / 255 - 0.5) * 2 * scale * 3.6;
      w[k] = pixels[o + 2] / 255;
    }
    return { width, height, u, v, w };
  }

  const Flow = { BarotropicFlow, startingWinds, motionField, climate, fft, NX, NY, A, OMEGA };
  root.BackgroundFlow = Flow;
  if (typeof module !== 'undefined') module.exports = Flow;
})(typeof window === 'undefined' ? globalThis : window);
