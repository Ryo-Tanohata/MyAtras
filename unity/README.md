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
  Assets/Scripts/GlobeView.cs               full-screen pass, drag / pinch / wheel, the page's controls
  Assets/Scripts/ObservationLoader.cs       reads dist/assets and dist/weather next to the build
  Assets/Scripts/ObservationPlayback.cs     which observation is up, and the dissolve into it
  Assets/WebGLTemplates/MyAtras/index.html  the JavaScript site's page around the canvas
  Assets/Plugins/WebGL/MyAtrasBridge.jslib  hands the globe's state to that page
  Assets/Plugins/WebGL/MyAtrasTransparency.jslib  lets the page show through the canvas
  Assets/Editor/WebGlBuild.cs               applies the player settings, generates the scene, builds
```

`WebGlBuild` generates `Assets/Scenes/Main.unity` on every build, so no hand-written
scene has to be kept in step with the editor version; the generated scene is ignored by
git.

`ProjectSettings/` is committed as Unity wrote it on the first open with
**6000.4.8f1**, the version the author's other Unity WebGL project ships from; the build
script sets the values that matter on every build anyway. It has
to exist before CI can build, because game-ci reads the editor version from that file
in the checked-out project and ignores the workflow's `unityVersion` input
(`src/build-args.ts` and `src/resolve-project-path.ts` in game-ci/unity-builder).
Whether game-ci publishes an editor image for that exact version is still unverified —
the other project builds locally, not in CI.

## Build

Open `unity/MyAtras` in Unity Hub with **6000.4.8f1** (the pinned version), Web (WebGL)
build support installed, then either:

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
| Strip Engine Code | On | Keeps the download down |
| Splash Screen | Off | Nothing should sit between the viewer and the globe |

It also registers `MyAtras/EarthComposite` in **Always Included Shaders** before
building. Nothing references that shader through a material asset — the scene is
generated and the material is created at runtime — so the build would strip it,
`Shader.Find` would return null in the browser, and the page would come up empty while
the editor still looked fine.

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
- Sits inside the JavaScript site's own page. See "The page around the canvas" below.

Built with 6000.4.8f1 on Windows on 2026-09-18 — 0 errors, 0 warnings, about 4 MB —
and checked with `node tools/check-webgl.cjs --unity` at an Android viewport: the globe
is drawn (2163 distinct colours in the globe region), a touch drag rotates it (18.7% of
pixels change), the console is clean and every file is served. The frame matches the
JavaScript globe: same orientation, same 21:00 UTC observation, same cloud placement.

Two differences from the WebGL version surfaced in that first render and are fixed.
Unity gives downloaded textures mipmaps, and at the antimeridian `atan2` jumps from +π to
−π, so the sampler chose the smallest mip there and drew a thin line down the globe;
both textures are now sampled at full resolution with `tex2Dlod`, as the WebGL version
samples textures that have no mipmaps. And the credits ran off the bottom of a phone
screen until the overlay measured its wrapped height.

The small dark cap at the north pole is not a port artefact: the JavaScript globe shows
the same colour there. North of 85.05° there is no observation, so the cloud-free
reference shows dark Arctic ocean, while cold surface just inside the limit comes
through the brightness threshold as white.

Playback of all thirteen stored observations follows the JavaScript version's timing
(`ObservationPlayback.cs`): one observation every 0.65 s, the newest held twice as long,
and a dissolve of 0.12-0.38 s between an observation and the one an hour after it. Each
observation goes through the brightness threshold on its own and only the drawn layers
are mixed, so nothing in between two observed times is ever shown as observed. Starting
over from the newest to the oldest is a twelve-hour jump and is not dissolved. If an
observation fails to load, playback stops at the gap rather than skipping it, and the
page says how many of the thirteen could be loaded.

Not yet ported: the visible-light product, the grayscale observation toggle, the
day/night mode, the wind model and fetching the latest observations. The page says so
and links to the JavaScript version for them, rather than showing buttons that do
nothing.

## Sunlight at the observation's own time

This is where the Unity build goes past the JavaScript one. The JavaScript globe's
"昼と夜" mode lights it from a fixed direction for effect; the Unity globe is lit by the
sun where it actually was at each observation's time, so across the twelve hours the
terminator sweeps about 180 degrees while the clouds move.

- `SolarPosition.cs` gives the subsolar point from the UTC time, with the Astronomical
  Almanac's low-precision formulas for the sun and Greenwich mean sidereal time (about
  0.01 degree, 1950-2050). NOAA's fractional-year series was compared and not used: it
  agrees on longitude within 0.03 degree but is off by about 0.4 degree of declination
  near the equinoxes, which is where the bundled observations sit.
- `Assets/Editor/SolarPositionCheck.cs` checks it and exits 1 on failure: the 2026 March
  and September equinoxes (declination 0.002 and 0.003) and June solstice (23.435), the
  thirteen observation times against the same formulas evaluated in Python, and the
  direction vector against the frame the shader samples in. Run it with
  `-executeMethod MyAtras.SolarPositionCheck.Run`.
- The shader compares each point with that direction. The day side is drawn exactly as
  before. Across a soft band of about 6 degrees of solar elevation the night side takes
  over: the ground falls to 5%, cloud stays faintly visible because infrared observes it
  by night as by day, and towns from NASA's Black Marble 2016 glow where no cloud covers
  them. The SSEC logo corner stays readable on both sides.
- During a dissolve the sun moves with the time between the two observations. The
  sunlight at each of those instants is real astronomy rather than an invented
  observation, and it spares the terminator a fifteen-degree jump at every step.
- The page names the subsolar point of the observation on screen and says that the
  city lights are a fixed 2016 image, not a current observation. "観測時刻の昼と夜" turns
  it off.

The same sunlight is scattered by a calculated atmosphere: single scattering by
Rayleigh (molecules) and Mie (haze), marched along each line of sight and towards the
sun from each step, after Nishita et al., with the standard sea-level coefficients
(Rayleigh 5.8, 13.5 and 33.1 per million metres for red, green and blue; Mie 21, g
0.76) and scale heights of 8 and 1.2 km. No colour is chosen by hand. The real
atmosphere would be a few pixels at the limb on a phone, so it is drawn six times as
thick and one sixth as dense, which keeps the optical depth straight up - the colour
of the sky and of sunlight at the ground - as it is; paths along the limb come out
somewhat thinner than real. Multiple scattering is left out. The page says all of
this.

What comes out: measured around the limb at 09:00 UTC, the sunlit side glows blue and
the night side not at all, since the Earth's shadow is part of the calculation; up the
limb the layers run from white haze at the bottom to blue above, warmer at the bottom
where the terminator meets the limb. Sunlight reaching the ground is reddened on its
long path near the terminator, so clouds there take the colour of sunset. With the sun
directly behind the Earth, as at midnight in Japan, the limb is an orange ring with blue
outside it, as photographs of the night side from orbit show. This replaced an earlier
atmosphere painted for effect.

Two things were corrected on the way. A line of sight grazing the limb passes through
so much air that eight steps along it missed the bright layer, and the last ring of
pixels came out darker than the air on both sides, as a dotted line; within a few
pixels of the edge it now takes the brighter of itself and the air just beyond. And the
air's reddening was applied to the night side too, turning its faint display-only cloud
brown; there it now only dims, evenly.

The night side keeps its towns and its coastlines. Towns are a point of light plus light
spilling into the air around them - Black Marble a few mip levels down - which passes
partly through cloud and lights its underside, the way cloud over a city glows in
photographs from orbit. The spill begins above Black Marble's faint moonlit-land tone
(the Sahara reads about 0.17): starting lower lit the whole of inland Australia as if
it were town light. Darkening the night side to 5% also left no way to tell land from
sea where there were no towns, so `scripts/build-land.py` draws Natural Earth's 1:50m
land and coastline into `dist/assets/land.png`, and at night the sea stays nearly
black, land is lifted a little, and a thin pale coastline shows the edges, faintly even
under cloud. It is an aid, not an observation, and the page says so.

Flow lines show the observed wind: SSEC's atmospheric motion vectors in the same
`dist/data/amv.json` the JavaScript version's wind model reads, both pressure bands.
`WindField.cs` turns the 3,333 vectors into a one-degree texture, each texel taking only
the vectors within 2.5 degrees of arc, weighted towards the nearest, and left empty
where there are none - a gap in the observations is not calm air and is not filled in.
`Assets/Editor/WindFieldCheck.cs` checks it on vectors with known answers: the texel on a
vector carries it, a vector reaches across the antimeridian, nothing appears beyond the
reach, and south is south. The shader draws one short dash per 3-degree cell moving
along the wind there, on the same clock as the cloud playback, so a line moves as far as
the clouds do between two observations. The page says what they are: the direction and
speed of wind observed at one time only (04:00 JST on 2026-09-17), not the wind at each
played hour, drawn only near observations, and a way of drawing wind rather than
particles of cloud. Over the western Pacific they circle the large cloud system and run
along the frontal band east of Japan.

Behind the globe are real stars, not a pattern. `scripts/build-stars.py` draws every
star of the Bright Star Catalogue down to magnitude 6.0 at its J2000 position, with
brightness from its magnitude and colour from B-V, into a map of right ascension and
declination; the shader looks out along each background pixel's ray, turns it into the
Earth's frame with the same rotation as the globe and into right ascension with
Greenwich sidereal time, so the sky stands as it stood at the observation's time and
moves with a drag. Sidereal time is checked against Meeus's worked examples 12.a and
12.b (to 0.02 arcsecond). The whole chain was checked end to end on a paused frame at
09:00 UTC: the pixel positions of the bright stars behind the Earth were computed
independently in Python from the catalogue, the time and the view, and all eight -
Aldebaran, Elnath, Canopus, Alhena, Aludra, Procyon, Naos and Gamma Velorum - were
found lit at their predicted pixels, while a mirrored sky matched none of five.
Precession since 2000, about 0.36 degree, is not applied. Brightness is adjusted for
the screen, and the page says both.

Clouds are given relief and shadows from a relative height. In infrared a colder cloud
top shows brighter and stands higher, so brightness ranks cloud tops against each
other; these are processed greyscale images with no temperature scale, so it is only a
ranking, exaggerated tenfold to be seen at all, and the page says so. Where a cloud top
falls away towards the sun it faces the sun and is lit; where it rises towards the sun
it is turned away - strongest with the sun low. The ground is darkened by the cloud
that lies towards the sun as far as a cloud top at about two thirds of the exaggerated
height would cast at that elevation: long near the terminator, short around noon. The
first version took the slope a quarter of an observation pixel either side, which only
traced the pixel grid and creased the clouds like paper; it is now taken a whole pixel
either side, and weaker.

The first observation, 09:00 UTC, is 18:00 in Japan, just after sunset there: the
terminator falls just east of Japan, 90 degrees from the subsolar point at 43.7°E. At
15:00 UTC, midnight in Japan, the whole visible hemisphere is dark and the lights of
Japan, Korea, eastern China and eastern Australia show between the clouds.

## Keeping it smooth on phones

Every layer added cost. On this PC's Intel Iris Xe, with a phone-sized canvas, the
Unity page drew 363 frames a second against the JavaScript page's 1,045 - plenty
here, but a phone GPU is several times slower, and the page stuttered on one. Three
changes, measured with Chrome's software renderer standing in for a slow GPU:

- The air's optical depth towards the sun is looked up in a table built once at
  start-up (`AirDepthTable.cs`, laid out as Bruneton and Neyret do) instead of marched
  in four steps inside each of the eight steps along every line of sight. The table is
  also closer to the exact integral: `Assets/Editor/AirDepthCheck.cs` compares it with a
  4,000-step integration at 400 points, and it is within 0.012 in transmittance where
  the old march was out by up to 0.09 (Mie 0.014 against 0.18). A closed-form Chapman
  approximation was tried first and rejected: 12 to 24% out in optical depth at this
  thickened atmosphere.
- The state the page reads was built and serialised to JSON every frame and thrown
  away. It is now only built when one of a few numbers changes, so a frame allocates
  nothing; garbage is what makes the collector stop a page on a phone.
- The globe measures its own frame time and, below about 45 frames a second, draws at
  fewer pixels - in steps down to half the screen's resolution - and scales up; with
  room to spare it climbs back. The page shows the resolution in use.

On the software renderer the median frame went from 118.6 ms to 40.1 ms, and frames
over 50 ms from 82 of 84 to 34 of 237; it settled at 50%. On the real GPU it stays at
100% and the picture is unchanged.

## The page around the canvas

The Unity build uses its own WebGL template, `Assets/WebGLTemplates/MyAtras`, which is
the JavaScript site's page: the same header, headings, buttons, notes, footer and
wording, and the same stylesheet, loaded from `../style.css` beside the build. Unity
draws the globe and nothing else. Every word the viewer reads is HTML, so Japanese
comes from the browser's fonts and the build carries no font of its own.

The two talk in both directions:

- Page to Unity: the controls call `SendMessage` on the object named `Globe`
  (`GlobeView.ObjectName`): `SetPlaying`, `SetDissolve`, `SetIntervalMs`,
  `ShowObservation`, `ZoomBy`, `ResetView`.
- Unity to page: `GlobeView` sends its state as JSON through `MyAtrasBridge.jslib` to
  `window.myatrasReport` whenever it changes - loading progress, the observation on the
  globe and its stamp, all loaded stamps, playing, dissolve, any error. The page formats
  the stamp in Japan time with the JavaScript version's own `Intl.DateTimeFormat` and
  words the playback line as that version does.

Around the globe the canvas is transparent, so the page's radial background continues
behind it as it does around the JavaScript globe. Unity creates its context with the
same attributes the JavaScript globe asks for - alpha on, premultipliedAlpha off - but
clears the alpha channel alone back to 1 at the end of every frame, which made the
canvas opaque and filled it with the halo colour. `MyAtrasTransparency.jslib` skips
exactly that clear. Measured beside the globe, the Unity page now matches the
JavaScript one within a few levels (7,12,19 against 7,12,18), and the browser check
fails if the canvas turns opaque again.

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
