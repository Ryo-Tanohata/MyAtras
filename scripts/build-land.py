#!/usr/bin/env python3
"""Draw dist/assets/land.png, the land and its coastline, from Natural Earth.

    python scripts/build-land.py LAND_GEOJSON

LAND_GEOJSON is Natural Earth's 1:50m land polygons (public domain), as published in
the natural-earth-vector repository:

    https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson

The Unity globe darkens the night side to 5%, which leaves no way to tell land from sea
where there are no towns. This map gives it that back, as an aid rather than anything
observed: the red channel is 255 over land and 0 over sea, the green channel is the
coastline drawn about 1.5 pixels wide. Both are drawn at four times the size and
reduced, so edges are smooth. Same equirectangular layout as the ground texture:
longitude -180 at the left edge, latitude +90 at the top.

Needs Pillow.
"""
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "assets" / "land.png"

WIDTH, HEIGHT = 2048, 1024
SCALE = 4
# The file as downloaded when this map was made; a different file stops the build
# rather than silently moving a coastline.
LAND_SHA256 = "e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b"


def to_pixels(ring):
    w, h = WIDTH * SCALE, HEIGHT * SCALE
    return [((lon + 180.0) / 360.0 * w, (90.0 - lat) / 180.0 * h) for lon, lat in ring]


def polygons(geometry):
    if geometry["type"] == "Polygon":
        yield geometry["coordinates"]
    elif geometry["type"] == "MultiPolygon":
        yield from geometry["coordinates"]


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    raw = Path(sys.argv[1]).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    print(f"land       {len(raw):,} bytes  sha256 {digest}")
    if digest != LAND_SHA256:
        sys.exit(f"expected the land polygons with sha256 {LAND_SHA256}; not drawing from another")

    features = json.loads(raw)["features"]
    land = Image.new("L", (WIDTH * SCALE, HEIGHT * SCALE), 0)
    coast = Image.new("L", (WIDTH * SCALE, HEIGHT * SCALE), 0)
    fill, line = ImageDraw.Draw(land), ImageDraw.Draw(coast)
    rings = 0
    for feature in features:
        for rings_of_polygon in polygons(feature["geometry"]):
            outer, holes = rings_of_polygon[0], rings_of_polygon[1:]
            fill.polygon(to_pixels(outer), fill=255)
            for hole in holes:
                fill.polygon(to_pixels(hole), fill=0)
            for ring in rings_of_polygon:
                points = to_pixels(ring)
                # Natural Earth cuts land at the antimeridian; those cut edges are not coast.
                for a, b in zip(points, points[1:] + points[:1]):
                    at_edge = (a[0] <= 1 and b[0] <= 1) or (a[0] >= WIDTH * SCALE - 1 and b[0] >= WIDTH * SCALE - 1)
                    if not at_edge:
                        line.line([a, b], fill=255, width=6)
                rings += 1
    print(f"drew       {len(features)} features, {rings} rings")

    size = (WIDTH, HEIGHT)
    red = land.resize(size, Image.BOX)
    green = coast.resize(size, Image.BOX)
    image = Image.merge("RGB", (red, green, Image.new("L", size, 0)))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUT, optimize=True)
    data = OUT.read_bytes()
    print(f"wrote      {OUT.relative_to(ROOT)}  {WIDTH}x{HEIGHT}  {len(data):,} bytes  "
          f"sha256 {hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()
