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
            if (loader.Error != null)
            {
                Debug.LogError("MyAtras: " + loader.Error);
                yield break;
            }
            material.SetTexture("_Earth", loader.Earth);
            material.SetTexture("_Weather", loader.Observation);
            material.SetVector("_Watermark", loader.Watermark);
            material.SetFloat("_WeatherActive", 1f);
            loaded = true;
        }

        void Update()
        {
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
            Graphics.Blit(source, destination, material);
        }

        // Credits and the observation time stay on screen. The built-in font has no CJK
        // glyphs, so this overlay is ASCII until a Japanese font asset is added.
        void OnGUI()
        {
            GUIStyle style = new GUIStyle(GUI.skin.label)
            {
                fontSize = Mathf.RoundToInt(Mathf.Max(12f, Mathf.Min(Screen.width, Screen.height) * 0.03f)),
                wordWrap = true,
                normal = { textColor = new Color(0.82f, 0.88f, 0.92f) },
            };
            string line = loaded ? loader.ObservationLabel
                : loader?.Error ?? "Loading the stored observation...";
            GUIContent text = new GUIContent(line +
                "\nInfrared brightness composited as a white layer - uncalibrated, not a cloud mask." +
                "\nSource: SSEC RealEarth, UW-Madison. Ground reference: NASA Blue Marble.");

            // The credits have to stay on screen however narrow it is, so the block is
            // measured after wrapping and placed from the bottom edge up.
            float margin = style.fontSize;
            float width = Screen.width - margin * 2f;
            float height = style.CalcHeight(text, width);
            GUI.Label(new Rect(margin, Screen.height - margin - height, width, height), text, style);
        }
    }
}
