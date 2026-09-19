# MyAtras — 青い地球と雲の流れ

単体HTMLは `python scripts/export-html.py` で生成できます。生成した `dist/myatras-clouds.html` をChromeなどで開くと、SSECの異なる観測時刻の雲を自動で連続再生します。地球の回転を止めたままでも雲が変化します。取得済みの実観測を同梱し、ネット接続なしでも再生できます。

## Default: actual observed cloud flow

24 distinct infrared observations three hours apart, from 2026-09-16 06:00 UTC to 2026-09-19 03:00 UTC - three days - are played in order. They were fetched with `node scripts/fetch-observations.cjs --span 72 --frames 24 --every 180 --winds` and committed as the bundled set, the same size as the day of hourly observations before them; earlier bundled sets are in the history. Each downloaded frame was verified against the SSEC response `RE-Time` header, and the timestamp shown changes with the actual frame. Images/logos are retained. No translation of a fixed image or globe rotation is used to fake the cloud movement. The loop pauses briefly at the last frame then restarts, and supports pause, speed selection and individual observation-time selection. 「読み込む観測の数」 chooses how many observations a refresh through 「最新を取得」 plays - 24, a day, or 12 for a lighter load. SSEC lists the last 24 hours, an hour apart, so 24 is the most a refresh can meet. A choice is met only by times the server actually listed; nothing is invented to fill it, and what was fetched is what plays. New available data can be fetched; playback reuses cached frames. Infrared observations are grayscale and include cold surface signatures, not only clouds. This does not reproduce Miraikan’s full-color composite processing.

Consecutive observations - each one hour after the last - dissolve into one another instead of being swapped in a single frame, so the sequence reads as weather moving rather than as a flicker. Both frames on screen during a dissolve are real observations: the brightness threshold is applied to each of them separately and only the drawn cloud layers are mixed, so no interpolated brightness is ever passed through the cloud threshold and shown as if it had been observed. Only a step to the next hour dissolves: starting over from the newest observation to the oldest is a twelve-hour jump, and a chosen time or a refresh is not a continuation either, so those appear at once. The timestamp names the observation being faded to, the dissolve is capped at 380 ms and always ends before the next observation arrives, and 「観測の切り替わりをなめらかに」 turns it off.

The default now composites white clouds over the blue ground reference texture. An uncalibrated smooth brightness threshold (0.38–0.82) controls opacity; it is a display approximation, not a validated cloud mask. Cold land can be included and warm low clouds can be missed. The reference map is cloud-free, so every cloud on the globe comes from an observation; its snow and ice stay fixed. The checkbox restores the original grayscale observation. Source image files are unchanged, and the watermark region is preserved in the shader. This is not the same processing used by Miraikan.

`python scripts/export-inline-earth.py` produces a compact offline conversation preview at `/workspace/blue-earth.html`, with 13 downsampled observations, drag rotation, time scrubber and playback. It uses the same Earth shader, makes no network calls and does not publish the site.

An optional **立体の模型** mode preserves the numerical-wind-driven 3D model described below. It is deliberately separate from actual observed cloud evolution.

## Numerical data, not an animated cloud image

- Source: SSEC RealEarth, UW-Madison. Products: `AMV-LLlow` (800–950 hPa), `AMV-LLmid` (600–799 hPa).
- Downloaded GeoJSON contains point locations plus `SPD` (knots), `DIR` (meteorological wind FROM direction), `PRE` (hPa), `DAY` and `TIME`.
- Only points whose **actual DAY/TIME** exactly match the selected product time are used. Old observations mixed into the API response are discarded, not relabeled as current.
- One observed vector nearest the center of each 2° cell is selected separately per pressure band. These are representative tracers, not a cloud-cover map.
- Bundled time: 2026-09-17 15:00 UTC / 2026-09-18 00:00 JST, the middle of the bundled observations. 3,013 representative vectors from 25,120 matching observations (2,125 low, 888 mid); 15,400 old observations excluded. The Unity model also has the observed wind at every bundled observation's own time, as one-degree images in `dist/data/wind/` (`scripts/wind-grid.cjs`): within 2.5 degrees of an observed vector the vectors there, further out spread from within 9 degrees by a 3-degree Gaussian, and the blue channel says how much observed wind is behind each texel.
- Dataset coverage is uneven. A lack of model clouds does not mean clear sky.

## Motion and 3D rendering

Wind components: `u = -SPD × (1852/3600) × sin(DIR)` and `v = -SPD × (1852/3600) × cos(DIR)` in m/s. Each tracer is advected on a sphere using its observed constant east/north components (rhumb-line integration), for a bounded 0–3 simulated hours. The globe is initially stationary so cloud motion is distinguishable from globe rotation.

Altitude is estimated from pressure under a standard-atmosphere approximation. Default display height is exaggerated 25×, adjustable 1–60×. Model clouds are tangent-oriented 3D ellipsoidal density volumes ray-marched in GLSL, with Earth occlusion and volumetric opacity. No satellite image or frame sequence drives the 3D cloud model. The older satellite observation image mode is retained separately.

**Limits:** cloud size, thickness, shape and amount are procedural visual models, not measured cloud volume. No humidity, water content, condensation, precipitation, convection or dynamically evolving pressure/temperature field is solved. This is observed-wind advection of representative 3D cloud tracers, not a weather forecast or a complete atmospheric simulation.

## Controls

- Pause/resume, return to initial positions, 0–3 hour scrubber.
- 1, 5 or 10 simulated minutes per real second.
- Pressure-band selection and height exaggeration.
- Drag/pinch globe navigation, optional globe rotation.
- Manual numerical-data refresh with timeout, validation and retention of prior data on failure.

## Data provenance and terms

- Source: SSEC RealEarth, UW-Madison
- https://www.ssec.wisc.edu/realearth/terms-of-use/
- https://realearth.ssec.wisc.edu/doc/api.php
- https://tropic.ssec.wisc.edu/misc/winds/info.html
- https://realearth.ssec.wisc.edu/api/shapes?products=AMV-LLlow_20260916_190000
- https://realearth.ssec.wisc.edu/api/shapes?products=AMV-LLmid_20260916_190000
- Ground reference texture: NASA Blue Marble, https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57752/land_shallow_topo_2048.jpg (cloud-free; NASA still images are not copyrighted in the US)

## Development and validation

- `dist/data-sources.js` reads the bundled observations: the served tree fetches `weather/snapshot.json`, `weather/sequence/manifest.json` and `data/amv.json`, while the standalone export uses the copies inlined into the page. Both builds show the same frames.
- `node scripts/fetch-observations.cjs` replaces the bundled observations with the newest ones SSEC serves. `--frames N` sets how many, `--every M` keeps one every M minutes, and the run reports the spacing SSEC is publishing at so the cadence on offer is visible before choosing. A frame is about 200 KB and the page loads all of them before playback starts, so more frames means a longer wait on a phone. It stores: the hourly frames playback cycles through, both opening snapshots, and with `--wind` the observed wind through `build-amv.cjs`. Every frame is checked against the `RE-Time` header the image comes back with, so a frame is only ever stored under the time the server itself confirms; a mismatch, or a missing header, stops the run before any manifest claims otherwise. Frames an earlier run left behind are removed. Run it where SSEC is reachable, then commit `dist/weather/`.
- `node scripts/build-amv.cjs TIME LOW_GEOJSON MID_GEOJSON` validates and samples downloaded observations.
- `python scripts/export-html.py` regenerates the standalone file.
- `node tests/cloud-model.test.cjs` checks wind units/direction, pressure altitude, spherical advection, longitude wrapping, timestamps, stale/malformed records and finite 3-hour positions of all bundled vectors.
- `node tests/weather.test.cjs` covers observation loading and failure retention.
- `node tests/weather-playback.test.cjs` verifies changing frames/timestamps, looping, pausing, cache reuse and reference-mode guards.
- `node scripts/build-motion.cjs` measures how the cloud pattern moved between each pair of consecutive bundled observations, from the observations alone (no network), into `dist/data/motion/`: 8-degree blocks every 3 degrees within 66 degrees of the equator, the shift up to 650 km that best carries the earlier observation's drawn clouds onto the later one's, with confidence from how much cloud there is to match and how clearly the best shift stands out; outliers replaced by their neighbours' median and the field smoothed by confidence. Each field records the SHA-256 of the two observations it was measured from. The publish workflow rebuilds it whenever it fetches observations.
- `node tests/build-motion.test.cjs` recovers a known motion from synthetic frames, returns a pattern that did not move as zero with confidence, gives clear sky no confidence, measures motion across the antimeridian, and holds the bundled fields to the bundled observations.
- `node tests/fetch-observations.test.cjs` drives the fetch script against a stand-in for the API: what it stores, what it records, the removal of earlier frames, and the refusal to store an observation whose time the server does not confirm.
- `node tests/observation-fade.test.cjs` covers the dissolve between observations: the first observation appearing at once, the timing, restarting on each observation, the toggle, and the cap that keeps a dissolve inside one playback step.
- `node tests/cloud-simulation.test.cjs` covers the model's playback clock: the rate, the 0.1 s cap that stops a background tab fast-forwarding it, pausing, returning to the start, the three-hour bound and the pressure-band filter.
- `python scripts/export-html.py` re-checks every bundled frame against the SHA-256 in its manifest and fails the build on a mismatch.
- Earth and cloud GLSL shaders compile and link in Chrome (headless, SwiftShader); the composite view, the grayscale view, the bundled playback, the 3-D model mode and the standalone export opened from file:// were each rendered and checked.
- `node tools/check-webgl.cjs` serves `dist/` and drives headless Chromium at an Android viewport: it checks that a WebGL context is granted, the globe finishes loading, the stored observations advance and nothing throws, and it decodes the frames it captures (`tools/png.cjs`, on node's own zlib) to check that the globe was actually drawn, that the picture changes when the observation does, and that a touch drag rotates it. A build whose page loads but renders nothing fails here. `--shots` writes screenshots to `.check-shots/`, `--unity` checks `dist/unity/` instead, `--desktop` uses a desktop viewport, and `--url` opens a published page where it lives, so the host's own headers are part of what is checked. It needs no npm packages — any Chromium will do. Requests to the live observation API are reported but do not fail the run, since the site is meant to keep the stored observations on screen when a fetch fails.
- QA on a real Android device and a live network refresh have not been performed. Touch drag and pinch were exercised only through emulated touch events in headless Chromium.

## Published site

`.github/workflows/pages.yml` publishes `dist/` to GitHub Pages at
https://ryo-tanohata.github.io/MyAtras/ on every push to `main`. Each publish runs the
test suites, rebuilds the standalone export, opens the site in headless Chromium, and
only then deploys.

Observations are refreshed only when the workflow is started by hand, with `fetch`,
`frames` and `every` - a GitHub runner can reach SSEC, which the agent containers and
a phone cannot. The fetch is best effort: if SSEC cannot be reached, or serves an
observation under a time it will not confirm, the bundled observations are published
instead and the run says so. `commit` makes the fetched set the bundled one, which is
how a refresh outlives its run; without it the download is published but not kept.
`records/published-observations.json` records what was published either way, with the
SHA-256 and source URL of each frame. A Unity WebGL build of the same globe is
published from `dist/unity/` at https://ryo-tanohata.github.io/MyAtras/unity/ . It adds
what the JavaScript globe does not have: sunlight from where the sun actually was at
each observation's time, NASA Black Marble city lights on the night side, an
atmosphere calculated by single Rayleigh and Mie scattering of that sunlight, the real stars of the Bright
Star Catalogue behind the Earth as they stood at that time, and cloud relief and
shadows from a relative height estimated from infrared brightness (for effect), and
flow lines along the observed wind of the bundled AMV data; see
`unity/README.md` for how it is built and checked.

## Local browser preview

Run `python -m http.server 8000 --directory dist` and open http://localhost:8000 . No API key is required. This repository contains the source and observation assets; generated standalone HTML exports are excluded and can be rebuilt with the export script. Pillow is needed only for `scripts/export-inline-earth.py` (`python -m pip install Pillow`). This is an unofficial project inspired by Miraikan, not an official Miraikan or SSEC product.
