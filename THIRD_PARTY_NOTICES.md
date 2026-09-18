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
| `dist/weather/sequence/globalir_20260916_*.png` | `globalir` | 2026-09-16 09:00 – 21:00, hourly (13 frames) |
| `dist/weather/snapshot/globalir_20260916_170000.png` | `globalir` | 2026-09-16 17:00 |
| `dist/weather/snapshot/globalvis_20260916_170000.png` | `globalvis` | 2026-09-16 17:00 |

The image files are stored exactly as the API returned them. Each one records the
request it came from and its SHA-256 in `dist/weather/sequence/manifest.json` or
`dist/weather/snapshot.json`, and the export re-checks those digests. The SSEC
watermark and logo are kept in the files and are drawn, not painted over, by the
globe shader. The white cloud layer shown by default is a display composite
computed in the shader at draw time; it never alters the stored image.

### Atmospheric motion vectors

`dist/data/amv.json` holds 3,333 representative vectors selected from the
`AMV-LLlow` and `AMV-LLmid` products at 2026-09-16 19:00 UTC, with the selection
counts recorded alongside them. Source responses:

- https://realearth.ssec.wisc.edu/api/shapes?products=AMV-LLlow_20260916_190000
- https://realearth.ssec.wisc.edu/api/shapes?products=AMV-LLmid_20260916_190000

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
