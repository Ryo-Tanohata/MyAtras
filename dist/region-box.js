'use strict';
// Where a close-up of one part of the world sits inside the whole-globe picture.
//
// SSEC serves an image for a bounds box in Web Mercator, which is the projection the
// globe shader already samples the global frames in: x across the world's longitudes,
// y as the Mercator latitude clipped at 85.05112878. A crop is therefore the same
// picture over a smaller box, and placing it only needs that box expressed in the
// same 0..1 coordinates - which is what this returns. Nothing here resamples or
// invents anything; it is the arithmetic both the fetch script and the page use, so
// the two cannot drift apart.
(function (root) {
  const LIMIT = 85.05112878;

  /// The Mercator y of a latitude, 0 at the top edge of a global frame and 1 at the
  /// bottom, matching the `my` the globe shader computes.
  function mercator01(latitude) {
    const clamped = Math.max(-LIMIT, Math.min(LIMIT, latitude));
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360)) / (2 * Math.PI);
  }

  /// A box from its bounds and the width asked for. The height follows from the
  /// projection, so a pixel is as tall as it is wide and the crop is not stretched.
  /// u0/u1/v0/v1 are the box in the global frame's own coordinates.
  function box({ south, west, north, east, width }) {
    if (!(south < north)) throw new Error('south must be below north');
    if (!(west < east)) throw new Error('west must be left of east; a box across the date line is not supported');
    if (!(width > 0)) throw new Error('width must be a positive number of pixels');
    const v0 = mercator01(north), v1 = mercator01(south);
    const u0 = (west + 180) / 360, u1 = (east + 180) / 360;
    const height = Math.round(width * (v1 - v0) / (u1 - u0));
    return { south, west, north, east, width, height, u0, u1, v0, v1 };
  }

  /// Kilometres on the ground per pixel at a latitude inside the box - what decides
  /// whether zooming in shows anything new.
  function kmPerPixel(b, latitude) {
    return 40075 * (b.east - b.west) / 360 / b.width * Math.cos(latitude * Math.PI / 180);
  }

  const RegionBox = { LIMIT, mercator01, box, kmPerPixel };
  root.RegionBox = RegionBox;
  if (typeof module !== 'undefined') module.exports = RegionBox;
})(typeof window === 'undefined' ? globalThis : window);
