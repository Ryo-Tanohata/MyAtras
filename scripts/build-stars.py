#!/usr/bin/env python3
"""Draw dist/assets/stars.png from the Yale Bright Star Catalogue.

    python scripts/build-stars.py CATALOG_GZ

CATALOG_GZ is catalog.gz from CDS VizieR V/50, the Bright Star Catalogue, 5th revised
edition (Hoffleit & Warren 1991):

    https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz

Every star down to visual magnitude 6.0, roughly what an eye sees on a dark night, is
drawn at its J2000 position on an equirectangular map of the sky: right ascension
across (0 h at the left edge, increasing to the right), declination down from +90 at the
top. Brightness follows magnitude and colour follows B-V. A star is drawn wider in right
ascension the closer it is to a pole, so that it is round on the sky rather than on the
map. The Unity globe turns this map by Greenwich sidereal time, so the stars behind the
Earth stand where they stood at each observation's time.

Needs Pillow.
"""
import gzip
import hashlib
import math
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "assets" / "stars.png"

WIDTH, HEIGHT = 2048, 1024
FAINTEST = 6.0
# The catalogue as downloaded when this map was made; a different file stops the build
# rather than silently changing the sky.
CATALOG_SHA256 = "3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed"


def parse(line):
    """J2000 right ascension and declination in degrees, V magnitude, B-V; None if absent."""
    try:
        ra = (int(line[75:77]) + int(line[77:79]) / 60 + float(line[79:83]) / 3600) * 15
        dec = int(line[84:86]) + int(line[86:88]) / 60 + int(line[88:90]) / 3600
        if line[83] == "-":
            dec = -dec
        vmag = float(line[102:107])
    except ValueError:
        return None
    bv_text = line[109:114].strip()
    bv = float(bv_text) if bv_text else 0.6
    return ra, dec, vmag, bv


def tint(bv):
    """A star's colour from B-V: blue-white for hot stars, orange for cool ones."""
    stops = [(-0.3, (0.62, 0.72, 1.00)), (0.0, (0.82, 0.88, 1.00)), (0.6, (1.00, 0.97, 0.90)),
             (1.0, (1.00, 0.88, 0.72)), (1.6, (1.00, 0.78, 0.58))]
    if bv <= stops[0][0]:
        return stops[0][1]
    for (b0, c0), (b1, c1) in zip(stops, stops[1:]):
        if bv <= b1:
            t = (bv - b0) / (b1 - b0)
            return tuple(a + (b - a) * t for a, b in zip(c0, c1))
    return stops[-1][1]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    raw = Path(sys.argv[1]).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    print(f"catalogue  {len(raw):,} bytes  sha256 {digest}")
    if digest != CATALOG_SHA256:
        sys.exit(f"expected the catalogue with sha256 {CATALOG_SHA256}; not drawing from another")

    stars = [s for s in map(parse, gzip.decompress(raw).decode("latin-1").splitlines())
             if s and s[2] <= FAINTEST]
    print(f"stars      {len(stars)} down to magnitude {FAINTEST}")

    light = [[0.0, 0.0, 0.0] for _ in range(WIDTH * HEIGHT)]
    px_per_deg = WIDTH / 360.0
    for ra, dec, vmag, bv in stars:
        # Magnitude is already logarithmic, like the eye: a linear ramp reads naturally.
        strength = min(1.0, max(0.07, (6.5 - vmag) / 8.0))
        sigma = 0.45 + 0.85 * strength            # pixels, at the equator
        stretch = 1.0 / max(0.05, math.cos(math.radians(dec)))
        cx = ra * px_per_deg
        cy = (90.0 - dec) * px_per_deg
        colour = tint(bv)
        reach_x = int(math.ceil(3 * sigma * stretch)) + 1
        reach_y = int(math.ceil(3 * sigma)) + 1
        for y in range(int(cy) - reach_y, int(cy) + reach_y + 1):
            if not 0 <= y < HEIGHT:
                continue
            dy = (y + 0.5) - cy
            for x in range(int(cx) - reach_x, int(cx) + reach_x + 1):
                dx = ((x + 0.5) - cx) / stretch
                weight = strength * math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
                if weight < 0.004:
                    continue
                cell = light[y * WIDTH + (x % WIDTH)]
                for c in range(3):
                    cell[c] += colour[c] * weight

    image = Image.new("RGB", (WIDTH, HEIGHT))
    image.putdata([tuple(min(255, int(round(v * 255))) for v in cell) for cell in light])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, optimize=True)
    data = OUT.read_bytes()
    print(f"wrote      {OUT.relative_to(ROOT)}  {WIDTH}x{HEIGHT}  {len(data):,} bytes  "
          f"sha256 {hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()
