using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Draws the globe and handles drag, pinch and wheel. The rotation limits and step
    /// sizes are the ones from dist/app.js, so the two versions feel the same.
    ///
    /// Everything is rendered by one full-screen pass, as in the WebGL version: there is
    /// no sphere mesh, the shader intersects the sphere analytically.
    /// </summary>
    [RequireComponent(typeof(Camera))]
    public sealed class GlobeView : MonoBehaviour
    {
        const float DragSpeed = 0.006f;
        const float PitchLimit = 1.4f;
        const float ZoomMin = 0.65f;
        const float ZoomMax = 1.7f;

        static readonly Color Background = new Color(0.027f, 0.047f, 0.071f);

        float yaw = 2.35f;
        float pitch = 0.20f;
        float zoom = 1f;

        Material material;
        ObservationLoader loader;
        ObservationPlayback playback;
        bool loaded;
        Vector2 lastPointer;
        float lastPinchDistance;

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

        System.Collections.IEnumerator LoadRoutine()
        {
            yield return loader.Load();
            if (loader.Earth == null)
            {
                Debug.LogError("MyAtras: " + loader.Error);
                yield break;
            }
            if (loader.Frames.Count == 0)
            {
                Debug.LogError("MyAtras: " + loader.Error);
                yield break;
            }
            // A gap part way through is reported on screen but does not stop what did load
            // from being shown; the loader already stopped at the gap.
            if (loader.Error != null) Debug.LogWarning("MyAtras: " + loader.Error);

            material.SetTexture("_Earth", loader.Earth);
            material.SetVector("_Watermark", loader.Watermark);
            material.SetFloat("_WeatherActive", 1f);
            playback = new ObservationPlayback(loader.Frames.Count, Time.unscaledTime);
            loaded = true;
        }

        void Update()
        {
            if (loaded) playback.Tick(Time.unscaledTime);

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

        public void ResetView()
        {
            yaw = 2.35f;
            pitch = 0.20f;
            zoom = 1f;
        }

        void OnRenderImage(RenderTexture source, RenderTexture destination)
        {
            if (material == null)
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
            if (loaded)
            {
                material.SetTexture("_Weather", loader.Frames[playback.Current]);
                material.SetTexture("_WeatherPrev", loader.Frames[playback.Previous]);
                material.SetFloat("_Fade", playback.Fade(Time.unscaledTime));
            }
            Graphics.Blit(source, destination, material);
        }

        // Credits, the observation time and the two controls stay on screen. The built-in
        // font has no CJK glyphs, so this overlay is ASCII until a Japanese font is added.
        void OnGUI()
        {
            float unit = Mathf.Max(12f, Mathf.Min(Screen.width, Screen.height) * 0.03f);
            GUIStyle style = new GUIStyle(GUI.skin.label)
            {
                fontSize = Mathf.RoundToInt(unit),
                wordWrap = true,
                normal = { textColor = new Color(0.82f, 0.88f, 0.92f) },
            };
            float margin = unit;
            float width = Screen.width - margin * 2f;

            if (loaded) Controls(unit, margin, width);

            GUIContent text = new GUIContent(Caption() +
                "\nInfrared brightness composited as a white layer - uncalibrated, not a cloud mask." +
                (loaded && playback.Dissolve
                    ? "\nBetween hours two real observations dissolve; no in-between observation is made."
                    : "") +
                "\nSource: SSEC RealEarth, UW-Madison. Ground reference: NASA Blue Marble.");

            // The credits have to stay on screen however narrow it is, so the block is
            // measured after wrapping and placed from the bottom edge up.
            float height = style.CalcHeight(text, width);
            GUI.Label(new Rect(margin, Screen.height - margin - height, width, height), text, style);
        }

        string Caption()
        {
            if (!loaded) return loader?.Error ?? "Loading the stored observations...";
            string caption = $"Observed {loader.Labels[playback.Current]}  " +
                             $"({playback.Current + 1} / {loader.Frames.Count})";
            // A gap stops the sequence early; say so rather than let it pass as the full set.
            if (loader.Frames.Count < loader.Expected)
                caption += $"\n{loader.Frames.Count} of {loader.Expected} observations could be loaded.";
            return caption;
        }

        void Controls(float unit, float margin, float width)
        {
            GUIStyle button = new GUIStyle(GUI.skin.button)
            {
                fontSize = Mathf.RoundToInt(unit),
                fixedHeight = unit * 2.4f,
            };
            float half = (width - margin) * 0.5f;
            float top = margin;
            float now = Time.unscaledTime;

            if (GUI.Button(new Rect(margin, top, half, button.fixedHeight),
                    playback.Playing ? "Pause" : "Play", button))
            {
                playback.SetPlaying(!playback.Playing, now);
            }
            if (GUI.Button(new Rect(margin * 2f + half, top, half, button.fixedHeight),
                    playback.Dissolve ? "Dissolve: on" : "Dissolve: off", button))
            {
                playback.Dissolve = !playback.Dissolve;
            }
        }
    }
}
