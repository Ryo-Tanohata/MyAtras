'use strict';
// Just enough PNG to read back a screenshot: chunk walk, inflate, undo the row
// filters. Node's own zlib does the decompression, so this needs no packages.
// Only what headless Chromium produces is handled - 8-bit RGB or RGBA, not
// interlaced - and anything else is refused rather than guessed at.
const zlib = require('zlib');

function decode(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');

  let width = 0, height = 0, channels = 0;
  const parts = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + data + crc

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8], colorType = data[9], interlace = data[12];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (interlace !== 0) throw new Error('interlaced PNGs are not supported');
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`unsupported colour type ${colorType}`);
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('no IHDR');

  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;   // pixel to the left
      const b = prior ? prior[x] : 0;                    // pixel above
      const c = prior && x >= channels ? prior[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`unknown row filter ${filter}`);
      row[x] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/// Mean brightness and how many distinct colours a region holds. A globe that
/// rendered has hundreds; a page that came up blank has one or two.
function region(image, left, top, right, bottom) {
  const { channels, data, width } = image;
  const seen = new Set();
  let sum = 0, count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      sum += (r + g + b) / 3;
      seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      count++;
    }
  }
  return { mean: count ? sum / count : 0, colours: seen.size, pixels: count };
}

/// Fraction of pixels that differ by more than `threshold` between two images of
/// the same size - how much of the picture a drag or a new observation changed.
function changed(a, b, threshold = 12) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('sizes differ');
  let differing = 0;
  const total = a.width * a.height;
  for (let i = 0; i < total; i++) {
    const ai = i * a.channels, bi = i * b.channels;
    const delta = Math.abs(a.data[ai] - b.data[bi])
      + Math.abs(a.data[ai + 1] - b.data[bi + 1])
      + Math.abs(a.data[ai + 2] - b.data[bi + 2]);
    if (delta > threshold) differing++;
  }
  return differing / total;
}

module.exports = { decode, region, changed };
