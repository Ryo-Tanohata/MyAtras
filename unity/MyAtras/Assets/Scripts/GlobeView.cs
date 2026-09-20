using System;
using System.Collections;
using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace MyAtras
{
    /// <summary>
    /// Draws the globe and handles drag, pinch and wheel. The rotation limits and step
    /// sizes are the ones from dist/app.js, so the two versions feel the same.
    ///
    /// Everything is rendered by one full-screen pass, as in the WebGL version: there is
    /// no sphere mesh, the shader intersects the sphere analytically.
    ///
    /// In a browser the page around the canvas does all the talking. It draws the
    /// buttons, times, notes and credits in the JavaScript site's own markup and
    /// stylesheet, calls the public methods below through SendMessage, and hears back
    /// through <see cref="Report"/>. That keeps the two versions looking alike and means
    /// the Unity build carries no font. The page addresses this object by name, so the
    /// build script names it <see cref="ObjectName"/>.
    /// </summary>
    [RequireComponent(typeof(Camera))]
    public sealed class GlobeView : MonoBehaviour
    {
        public const string ObjectName = "Globe";

        const float DragSpeed = 0.006f;
        const float PitchLimit = 1.4f;
        const float ZoomMin = 0.65f;
        // Far enough in to fill the frame with one country; the observations are 512 px
        // for the whole globe, so past this the clouds are squares rather than clouds.
        const float ZoomMax = 8f;

        // The opening view: Japan whole, from Yonaguni to Wakkanai, with sea around it.
        // HomeYaw is the longitude at the middle of the screen in radians (136 degrees
        // east), HomePitch the latitude (35.5 north), and HomeZoom keeps the islands
        // inside the frame on a phone held upright as well as on a wide screen. The same
        // three numbers open dist/app.js, so both versions start on the same view.
        const float HomeYaw = 2.374f;
        const float HomePitch = 0.620f;
        const float HomeZoom = 5f;

        // The opening: the whole globe, one turn eastward, settling on Japan. The turn is
        // over by three quarters of the way through and the dive starts a little before
        // that, so what turns is the whole globe and the close view is the arrival;
        // turning while already zoomed in is a blur across the surface. The same shape as
        // dist/app.js, and like it the first touch of the globe ends it where it is.
        const float IntroSeconds = 11f;
        const float IntroZoom = 0.85f;
        const float IntroPitch = 0.22f;
        const float IntroTurnBy = 0.75f;
        const float IntroDiveFrom = 0.55f;
        const float Turn = 2f * Mathf.PI;

        // Transparent: the page's background shows through the canvas, as it does
        // around the JavaScript globe.
        static readonly Color Background = new Color(0f, 0f, 0f, 0f);

        float yaw = HomeYaw - Turn;
        float pitch = IntroPitch;
        float zoom = IntroZoom;
        // -1 until the flight begins, which is when the first observation is on the globe
        // so that it flies over clouds; after four seconds regardless, in case the
        // observations are slow. Done once it has landed or the viewer has taken over.
        float introStarted = -1f;
        bool introDone;

        Material material;
        ObservationLoader loader;
        ObservationPlayback playback;
        bool loaded;
        bool loadFinished;
        bool sunlight = true;
        bool stars = true;
        bool cloudRelief = true;
        bool flow = true;
        // The model between observations (ObservationPlayback, the shader's Pair): on unless
        // the page asks for the observations alone.
        bool model = true;
        Vector2 lastPointer;
        float lastPinchDistance;
        long lastReportKey = -1;
        // The storms found in the observations, and where storms have gone before. Both off
        // until the page asks: the marks are a second statement about the picture, and the
        // outlook is a third and weaker one.
        StormMarks stormMarks;
        bool stormsOn;
        bool outlookOn;
        // Automatic quality: the share of the screen's pixels the globe is drawn at.
        float renderScale = 1f;
        float frameTime = 1f / 60f;
        float nextQualityCheck;
        string[] stampArray;

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")]
        static extern void MyAtrasReport(string json);
#endif

        [Serializable]
        class State
        {
            public string state;     // "loading", "ready" or "error"
            public int loadedCount;  // observations loaded so far
            public int expected;     // observations the manifest lists
            public int index;        // the observation on the globe, oldest = 0
            public string time;      // its stamp, e.g. 20260916.210000; the page formats it
            public string[] times;   // every loaded stamp, for the page's time slider
            public bool playing;
            public bool dissolve;
            public bool model;       // clouds carried by the wind between observations
            public bool sunlight;    // day and night drawn from the sun at the observation time
            public bool nightLights; // the Black Marble texture loaded
            public bool stars;       // the star background drawn
            public bool starMap;     // the star map loaded
            public bool cloudRelief; // cloud relief and shadows drawn
            public bool landMap;     // the night-side land and coastline map loaded
            public bool flow;        // the flow lines drawn
            public string windTime;  // the wind's observation stamp; empty if it could not be read
            public bool windEachTime; // the wind is the observed wind at each observation's own time
            public bool motionMeasured; // clouds are carried by the motion measured between observations
            public bool seam;        // the loop's end is being overlaid on its start
            public int loopHours;    // hours in the model's loop; 0 if it cuts back to the start
            public int seamHours;    // hours over which the loop's end is handed over
            public int windTexels;   // one-degree texels with observed wind
            public float sunLat;     // subsolar point at the observation time, degrees
            public float sunLon;     // east positive
            public bool storms;      // the marks are switched on
            public bool outlook;     // and so is what past storms did next
            public bool stormFound;  // a storm was found in the observation on screen
            public float stormLat;   // where its centre was measured, degrees
            public float stormLon;   // east positive
            public bool stormLast;   // whether this is its last observation, the only place
                                     // the outlook may be drawn
            public bool outlookReady;
            public int renderPercent; // the resolution the globe is drawn at, % of the screen
            public string error;
        }

        void Awake()
        {
            Camera camera = GetComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = Background;
            camera.orthographic = true;

            Shader shader = Shader.Find("MyAtras/EarthComposite");
            if (shader == null)
            {
                Debug.LogError("MyAtras: the globe shader is missing from the build.");
                return;
            }
            material = new Material(shader) { hideFlags = HideFlags.HideAndDontSave };

            // The air's optical depth towards the sun, built once; see AirDepthTable.
            material.SetTexture("_AirDepth", AirDepthTable.Build());

            loader = new ObservationLoader();
            stormMarks = new StormMarks();
            StartCoroutine(LoadRoutine());
        }

        IEnumerator LoadRoutine()
        {
            yield return loader.Load();
            loadFinished = true;
            if (loader.Earth == null || loader.Frames.Count == 0)
            {
                Debug.LogError("MyAtras: " + loader.Error);
                Report();
                yield break;
            }
            // A gap part way through is reported but does not stop what did load from
            // being shown; the loader already stopped at the gap.
            if (loader.Error != null) Debug.LogWarning("MyAtras: " + loader.Error);

            material.SetTexture("_Earth", loader.Earth);
            if (loader.Night != null) material.SetTexture("_Night", loader.Night);
            material.SetFloat("_NightLights", loader.Night != null ? 1f : 0f);
            if (loader.Stars != null) material.SetTexture("_StarMap", loader.Stars);
            if (loader.Land != null) material.SetTexture("_Land", loader.Land);
            material.SetFloat("_LandOn", loader.Land != null ? 1f : 0f);
            material.SetVector("_Watermark", loader.Watermark);
            material.SetFloat("_WeatherActive", 1f);
            playback = new ObservationPlayback(loader.Times, Time.unscaledTime) { Model = model };
            loaded = true;
            // After the globe is up: nothing about a storm is worth delaying the picture the
            // observations are already drawing.
            yield return stormMarks.Load(ObservationLoader.SiteRoot());
        }

        void Update()
        {
            if (loaded) playback.Tick(Time.unscaledTime);
            AdjustQuality();
            Report();
            FlyIn();

            if (Input.touchCount >= 2)
            {
                EndIntro();
                Pinch(Input.GetTouch(0).position, Input.GetTouch(1).position,
                    Input.GetTouch(1).phase == TouchPhase.Began);
                return;
            }
            lastPinchDistance = 0f;

            if (Input.touchCount == 1)
            {
                Touch touch = Input.GetTouch(0);
                if (touch.phase == TouchPhase.Moved)
                {
                    EndIntro();
                    Rotate(touch.deltaPosition.x, -touch.deltaPosition.y);
                }
                return;
            }

            if (Input.GetMouseButtonDown(0)) { EndIntro(); lastPointer = Input.mousePosition; }
            if (Input.GetMouseButton(0))
            {
                Vector2 now = Input.mousePosition;
                Rotate(now.x - lastPointer.x, -(now.y - lastPointer.y));
                lastPointer = now;
            }

            float wheel = Input.mouseScrollDelta.y;
            if (!Mathf.Approximately(wheel, 0f)) { EndIntro(); SetZoom(zoom * Mathf.Exp(wheel * 0.1f)); }
        }

        /// <summary>The opening flight, one step of it per frame.</summary>
        void FlyIn()
        {
            if (introDone) return;
            if (introStarted < 0f)
            {
                if (!loaded && Time.unscaledTime < 4f) return;
                introStarted = Time.unscaledTime;
            }
            float k = Mathf.Clamp01((Time.unscaledTime - introStarted) / IntroSeconds);
            float turned = Smooth(k / IntroTurnBy);
            float closed = Smooth((k - IntroDiveFrom) / (1f - IntroDiveFrom));
            yaw = HomeYaw - Turn * (1f - turned);
            pitch = Mathf.Lerp(IntroPitch, HomePitch, closed);
            zoom = IntroZoom * Mathf.Pow(HomeZoom / IntroZoom, closed);
            if (k >= 1f) introDone = true;
        }

        static float Smooth(float x)
        {
            float c = Mathf.Clamp01(x);
            return c * c * (3f - 2f * c);
        }

        /// <summary>Leaves the globe where the flight had got to; it never runs again.</summary>
        void EndIntro()
        {
            introDone = true;
        }

        /// <summary>
        /// Keeps the globe smooth on slower phones. Once a second the recent frame time is
        /// looked at: below about 45 frames a second the globe is drawn at fewer pixels, in
        /// steps down to half the screen's resolution, and scaled up; with room to spare it
        /// climbs back. Smoothness is worth more on a moving globe than the last detail.
        /// </summary>
        void AdjustQuality()
        {
            float now = Time.unscaledTime;
            // One long frame - a tab coming back, a load finishing - must not count much.
            frameTime = Mathf.Lerp(frameTime, Mathf.Min(Time.unscaledDeltaTime, 0.1f), 0.1f);
            if (!loaded || now < nextQualityCheck) return;
            nextQualityCheck = now + 1f;
            if (frameTime > 1f / 45f) renderScale = Mathf.Max(0.5f, renderScale * 0.85f);
            else if (frameTime < 1f / 58f && renderScale < 1f) renderScale = Mathf.Min(1f, renderScale * 1.08f);
        }

        // Screen y grows upwards in Unity and downwards in the browser, so the caller
        // passes an already-flipped dy and the arithmetic below matches dist/app.js.
        void Rotate(float dx, float dy)
        {
            yaw -= dx * DragSpeed;
            pitch = Mathf.Clamp(pitch + dy * DragSpeed, -PitchLimit, PitchLimit);
        }

        void Pinch(Vector2 a, Vector2 b, bool started)
        {
            float distance = Vector2.Distance(a, b);
            if (started || lastPinchDistance <= 0f)
            {
                lastPinchDistance = distance;
                return;
            }
            SetZoom(zoom * distance / lastPinchDistance);
            lastPinchDistance = distance;
        }

        void SetZoom(float value)
        {
            zoom = Mathf.Clamp(value, ZoomMin, ZoomMax);
        }

        // ------------------------------------------------ called by the page (SendMessage)

        /// <summary>
        /// Called by the page when the viewer has asked for reduced motion: the globe goes
        /// straight to where the flight would have landed. The page sends it once at
        /// startup, from the WebGL template - which is why the template carries the call
        /// and the built page does not until it is rebuilt with this script.
        /// </summary>
        public void SkipIntro(int unused)
        {
            EndIntro();
            ResetView();
        }

        public void ResetView()
        {
            EndIntro();
            yaw = HomeYaw;
            pitch = HomePitch;
            zoom = HomeZoom;
        }

        /// <summary>
        /// The page's zoom buttons send +/-0.12. The step is a share of the zoom now, not
        /// an amount added to it: a flat 0.12 was a sixth of the old range and would be a
        /// sixtieth of this one, so a button press would barely move.
        /// </summary>
        public void ZoomBy(float delta)
        {
            EndIntro();
            SetZoom(zoom * (1f + delta));
        }

        public void SetPlaying(int playing)
        {
            if (loaded) playback.SetPlaying(playing != 0, Time.unscaledTime);
        }

        public void SetDissolve(int dissolve)
        {
            if (loaded) playback.Dissolve = dissolve != 0;
        }

        /// <summary>1 carries the clouds with the wind between observations, 0 shows the observations alone.</summary>
        public void SetModel(int on)
        {
            model = on != 0;
            if (loaded) playback.Model = model;
        }

        /// <summary>Milliseconds per observation: 1200, 650 or 300 on the page, as in the JavaScript version.</summary>
        public void SetIntervalMs(float milliseconds)
        {
            if (loaded && milliseconds > 0f) playback.Interval = milliseconds / 1000f;
        }

        public void ShowObservation(int index)
        {
            if (loaded) playback.Show(index, Time.unscaledTime);
        }

        public void SetSunlight(int on)
        {
            sunlight = on != 0;
        }

        public void SetStars(int on)
        {
            stars = on != 0;
        }

        public void SetCloudRelief(int on)
        {
            cloudRelief = on != 0;
        }

        /// <summary>The storms found in the observations, from the page's switch.</summary>
        public void SetStorms(int on)
        {
            stormsOn = on != 0;
            Report();
        }

        /// <summary>
        /// What storms have typically done next. The grid is 116 KB and most visits never
        /// ask for it, so it is fetched the first time someone does.
        /// </summary>
        public void SetOutlook(int on)
        {
            outlookOn = on != 0;
            if (outlookOn)
            {
                stormsOn = true;
                if (stormMarks != null && !stormMarks.HasGrid) StartCoroutine(LoadOutlookRoutine());
            }
            Report();
        }

        IEnumerator LoadOutlookRoutine()
        {
            yield return stormMarks.LoadOutlook(ObservationLoader.SiteRoot());
            Report();
        }

        public void SetFlow(int on)
        {
            flow = on != 0;
        }

        /// <summary>Hours between consecutive stored observations.</summary>
        double StepHours()
        {
            return loader.Times.Count >= 2 ? (loader.Times[1] - loader.Times[0]).TotalHours : 1.0;
        }

        /// <summary>
        /// Seconds of the atmosphere's time per playback step: the gap between the two
        /// observations on screen, or between the first two on the step back to the start.
        /// </summary>
        float StepSeconds()
        {
            if (loader.Times.Count < 2) return 3600f;
            int later = playback.Continuing ? playback.Current : 1;
            int earlier = playback.Continuing ? playback.Previous : 0;
            return Mathf.Max(60f, (float)(loader.Times[later] - loader.Times[earlier]).TotalSeconds);
        }

        /// <summary>The wind observed at a frame's own time, or the single wind if there is none for it.</summary>
        Texture2D WindFor(int index)
        {
            Texture2D own = index >= 0 && index < loader.Winds.Count ? loader.Winds[index] : null;
            return own != null ? own : loader.Wind;
        }

        /// <summary>
        /// The moment whose sun is drawn. During a dissolve between an observation and the
        /// next hour's, the sun moves with it: the sunlight at each instant in between is
        /// real astronomy, not an invented observation, and it spares the terminator a
        /// fifteen-degree jump every step.
        /// </summary>
        DateTime SunTime(float now)
        {
            return Between(playback.Previous, playback.Current, playback.Fade(now));
        }

        DateTime Between(int previous, int current, float fade)
        {
            DateTime later = loader.Times[current];
            if (fade >= 1f) return later;
            DateTime earlier = loader.Times[previous];
            return earlier + TimeSpan.FromTicks((long)((later - earlier).Ticks * fade));
        }

        // ------------------------------------------------ told to the page

        /// <summary>
        /// Sends the state to the page whenever it changes. Called every frame, so it first
        /// compares a key made of the few numbers that can change, and only builds the JSON
        /// when one has. It used to build and serialise the whole state every frame and
        /// throw it away; on a phone that garbage made the collector stop the page now and
        /// then, which showed as a hitch.
        /// </summary>
        void Report()
        {
            if (loader == null) return;
            // During the loop's seam the page names whichever observation mostly shows.
            int shownIndex = loaded ? playback.Shown(Time.unscaledTime) : 0;
            long key = (loaded ? 1L : loadFinished ? 2L : 0L)
                       | (long)(loaded ? loader.Frames.Count : loader.Progress) << 2
                       | (long)shownIndex << 10
                       | (loaded && playback.Playing ? 1L : 0L) << 18
                       | (!loaded || playback.Dissolve ? 1L : 0L) << 19
                       | (sunlight ? 1L : 0L) << 20
                       | (stars ? 1L : 0L) << 21
                       | (cloudRelief ? 1L : 0L) << 22
                       | (flow ? 1L : 0L) << 23
                       | (loader.Error != null ? 1L : 0L) << 24
                       | (long)Mathf.RoundToInt(renderScale * 20f) << 25
                       | (model ? 1L : 0L) << 31
                       | (loaded && playback.Overlaid ? 1L : 0L) << 32
                       | (stormsOn ? 1L : 0L) << 33
                       | (outlookOn ? 1L : 0L) << 34
                       | (stormMarks != null && stormMarks.HasGrid ? 1L : 0L) << 35;
            if (key == lastReportKey) return;
            lastReportKey = key;
            if (loaded && stampArray == null) stampArray = ToArray(loader.Stamps);

            State state = new State
            {
                state = loaded ? "ready" : loadFinished ? "error" : "loading",
                loadedCount = loaded ? loader.Frames.Count : loader.Progress,
                expected = loader.Expected,
                index = shownIndex,
                time = loaded ? loader.Stamps[shownIndex] : "",
                times = loaded ? stampArray : new string[0],
                playing = loaded && playback.Playing,
                dissolve = !loaded || playback.Dissolve,
                model = model,
                sunlight = sunlight,
                nightLights = loader.Night != null,
                stars = stars,
                starMap = loader.Stars != null,
                cloudRelief = cloudRelief,
                landMap = loader.Land != null,
                flow = flow,
                windTime = loaded && WindFor(shownIndex) != loader.Wind ? loader.Stamps[shownIndex] : loader.WindStamp,
                seam = loaded && playback.Overlaid,
                loopHours = loaded && playback.Seam > 0 ? (int)Math.Round(StepHours() * playback.LoopLength) : 0,
                seamHours = loaded && playback.Seam > 0 ? (int)Math.Round(StepHours() * playback.Seam) : 0,
                windEachTime = loader.WindsLoaded > 0,
                motionMeasured = loader.MotionsLoaded > 0,
                windTexels = loader.WindTexels,
                renderPercent = Mathf.RoundToInt(renderScale * 100f),
                error = loader.Error ?? "",
            };
            if (loaded)
            {
                Vector2 subsolar = SolarPosition.Subsolar(loader.Times[shownIndex]);
                state.sunLat = Mathf.Round(subsolar.x * 10f) / 10f;
                state.sunLon = Mathf.Round(subsolar.y * 10f) / 10f;
                state.storms = stormsOn;
                state.outlook = outlookOn;
                state.outlookReady = stormMarks != null && stormMarks.HasGrid;
                if (stormMarks != null && stormMarks.CentreAt(loader.Times[shownIndex],
                        out float sLat, out float sLon, out bool sLast))
                {
                    state.stormFound = true;
                    state.stormLat = Mathf.Round(sLat * 10f) / 10f;
                    state.stormLon = Mathf.Round(sLon * 10f) / 10f;
                    state.stormLast = sLast;
                }
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            MyAtrasReport(JsonUtility.ToJson(state));
#endif
        }

        static string[] ToArray(System.Collections.Generic.IReadOnlyList<string> list)
        {
            string[] array = new string[list.Count];
            for (int i = 0; i < list.Count; i++) array[i] = list[i];
            return array;
        }

        void OnRenderImage(RenderTexture source, RenderTexture destination)
        {
            // Until the ground texture and the observations are in, the shader would draw
            // its default white; the canvas stays clear and the page shows its status.
            if (material == null || !loaded)
            {
                Graphics.Blit(source, destination);
                return;
            }
            material.SetFloat("_Yaw", yaw);
            material.SetFloat("_Pitch", pitch);
            material.SetFloat("_Zoom", zoom);
            material.SetFloat("_Mode", 0f);
            material.SetFloat("_Panels", 0f);
            material.SetFloat("_RawObservation", 0f);
            float now = Time.unscaledTime;
            material.SetTexture("_Weather", loader.Frames[playback.Current]);
            material.SetTexture("_WeatherPrev", loader.Frames[playback.Previous]);
            material.SetFloat("_Fade", playback.Fade(now));
            // The model carries the clouds over the time between the two observations; on
            // the step back to the start there is nothing to carry them across.
            bool carried = model && playback.Continuing;
            // The motion measured between exactly these two observations, if there is one.
            Texture2D measured = carried && playback.Current == playback.Previous + 1
                                 && playback.Previous < loader.Motions.Count
                ? loader.Motions[playback.Previous] : null;
            if (measured != null) material.SetTexture("_Motion", measured);
            material.SetFloat("_MotionOn", measured != null ? 1f : 0f);
            material.SetFloat("_MotionScale", loader.MotionScale);
            material.SetFloat("_Advect", carried ? 1f : 0f);
            material.SetFloat("_Gap", carried
                ? (float)(loader.Times[playback.Current] - loader.Times[playback.Previous]).TotalSeconds
                : 0f);
            DateTime shown = SunTime(now);
            Vector3 sun = SolarPosition.Direction(SolarPosition.Subsolar(shown));
            double sidereal = SolarPosition.GreenwichSiderealDegrees(shown);
            float overlay = playback.OverlayWeight(now);
            if (overlay > 0f)
            {
                // The overlaid pair is a whole number of days away, so its sun stands at the
                // same hour of the day; blending the two only moves the terminator by the
                // change of the sun's declination over those days, under a degree.
                DateTime shownB = Between(playback.OverlayPrevious, playback.OverlayCurrent, playback.Fade(now));
                sun = Vector3.Slerp(sun, SolarPosition.Direction(SolarPosition.Subsolar(shownB)), overlay).normalized;
                double otherSidereal = SolarPosition.GreenwichSiderealDegrees(shownB);
                sidereal += overlay * ((((otherSidereal - sidereal) % 360.0) + 540.0) % 360.0 - 180.0);
            }
            material.SetFloat("_Sunlight", sunlight ? 1f : 0f);
            material.SetVector("_Sun", sun);
            material.SetFloat("_StarsOn", stars && loader.Stars != null ? 1f : 0f);
            material.SetFloat("_Sidereal", (float)(sidereal * Math.PI / 180.0));

            // The loop's seam: the observations after the loop's end, carried on in time and
            // faded out while the loop's start fades in (ObservationPlayback).
            material.SetFloat("_OverlayOn", overlay);
            if (overlay > 0f)
            {
                material.SetTexture("_WeatherB", loader.Frames[playback.OverlayCurrent]);
                material.SetTexture("_WeatherPrevB", loader.Frames[playback.OverlayPrevious]);
                Texture2D measuredB = playback.OverlayPrevious < loader.Motions.Count
                    ? loader.Motions[playback.OverlayPrevious] : null;
                if (measuredB != null) material.SetTexture("_MotionB", measuredB);
                material.SetFloat("_MotionOnB", measuredB != null ? 1f : 0f);
                material.SetFloat("_AdvectB", model ? 1f : 0f);
                material.SetFloat("_GapB", (float)(loader.Times[playback.OverlayCurrent]
                                                   - loader.Times[playback.OverlayPrevious]).TotalSeconds);
            }
            material.SetFloat("_CloudRelief", cloudRelief ? 1f : 0f);
            // Each observation's own wind; the interval between two uses both, and the flow
            // lines are drawn from whichever observation is nearer in time.
            Texture2D windBefore = WindFor(playback.Previous), windAfter = WindFor(playback.Current);
            if (windBefore != null) material.SetTexture("_Wind", windBefore);
            if (windAfter != null) material.SetTexture("_WindNext", windAfter);
            Texture2D flowWind = playback.Fade(now) < 0.5f ? windBefore : windAfter;
            if (flowWind != null) material.SetTexture("_FlowWind", flowWind);
            material.SetFloat("_FlowOn", flow && flowWind != null ? 1f : 0f);
            // The flow keeps the playback's clock: one step of the playback is the time
            // between two observations (three hours in the bundled set), so a line moves as
            // far as the clouds do between them. 111,195 m to a degree of arc.
            material.SetFloat("_FlowScale", StepSeconds() / Mathf.Max(playback.Interval, 0.05f) / 111195f);
            if (renderScale > 0.99f)
            {
                Graphics.Blit(source, destination, material);
            }
            else
            {
                // Drawn smaller and scaled up with bilinear filtering. The shader works in
                // proportions of the screen, so the globe is the same size either way.
                RenderTexture reduced = RenderTexture.GetTemporary(
                    Mathf.Max(1, Mathf.RoundToInt(source.width * renderScale)),
                    Mathf.Max(1, Mathf.RoundToInt(source.height * renderScale)), 0, source.format);
                reduced.filterMode = FilterMode.Bilinear;
                Graphics.Blit(source, reduced, material);
                Graphics.Blit(reduced, destination);
                RenderTexture.ReleaseTemporary(reduced);
            }
            DrawStormMarks(destination, source.width, source.height);
        }

        /// <summary>
        /// The marks go over the finished globe at full size. The globe itself may be drawn
        /// smaller when frames are slow; a ring a few pixels across should not be.
        /// </summary>
        void DrawStormMarks(RenderTexture destination, int width, int height)
        {
            if (stormMarks == null || !stormsOn || !loaded) return;
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = destination;
            stormMarks.Draw(loader.Times[playback.Shown(Time.unscaledTime)], yaw, pitch, zoom,
                width, height, stormsOn, outlookOn);
            RenderTexture.active = previous;
        }

#if UNITY_EDITOR
        // There is no page around the canvas in the editor, so say at least what is on
        // the globe. The published build shows nothing drawn by Unity but the globe.
        void OnGUI()
        {
            string line = loaded
                ? $"{loader.Labels[playback.Current]}  ({playback.Current + 1} / {loader.Frames.Count})" +
                  (playback.Playing ? "" : "  paused")
                : loader?.Error ?? "Loading the stored observations...";
            GUI.Label(new Rect(12f, Screen.height - 32f, Screen.width - 24f, 24f), line);
        }
#endif
    }
}
