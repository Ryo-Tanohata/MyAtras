# Unity WebGL build

The Unity version is delivered the same way as the JavaScript globe: as files in
`dist/`, served by GitHub Pages. Its build output goes to `dist/unity/`, so it is
reachable at `https://ryo-tanohata.github.io/MyAtras/unity/` and can be checked on
an Android phone by opening that address — no install step.

Unity 6 renames the build target to **Web** in the editor UI; it is still WebGL
(`BuildTarget.WebGL`), and the page reports `WebGL 2.0 (OpenGL ES 3.0)` at runtime.

## What is in the project

```
unity/MyAtras/
  Packages/manifest.json                    only the modules the globe uses
  Assets/Shaders/EarthComposite.shader      the WebGL fragment shader, ported line for line
  Assets/Scripts/GlobeView.cs               full-screen pass, drag / pinch / wheel
  Assets/Scripts/ObservationLoader.cs       reads dist/assets and dist/weather next to the build
  Assets/Editor/WebGlBuild.cs               applies the player settings, generates the scene, builds
```

No scene asset and no `ProjectSettings/` are committed yet. Unity writes
`ProjectSettings/` itself the first time the project is opened, and `WebGlBuild`
generates `Assets/Scenes/Main.unity` on every build, so nothing hand-written has to be
kept in step with the editor version. Commit the generated `.meta` files and
`ProjectSettings/` after the first open; the generated scene is ignored by git.

`ProjectSettings/ProjectVersion.txt` in particular has to be committed before the CI
build can run: game-ci reads the editor version from that file in the checked-out
project and ignores the workflow's `unityVersion` input (`src/build-args.ts` and
`src/resolve-project-path.ts` in game-ci/unity-builder). Which version it names also
decides whether a matching editor image exists, so check that before relying on CI.

## Build

Open `unity/MyAtras` in Unity Hub with **Unity 6 LTS (6000.x)**, Web (WebGL) build
support installed, then either:

- editor: **MyAtras > Build Web (WebGL) to dist-unity**
- terminal:
  ```
  Unity -quit -batchmode -projectPath unity/MyAtras -executeMethod MyAtras.WebGlBuild.Build
  ```

Both write `dist/unity/`. Commit that directory: the agent containers used for this
repository have no Unity editor and no licence, so a build cannot be produced there —
committing the output is what lets any later session, and any phone, check the result.

`WebGlBuild` sets these itself, so they do not have to be clicked in:

| Setting | Value | Reason |
| --- | --- | --- |
| Color Space | **Gamma** | The shader is a line-for-line port; in linear space Unity would convert every texel on sampling and the 0.38–0.82 cloud threshold would no longer sit where the JavaScript version puts it |
| Compression Format | Gzip | Smaller download |
| Decompression Fallback | On | Pages sends no `Content-Encoding`; the loader inflates instead |
| Name Files As Hashes | On | Cache-safe file names across deploys |
| Graphics API | OpenGL ES 3.0 (WebGL 2.0) | What the compositing needs |
| Managed Stripping | High | Keeps the download down |

## Observation data

The Unity build fetches no observations of its own. It reads the same files the
JavaScript globe reads, so both versions can only ever show the same frames and the
SHA-256 manifest stays the single record of what was downloaded:

- `dist/weather/sequence/manifest.json` and its PNG frames
- `dist/assets/earth.jpg` (NASA Blue Marble, cloud-free)

They are read at `../weather/...` and `../assets/...` relative to `dist/unity/`, and
from `dist/` directly when playing in the editor. Nothing is copied into
`StreamingAssets` — a copy would be a second set of bytes to keep in step.

## What the current project does

- Draws the globe with the ported shader: ground reference, white cloud layer from the
  newest stored infrared observation, preserved SSEC watermark corner, the same
  Mercator lookup and the same ±85.05° limit.
- Drag to rotate, pinch to zoom, wheel to zoom, with the step sizes and limits from
  `dist/app.js`.
- Shows the observation time (UTC and JST) and the sources on screen.

Not yet ported: playback of all 13 observations, the grayscale observation toggle, the
day/night mode, the wind model, and a Japanese UI. The on-screen text is ASCII because
the built-in font has no CJK glyphs; Japanese labels need a font asset (Noto Sans JP
subset) added first.

## Building in CI

`.github/workflows/unity-build.yml` runs the same build with game-ci and then opens the
result in a browser. It is manual (`workflow_dispatch`) on purpose: it is the only
workflow here that needs Unity credentials, so it must never be reachable from a pull
request. It needs the secrets `UNITY_LICENSE` (the `.ulf` contents), `UNITY_EMAIL` and
`UNITY_PASSWORD`, and on a personal licence every run consumes an activation.

It uploads the build as a workflow artifact and does not commit it. Committing
`dist/unity/` stays a person's decision, so that whatever is published can be checked
out and opened again later, and so a broken workflow cannot take the published version
down with it. A Unity build also takes tens of minutes, against about twenty seconds
for the Pages deploy, which is why it is a separate workflow rather than a step in
`pages.yml`.

## Checking a build

```
node tools/check-webgl.cjs --unity          # start, WebGL context, canvas, touch, console
node tools/check-webgl.cjs --unity --shots  # also write PNGs to .check-shots/
```

The check serves `dist/unity/` locally and drives headless Chromium; it needs no npm
packages. On a phone, open the published URL above after the build is pushed.

## Scientific rules carried over from the JavaScript version

The constraints in `CLAUDE.md` apply here unchanged: the white cloud layer comes only
from observed infrared brightness (uncalibrated 0.38–0.82 threshold, which includes
cold land and misses warm low cloud), the wind model is a model and not a forecast,
interpolated frames between two observations must be marked as interpolation, source
watermarks and credits stay visible, and nothing generated may be presented as an
observation.
