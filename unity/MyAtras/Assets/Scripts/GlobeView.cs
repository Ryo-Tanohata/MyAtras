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
        const float ZoomMax = 1.7f;

        // Transparent: the page's background shows through the canvas, as it does
        // around the JavaScript globe.
        static readonly Color Background = new Color(0f, 0f, 0f, 0f);

        float yaw = 2.35f;
        float pitch = 0.20f;
        float zoom = 1f;

        Material material;
        ObservationLoader loader;
        ObservationPlayback playback;
        bool loaded;
        bool loadFinished;
        bool sunlight = true;
        bool stars = true;
        bool cloudRelief = true;
        bool flow = true;
        Vector2 lastPointer;
        float lastPinchDistance;
        string lastReport;

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
            public bool sunlight;    // day and night drawn from the sun at the observation time
            public bool nightLights; // the Black Marble texture loaded
            public bool stars;       // the star background drawn
            public bool starMap;     // the star map loaded
            public bool cloudRelief; // cloud relief and shadows drawn
            public bool landMap;     // the night-side land and coastline map loaded
            public bool flow;        // the flow lines drawn
            public string windTime;  // the wind's observation stamp; empty if it could not be read
            public int windTexels;   // one-degree texels with observed wind
            public float sunLat;     // subsolar point at the observation time, degrees
            public float sunLon;     // east positive
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

            loader = new ObservationLoader();
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
            if (loader.Wind != null) material.SetTexture("_Wind", loader.Wind);
            material.SetVector("_Watermark", loader.Watermark);
            material.SetFloat("_WeatherActive", 1f);
            playback = new ObservationPlayback(loader.Frames.Count, Time.unscaledTime);
            loaded = true;
        }

        void Update()
        {
            if (loaded) playback.Tick(Time.unscaledTime);
            Report();

            if (Input.touchCount >= 2)
            {
                Pinch(Input.GetTouch(0).position, Input.GetTouch(1).position,
                    Input.GetTouch(1).phase == TouchPhase.Began);
                return;
            }
            lastPinchDistance = 0f;

            if (Input.touchCount == 1)
            {
                Touch touch = Input.GetTouch(0);
                if (touch.phase == TouchPhase.Moved) Rotate(touch.deltaPosition.x, -touch.deltaPosition.y);
                return;
            }

            if (Input.GetMouseButtonDown(0)) lastPointer = Input.mousePosition;
            if (Input.GetMouseButton(0))
            {
                Vector2 now = Input.mousePosition;
                Rotate(now.x - lastPointer.x, -(now.y - lastPointer.y));
                lastPointer = now;
            }

            float wheel = Input.mouseScrollDelta.y;
            if (!Mathf.Approximately(wheel, 0f)) SetZoom(zoom * Mathf.Exp(wheel * 0.1f));
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

        public void ResetView()
        {
            yaw = 2.35f;
            pitch = 0.20f;
            zoom = 1f;
        }

        /// <summary>The page's zoom buttons step by 0.12, as in dist/app.js.</summary>
        public void ZoomBy(float delta)
        {
            SetZoom(zoom + delta);
        }

        public void SetPlaying(int playing)
        {
            if (loaded) playback.SetPlaying(playing != 0, Time.unscaledTime);
        }

        public void SetDissolve(int dissolve)
        {
            if (loaded) playback.Dissolve = dissolve != 0;
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

        public void SetFlow(int on)
        {
            flow = on != 0;
        }

        /// <summary>
        /// The moment whose sun is drawn. During a dissolve between an observation and the
        /// next hour's, the sun moves with it: the sunlight at each instant in between is
        /// real astronomy, not an invented observation, and it spares the terminator a
        /// fifteen-degree jump every step.
        /// </summary>
        DateTime SunTime(float now)
        {
            DateTime current = loader.Times[playback.Current];
            float fade = playback.Fade(now);
            if (fade >= 1f) return current;
            DateTime previous = loader.Times[playback.Previous];
            return previous + TimeSpan.FromTicks((long)((current - previous).Ticks * fade));
        }

        // ------------------------------------------------ told to the page

        /// <summary>Sends the state to the page whenever it changes.</summary>
        void Report()
        {
            if (loader == null) return;
            State state = new State
            {
                state = loaded ? "ready" : loadFinished ? "error" : "loading",
                loadedCount = loader.Frames.Count,
                expected = loader.Expected,
                index = loaded ? playback.Current : 0,
                time = loaded ? loader.Stamps[playback.Current] : "",
                times = loaded ? ToArray(loader.Stamps) : new string[0],
                playing = loaded && playback.Playing,
                dissolve = !loaded || playback.Dissolve,
                sunlight = sunlight,
                nightLights = loader.Night != null,
                stars = stars,
                starMap = loader.Stars != null,
                cloudRelief = cloudRelief,
                landMap = loader.Land != null,
                flow = flow,
                windTime = loader.WindStamp,
                windTexels = loader.WindTexels,
                error = loader.Error ?? "",
            };
            if (loaded)
            {
                Vector2 subsolar = SolarPosition.Subsolar(loader.Times[playback.Current]);
                state.sunLat = Mathf.Round(subsolar.x * 10f) / 10f;
                state.sunLon = Mathf.Round(subsolar.y * 10f) / 10f;
            }
            string json = JsonUtility.ToJson(state);
            if (json == lastReport) return;
            lastReport = json;
#if UNITY_WEBGL && !UNITY_EDITOR
            MyAtrasReport(json);
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
            DateTime shown = SunTime(now);
            material.SetFloat("_Sunlight", sunlight ? 1f : 0f);
            material.SetVector("_Sun", SolarPosition.Direction(SolarPosition.Subsolar(shown)));
            material.SetFloat("_StarsOn", stars && loader.Stars != null ? 1f : 0f);
            material.SetFloat("_Sidereal", (float)(SolarPosition.GreenwichSiderealDegrees(shown) * Math.PI / 180.0));
            material.SetFloat("_CloudRelief", cloudRelief ? 1f : 0f);
            material.SetFloat("_FlowOn", flow && loader.Wind != null ? 1f : 0f);
            // The flow keeps the playback's clock: at 0.65 s an hour, one screen second is
            // about 1.5 hours of wind, so a line moves as far as the clouds do between
            // two observations. 111,195 m to a degree of arc.
            material.SetFloat("_FlowScale", 3600f / Mathf.Max(playback.Interval, 0.05f) / 111195f);
            Graphics.Blit(source, destination, material);
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
