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
| `dist/weather/sequence/globalir_*.png` | `globalir` | 2026-09-22 22:00 – 2026-09-25 20:00 UTC, hourly (71 frames, 13.9 MB) |
| `dist/weather/region/japan_globalir_*.png` | `globalir` | 2026-09-25 09:00 – 2026-09-25 20:00 UTC, hourly (12 frames, 3.8 MB) |
| `dist/weather/snapshot/globalir_20260925_200000.png` | `globalir` | 2026-09-25 20:00 UTC |
| `dist/weather/snapshot/globalvis_20260925_200000.png` | `globalvis` | 2026-09-25 20:00 UTC |

The times above are a summary and go out of date the moment the observations are
refreshed. `dist/weather/sequence/manifest.json` and `dist/weather/snapshot.json`
are the authority: each bundled file is listed there with the request URL it came
from and its SHA-256, and `scripts/export-html.py` re-checks those digests.

The close-up in `dist/weather/region/` is the same product at the same times over a
box instead of the whole world: south 24°, west 122°, north 46°, east 148°, 1024 × 1071
pixels, about 2.3 km to a pixel. That size is what SSEC serves: an image request above
about 1.17 million pixels comes back with "Size limit exceeded" written across it in
tiles and an `RE-Watermark` header saying how far over it was, and
`scripts/fetch-observations.cjs` refuses such an answer instead of storing it. It is what the API returned for those bounds - nothing
is enlarged, interpolated or generated - and `dist/weather/region/manifest.json` records
the bounds, the size and each file's URL and SHA-256. The page loads it only when asked
and shows it only inside those bounds.

The image files are stored exactly as the API returned them. Each one records the
request it came from and its SHA-256 in `dist/weather/sequence/manifest.json` or
`dist/weather/snapshot.json`, and the export re-checks those digests. The SSEC
watermark and logo are kept in the files and are drawn, not painted over, by the
globe shader. The white cloud layer shown by default is a display composite
computed in the shader at draw time; it never alters the stored image.

### Atmospheric motion vectors

`dist/data/amv.json` holds 2,776 representative vectors selected from the
`AMV-LLlow` and `AMV-LLmid` products at 2026-09-24 09:00 UTC, the middle of the
bundled sequence, with the selection counts recorded alongside them. Source responses:

- https://realearth.ssec.wisc.edu/api/shapes?products=AMV-LLlow_20260924_090000
- https://realearth.ssec.wisc.edu/api/shapes?products=AMV-LLmid_20260924_090000

`dist/data/wind/` holds the same two products gridded at bundled observation times:
13 of the 71, every sixth hour plus the one amv.json is built from. One answer for one
hour is about 23 MB, so asking at every hour of a three-day set would download about
1.6 GB from a university's public API to keep 3 MB of one-degree grids; the wind is the
second source for the model between observations, behind the motion measured from the
images themselves, so the hours in between fall back on that motion. Every grid records
its source URLs, its vector counts and its SHA-256 in `dist/data/wind/manifest.json`,
and an hour with no grid of its own is simply absent from it.

### Work derived from the observations

These are computed here from the bundled SSEC files and are not themselves
third-party material, but they exist only because of that data and are listed so
the provenance is complete. Each one records the SHA-256 of the observations it was
computed from, and is rebuilt whenever those are replaced.

- `dist/data/motion/` — 70 fields, how the cloud pattern moved between each pair of
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

`dist/data/typhoon.json` comes from the same archive, by `scripts/build-typhoon.cjs` in
`.github/workflows/typhoon-model.yml`: for each 2.5-degree cell, the median motion of all
storms and of those already turned east, the median six-hour change in strength over the
sea by strength class, and how often per hour a storm's life as a tropical storm ended
there (228,336 legs of motion, 136,783 of change in strength, 138,982 at sea with 2,643
ends). With it goes a half-degree land mask made from `dist/assets/land.png` (Natural
Earth, public domain) and Kaplan and DeMaria's inland decay (*J. Appl. Meteor.* 34,
2499-2512, 1995). Again only grids ship, with the archive's SHA-256.
`records/typhoon-hindcast.json` is how it scored on the storms of 2015 onward, built from
1980-2014 only.

- Source: https://www.ncei.noaa.gov/products/international-best-track-archive
- File used: `ibtracs.since1980.list.v04r01.csv` (137 MB, not bundled)
- Knapp, K. R., M. C. Kruk, D. H. Levinson, H. J. Diamond, and C. J. Neumann, 2010:
  The International Best Track Archive for Climate Stewardship (IBTrACS).
  *Bull. Amer. Meteor. Soc.*, 91, 363-376.

## Japan Meteorological Agency — typhoon forecasts

`dist/data/jma-typhoon.json` holds the agency's typhoon analyses and forecasts (centre,
central pressure, maximum wind and forecast circle out to five days) as issued when the
bundled observations end, read by `scripts/fetch-jma-typhoon.cjs` from its
disaster-information XML (気象防災情報XML, 「台風解析・予報情報」). The publishing workflow
fetches it when the observations change and commits it with them. The page moves each
typhoon the agency has a forecast for along it, joining the forecast centres smoothly in
time, until the forecast ends, and says so: 「出典：気象庁「台風解析・予報情報」を加工して
作成」. Storms the agency does not forecast are not moved. The page is not the agency's
and does not present itself as its forecast service.

- Source: 気象庁 気象防災情報XML, https://xml.kishou.go.jp/ (feed
  https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml).
- Terms: 気象庁ホームページについて（著作権・リンク・個人情報保護）,
  https://www.jma.go.jp/jma/kishou/info/coment.html — reuse with the source named, and
  processed data marked as processed. Checked against the page on 2026-09-26 only as far
  as quoted here; confirm before any use beyond this page.

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
