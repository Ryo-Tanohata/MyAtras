# Third-party data and assets

This project has no package dependencies. It bundles the following third-party
material, unmodified except where noted.

## SSEC RealEarth — University of Wisconsin-Madison

Satellite observations and atmospheric motion vectors, retrieved through the
documented public HTTP API.

- Terms of use: https://www.ssec.wisc.edu/realearth/terms-of-use/
- API documentation: https://realearth.ssec.wisc.edu/doc/api.php
- Wind product notes: https://tropic.ssec.wisc.edu/misc/winds/info.html

### Observation images

| File | Product | Observed (UTC) |
| --- | --- | --- |
| `dist/weather/sequence/globalir_*.png` | `globalir` | 2026-09-17 05:00 – 2026-09-20 04:00 UTC, hourly (72 frames) |
| `dist/weather/snapshot/globalir_20260920_040000.png` | `globalir` | 2026-09-20 04:00 UTC |
| `dist/weather/snapshot/globalvis_20260920_040000.png` | `globalvis` | 2026-09-20 04:00 UTC |

The times above are a summary and go out of date the moment the observations are
refreshed. `dist/weather/sequence/manifest.json` and `dist/weather/snapshot.json`
are the authority: each bundled file is listed there with the request URL it came
from and its SHA-256, and `scripts/export-html.py` re-checks those digests.

The image files are stored exactly as the API returned them. Each one records the
request it came from and its SHA-256 in `dist/weather/sequence/manifest.json` or
`dist/weather/snapshot.json`, and the export re-checks those digests. The SSEC
watermark and logo are kept in the files and are drawn, not painted over, by the
globe shader. The white cloud layer shown by default is a display composite
computed in the shader at draw time; it never alters the stored image.

### Atmospheric motion vectors

`dist/data/amv.json` holds 3,292 representative vectors selected from the
`AMV-LLlow` and `AMV-LLmid` products at 2026-09-18 16:00 UTC, with the selection
counts recorded alongside them. Source responses:

- https://realearth.ssec.wisc.edu/api/shapes?products=AMV-LLlow_20260918_160000
- https://realearth.ssec.wisc.edu/api/shapes?products=AMV-LLmid_20260918_160000

`dist/data/wind/` holds the same two products gridded at each of the bundled
observation times, 71 of the 72 - SSEC had not published the vectors for the newest
observation when it was fetched. Every grid records its source URLs, its vector
counts and its SHA-256 in `dist/data/wind/manifest.json`.

### Work derived from the observations

These are computed here from the bundled SSEC files and are not themselves
third-party material, but they exist only because of that data and are listed so
the provenance is complete. Each one records the SHA-256 of the observations it was
computed from, and is rebuilt whenever those are replaced.

- `dist/data/motion/` — 71 fields, how the cloud pattern moved between each pair of
  consecutive observations (`scripts/build-motion.cjs`). An estimate, not an
  observation.
- `dist/data/storms.json` — the tropical cyclones found in the sequence
  (`scripts/find-storms.cjs`): the centre of the cold cloud, hour by hour. Not a
  storm position in the sense a forecaster means, and not a forecast.

`dist/data/tendency.json` is listed above under NOAA NCEI: it is not measured from the
observations but from the record of past storms, and it changes only as decades pass, so
it is built by hand rather than by the publish workflow.

## NOAA NCEI — the record of past storms

`dist/data/tendency.json` is derived from IBTrACS v04r01, the International Best Track
Archive for Climate Stewardship, which gathers the best track records of every regional
agency into one file. Nothing of the archive itself is bundled: what ships is a grid of
the median heading and pace of the storms that passed through each cell, and how widely
they differed, computed by `scripts/build-tendency.cjs` from 4,759 tropical cyclones and
225,747 six-hourly legs since 1980. The archive's own SHA-256 is recorded in the file.

- Source: https://www.ncei.noaa.gov/products/international-best-track-archive
- File used: `ibtracs.since1980.list.v04r01.csv` (137 MB, not bundled)
- Knapp, K. R., M. C. Kruk, D. H. Levinson, H. J. Diamond, and C. J. Neumann, 2010:
  The International Best Track Archive for Climate Stewardship (IBTrACS).
  *Bull. Amer. Meteor. Soc.*, 91, 363-376.

## NASA — ground reference texture

`dist/assets/earth.jpg` is NASA's Blue Marble *Land Surface, Shallow Water, and
Shallow Topography*, stored byte for byte as downloaded.

- Source: https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57752/land_shallow_topo_2048.jpg
- 2048 x 1024 equirectangular, 238,676 bytes
- SHA-256: `5b54cc586c6cbf2b28762ef4d4011f6cf4227a8b93a637b818a0c54090ce6c2c`

## NASA — city lights (Unity version only)

`dist/assets/night.jpg` is NASA Earth Observatory's Black Marble 2016 global
composite of the Earth at night. Unlike `earth.jpg` it is not stored as downloaded:
it was resized to match the ground reference texture.

- Source: https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg
- Downloaded: 3600 x 1800 equirectangular, 779,638 bytes,
  SHA-256 `d87de751a264e4f8ff69c68de5dab9606daee87a6f15ae743c93200743bd7ec1`
- Stored: resized to 2048 x 1024 with Pillow (Lanczos) and saved as JPEG quality 85,
  151,835 bytes, SHA-256 `6e53c95e71a42870850731c47cb4a477941882c0699d7b41e2fbb8aa2b03ac10`
- Registration checked after resizing: Tokyo and Cairo bright, the open Pacific dark.

It is a fixed 2016 composite, not a current observation, and the Unity page says so.

## Bright Star Catalogue — stars (Unity version only)

`dist/assets/stars.png` is drawn by `scripts/build-stars.py` from the Bright Star
Catalogue, 5th Revised Edition (Hoffleit D., Warren Jr W.H., 1991), as distributed by
CDS in VizieR catalogue V/50. Only the J2000 positions, V magnitudes and B-V colours
of the 5,080 stars brighter than magnitude 6.0 are used; no other part of the
catalogue is included.

- Source: https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz
- 573,921 bytes, SHA-256 `3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed`;
  the script refuses any other file
- Drawn: 2048 x 1024, 202,702 bytes,
  SHA-256 `b35d3c234c09c7e7c5708201fffb1b22d3fee73013e100839025356dd956f594`;
  the drawing is deterministic and reproduces this hash

No licence file accompanies the CDS distribution. It is cited here and on the Unity
page as CDS asks: the authors, the edition and the VizieR catalogue number.

## Natural Earth — night-side land and coastline (Unity version only)

`dist/assets/land.png` is drawn by `scripts/build-land.py` from Natural Earth's 1:50m
land polygons: land in the red channel, the coastline in the green. The Unity globe
uses it only on the night side, so that land and sea can be told apart where the
ground is darkened; it is an aid, not an observation, and the page says so.

- Source: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
- 1,636,166 bytes, SHA-256 `e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b`;
  the script refuses any other file
- Drawn: 2048 x 1024, 151,677 bytes,
  SHA-256 `b3d1c76a49f4e543620258825b469253feb9a4fce847b003e988e13f4b591b75`;
  the drawing is deterministic and reproduces this hash

Natural Earth is in the public domain; it is credited on the Unity page.

- https://www.naturalearthdata.com/about/terms-of-use/

NASA still images are not subject to copyright in the United States and may be
reused with NASA credited as the source. NASA's insignia and logotype are not
used here, and nothing in this project implies NASA endorsement.

- https://www.nasa.gov/nasa-brand-center/images-and-media/

This image shows the land and ocean surface with no clouds. The snow and ice in
it are part of the picture and do not change with the observations; every cloud
the globe shows comes from the SSEC observations.

## Miraikan

The National Museum of Emerging Science and Innovation (Miraikan) and its
Geo-Cosmos exhibit are the inspiration for this project. Nothing here is
affiliated with, endorsed by or produced by Miraikan. No Miraikan imagery or
processing is included, and the exhibit's name is not used as the name of this
project or as a heading in its interface: it appears only where the page says
what inspired it.

- https://www.miraikan.jst.go.jp/
