# MyAtras — 青い地球と雲の流れ

単体HTMLは `python scripts/export-html.py` で生成できます。生成した `dist/myatras-clouds.html` をChromeなどで開くと、SSECの異なる観測時刻の雲を自動で連続再生します。地球の回転を止めたままでも雲が変化します。取得済みの実観測を同梱し、ネット接続なしでも再生できます。

## Default: actual observed cloud flow

13 distinct hourly infrared observations from 2026-09-16 09:00–21:00 UTC (12 hours) are played in order. Each downloaded frame was verified against the SSEC response `RE-Time` header, and the timestamp shown changes with the actual frame. Images/logos are retained. No translation of a fixed image or globe rotation is used to fake the cloud movement. The loop pauses briefly at the last frame then restarts, and supports pause, speed selection and individual observation-time selection. New available data can be fetched; playback reuses cached frames. Infrared observations are grayscale and include cold surface signatures, not only clouds. This does not reproduce Miraikan’s full-color composite processing.

Consecutive observations dissolve into one another instead of being swapped in a single frame, so the sequence reads as weather moving rather than as a flicker. Both frames on screen during a dissolve are real observations: the brightness threshold is applied to each of them separately and only the drawn cloud layers are mixed, so no interpolated brightness is ever passed through the cloud threshold and shown as if it had been observed. The timestamp names the observation being faded to, the dissolve is capped at 380 ms and always ends before the next observation arrives, and 「観測の切り替わりをなめらかに」 turns it off.

The default now composites white clouds over the blue ground reference texture. An uncalibrated smooth brightness threshold (0.38–0.82) controls opacity; it is a display approximation, not a validated cloud mask. Cold land can be included and warm low clouds can be missed. The reference map is cloud-free, so every cloud on the globe comes from an observation; its snow and ice stay fixed. The checkbox restores the original grayscale observation. Source image files are unchanged, and the watermark region is preserved in the shader. This is not the same processing used by Miraikan.

`python scripts/export-inline-earth.py` produces a compact offline conversation preview at `/workspace/blue-earth.html`, with 13 downsampled observations, drag rotation, time scrubber and playback. It uses the same Earth shader, makes no network calls and does not publish the site.

An optional **立体の模型** mode preserves the numerical-wind-driven 3D model described below. It is deliberately separate from actual observed cloud evolution.

## Numerical data, not an animated cloud image

- Source: SSEC RealEarth, UW-Madison. Products: `AMV-LLlow` (800–950 hPa), `AMV-LLmid` (600–799 hPa).
- Downloaded GeoJSON contains point locations plus `SPD` (knots), `DIR` (meteorological wind FROM direction), `PRE` (hPa), `DAY` and `TIME`.
- Only points whose **actual DAY/TIME** exactly match the selected product time are used. Old observations mixed into the API response are discarded, not relabeled as current.
- One observed vector nearest the center of each 2° cell is selected separately per pressure band. These are representative tracers, not a cloud-cover map.
- Bundled time: 2026-09-16 19:00 UTC / 2026-09-17 04:00 JST. 3,333 representative vectors from 26,858 matching observations; 12,139 old observations excluded.
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
- `node scripts/build-amv.cjs TIME LOW_GEOJSON MID_GEOJSON` validates and samples downloaded observations.
- `python scripts/export-html.py` regenerates the standalone file.
- `node tests/cloud-model.test.cjs` checks wind units/direction, pressure altitude, spherical advection, longitude wrapping, timestamps, stale/malformed records and finite 3-hour positions of all bundled vectors.
- `node tests/weather.test.cjs` covers observation loading and failure retention.
- `node tests/weather-playback.test.cjs` verifies changing frames/timestamps, looping, pausing, cache reuse and reference-mode guards.
- `node tests/observation-fade.test.cjs` covers the dissolve between observations: the first observation appearing at once, the timing, restarting on each observation, the toggle, and the cap that keeps a dissolve inside one playback step.
- `node tests/cloud-simulation.test.cjs` covers the model's playback clock: the rate, the 0.1 s cap that stops a background tab fast-forwarding it, pausing, returning to the start, the three-hour bound and the pressure-band filter.
- `python scripts/export-html.py` re-checks every bundled frame against the SHA-256 in its manifest and fails the build on a mismatch.
- Earth and cloud GLSL shaders compile and link in Chrome (headless, SwiftShader); the composite view, the grayscale view, the 13-frame playback, the 3-D model mode and the standalone export opened from file:// were each rendered and checked.
- `node tools/check-webgl.cjs` serves `dist/` and drives headless Chromium at an Android viewport: it checks that a WebGL context is granted, the globe finishes loading, the stored observations advance and nothing throws, and it decodes the frames it captures (`tools/png.cjs`, on node's own zlib) to check that the globe was actually drawn, that the picture changes when the observation does, and that a touch drag rotates it. A build whose page loads but renders nothing fails here. `--shots` writes screenshots to `.check-shots/`, `--unity` checks `dist/unity/` instead, `--desktop` uses a desktop viewport, and `--url` opens a published page where it lives, so the host's own headers are part of what is checked. It needs no npm packages — any Chromium will do. Requests to the live observation API are reported but do not fail the run, since the site is meant to keep the stored observations on screen when a fetch fails.
- QA on a real Android device and a live network refresh have not been performed. Touch drag and pinch were exercised only through emulated touch events in headless Chromium.

## Published site

`.github/workflows/pages.yml` runs the three test suites, rebuilds the standalone
export and publishes `dist/` to GitHub Pages on every push to `main`:
https://ryo-tanohata.github.io/MyAtras/ . A Unity WebGL build of the same globe is
published from `dist/unity/` at https://ryo-tanohata.github.io/MyAtras/unity/ ; see
`unity/README.md` for how it is built and checked.

## Local browser preview

Run `python -m http.server 8000 --directory dist` and open http://localhost:8000 . No API key is required. This repository contains the source and observation assets; generated standalone HTML exports are excluded and can be rebuilt with the export script. Pillow is needed only for `scripts/export-inline-earth.py` (`python -m pip install Pillow`). This is an unofficial project inspired by Miraikan, not an official Miraikan or SSEC product.
