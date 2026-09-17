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
