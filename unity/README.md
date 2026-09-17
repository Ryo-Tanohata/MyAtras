# Unity WebGL build

The Unity version is delivered the same way as the JavaScript globe: as files in
`dist/`, served by GitHub Pages. Its build output lives in `dist/unity/`, so it is
reachable at `https://ryo-tanohata.github.io/MyAtras/unity/` and can be checked on
an Android phone by opening that address — no install step.

Unity 6 renames the build target to **Web** in the editor UI; it is still WebGL
(`BuildTarget.WebGL`), and the page reports `WebGL 2.0 (OpenGL ES 3.0)` at runtime.

## Why the build output is committed

No Unity editor and no Unity licence exist in the agent containers used for this
repository, so a build cannot be produced there. Committing the build output is what
lets any later session — and any phone — check the result. Build locally, commit the
output, push.

## Required player settings

GitHub Pages serves static files and does not add `Content-Encoding`, so the build
has to be able to inflate itself:

| Setting | Value | Reason |
| --- | --- | --- |
| Compression Format | Gzip | Smaller download than uncompressed |
| Decompression Fallback | **On** | Pages sends no `Content-Encoding`; the loader inflates instead |
| Name Files As Hashes | On | Cache-safe file names across deploys |
| Color Space | Linear | Matches the JavaScript globe's shading |
| Target Graphics API | WebGL 2.0 | The observation compositing needs it |

Build to `dist/unity/` (the whole folder is committed, `index.html` included).

## Observation data

The Unity build must not fetch observations of its own. It reads the same files the
JavaScript globe reads, so both versions always show identical frames and the
SHA-256 manifest stays the single source of truth:

- `dist/weather/sequence/manifest.json` and its PNG frames
- `dist/weather/snapshot.json`
- `dist/data/amv.json`

Reference them at runtime from `../weather/...` and `../data/...` relative to
`dist/unity/`, rather than copying them into `StreamingAssets` — a copy would be a
second set of bytes to keep in step with the manifest.

## Checking a build

```
node tools/check-webgl.cjs --unity          # start, WebGL context, canvas, touch, console
node tools/check-webgl.cjs --unity --shots  # also write PNGs to .check-shots/
```

The check serves `dist/unity/` locally and drives headless Chromium; it needs no npm
packages. On a phone, open the published URL above after the build is pushed.

## Scientific rules carried over from the JavaScript version

The constraints in `CLAUDE.md` apply to the Unity build unchanged: the white cloud
layer comes only from observed infrared brightness (0.38–0.82 threshold), the wind
model is labelled a model and not a forecast, interpolated frames between two
observations must be marked as interpolation, source watermarks and credits stay
visible, and nothing generated may be presented as an observation.
