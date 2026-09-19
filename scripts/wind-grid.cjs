'use strict';
// The observed wind at one time as a one-degree image the Unity globe reads directly,
// one per bundled observation, so the clouds between two observations are carried by
// the wind of those hours rather than by one wind for the whole sequence.
//
// Input is what cloud-model.js's normalize() keeps from SSEC's AMV GeoJSON: one
// representative vector per 2-degree cell per pressure band, observed at exactly the
// requested time. Output, 360 x 180 RGB, north at the top:
//
//   red, green   eastward and northward wind, -40..+40 m/s as 0..255 (128 is still air)
//   blue         how much observed wind is behind the texel, 0..1 (see below)
//
// No alpha channel on purpose. A browser may premultiply an image by its alpha when
// decoding it, which would wipe the wind wherever alpha was low, so every byte here is
// data and the image is opaque.
//
// Two scales. Near an observed vector (within 2.5 degrees) the wind is the one
// WindField.cs would give: the vectors there, weighted towards the nearest. Further out
// it is spread from the vectors within 9 degrees with a Gaussian of 3 degrees, and blue
// says how much weight that had: close to 1 among observed vectors, falling off a few
// degrees beyond them. Where blue is low the globe falls back to a textbook general
// circulation for carrying the clouds, and draws no flow lines at all.
const zlib = require('zlib');

const WIDTH = 360;
const HEIGHT = 180;
const SCALE = 40;          // m/s either way that the red and green channels span
const NEAR = 2.5;          // degrees: WindField.cs's reach
const SPREAD = 3;          // degrees: the Gaussian that spreads the wind into gaps
const FAR = 9;             // degrees: nothing further than this contributes
const BUCKET = 3;          // degrees per bucket, so each texel looks only nearby

function arcDegrees(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const p1 = lat1 * r, p2 = lat2 * r, dp = p2 - p1, dl = (lon2 - lon1) * r;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a)))) / r;
}

const encode = metres => Math.round(Math.min(1, Math.max(0, metres / (2 * SCALE) + 0.5)) * 255);

/// RGB bytes, row 0 the northernmost, as a PNG stores them.
function grid(points) {
  const columns = 360 / BUCKET, rows = 180 / BUCKET;
  const buckets = new Map();
  for (const p of points) {
    if (![p.lat, p.lon, p.u, p.v].every(Number.isFinite)) continue;
    const key = Math.min(rows - 1, Math.floor((p.lat + 90) / BUCKET)) * 1000 +
      (Math.floor((p.lon + 180) / BUCKET) % columns + columns) % columns;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }

  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  const reach = Math.ceil(FAR / BUCKET);
  let near = 0, spread = 0;
  for (let row = 0; row < HEIGHT; row++) {
    const lat = 89.5 - row;
    const by = Math.floor((lat + 90) / BUCKET);
    // Longitude degrees shrink towards the poles, so more buckets are in reach there.
    const wide = Math.min(columns, Math.ceil(reach / Math.max(Math.cos(lat * Math.PI / 180), 0.05)));
    for (let col = 0; col < WIDTH; col++) {
      const lon = -179.5 + col;
      const bx = Math.floor((lon + 180) / BUCKET);
      let nu = 0, nv = 0, nw = 0, nearest = Infinity, su = 0, sv = 0, sw = 0;
      for (let dy = -reach; dy <= reach; dy++) {
        const y = by + dy;
        if (y < 0 || y >= rows) continue;
        for (let dx = -wide; dx <= wide; dx++) {
          const list = buckets.get(y * 1000 + ((bx + dx) % columns + columns) % columns);
          if (!list) continue;
          for (const p of list) {
            const d = arcDegrees(lat, lon, p.lat, p.lon);
            if (d >= FAR) continue;
            const g = Math.exp(-((d / SPREAD) ** 2));
            su += p.u * g; sv += p.v * g; sw += g;
            if (d < NEAR) {
              const w = (1 - d / NEAR) ** 2;
              nu += p.u * w; nv += p.v * w; nw += w;
              nearest = Math.min(nearest, d);
            }
          }
        }
      }

      const i = (row * WIDTH + col) * 3;
      if (sw <= 0) {
        rgb[i] = 128; rgb[i + 1] = 128; rgb[i + 2] = 0;
        continue;
      }
      const observed = nw > 0 ? Math.min(1, Math.max(0, 1 - nearest / NEAR)) : 0;
      // Near a vector, the local wind; further out, the spread one; in between, a blend.
      const u = nw > 0 ? (nu / nw) * observed + (su / sw) * (1 - observed) : su / sw;
      const v = nw > 0 ? (nv / nw) * observed + (sv / sw) * (1 - observed) : sv / sw;
      const trust = 1 - Math.exp(-sw);
      rgb[i] = encode(u);
      rgb[i + 1] = encode(v);
      rgb[i + 2] = Math.round(Math.max(trust, observed) * 255);
      if (observed > 0) near++;
      spread++;
    }
  }
  return { width: WIDTH, height: HEIGHT, rgb, nearTexels: near, spreadTexels: spread };
}

// ---------------------------------------------------------------- PNG

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/// 8-bit RGB, not interlaced, every row filtered with Sub - which suits smooth fields
/// like this one far better than no filter.
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    raw[out] = 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? rgb[y * stride + x - 3] : 0;
      raw[out + 1 + x] = (rgb[y * stride + x] - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { grid, encodePng, WIDTH, HEIGHT, SCALE, NEAR, SPREAD, FAR };
