using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;
using UnityEngine.Networking;

namespace MyAtras
{
    /// <summary>
    /// Loads the ground reference texture and one stored infrared observation.
    ///
    /// The Unity build fetches no observations of its own: it reads the same files the
    /// JavaScript globe reads, next to it on the published site, so both versions can
    /// only ever show the same frames. dist/weather/sequence/manifest.json stays the
    /// single record of what was downloaded, from where, and with which SHA-256.
    /// </summary>
    public sealed class ObservationLoader
    {
        // SSEC stamps a fixed-size logo into the lower-left corner of every image it
        // serves. Its size in pixels, turned into a fraction of the image below, is
        // what the shader uses to draw that corner from the observation unchanged.
        static readonly Vector2 WatermarkPixels = new Vector2(54f, 44f);

        public Texture2D Earth { get; private set; }
        /// <summary>NASA Black Marble 2016 city lights; null if it could not be loaded.</summary>
        public Texture2D Night { get; private set; }
        /// <summary>Bright Star Catalogue stars to magnitude 6 (scripts/build-stars.py); null if missing.</summary>
        public Texture2D Stars { get; private set; }
        /// <summary>Natural Earth land and coastline (scripts/build-land.py); null if missing.</summary>
        public Texture2D Land { get; private set; }
        /// <summary>The observed wind as a texture (WindField.cs); null if amv.json could not be read.</summary>
        public Texture2D Wind { get; private set; }
        /// <summary>The wind's observation stamp, e.g. 20260916.190000; one time only.</summary>
        public string WindStamp { get; private set; } = "";
        /// <summary>How many one-degree texels hold observed wind.</summary>
        public int WindTexels { get; private set; }
        /// <summary>
        /// The observed wind at each frame's own time (dist/data/wind/, written by
        /// scripts/wind-grid.cjs), in the same order as Frames; null where none was stored
        /// for that time, in which case the single wind above stands in.
        /// </summary>
        public IReadOnlyList<Texture2D> Winds => winds;
        /// <summary>How many frames have their own time's wind.</summary>
        public int WindsLoaded { get; private set; }
        /// <summary>
        /// How the clouds moved from each frame to the next, measured from the two
        /// observations themselves (dist/data/motion/, scripts/build-motion.cjs), indexed by
        /// the earlier frame; null where there is none, leaving that interval to the wind.
        /// </summary>
        public IReadOnlyList<Texture2D> Motions => motions;
        /// <summary>How many intervals have a measured motion.</summary>
        public int MotionsLoaded { get; private set; }
        /// <summary>The m/s either way that a motion image's red and green span.</summary>
        public float MotionScale { get; private set; } = 80f;
        /// <summary>The stored observations, oldest first, as the manifest lists them.</summary>
        public IReadOnlyList<Texture2D> Frames => frames;
        /// <summary>Each frame's observation time in UTC and JST, in ASCII, for the editor.</summary>
        public IReadOnlyList<string> Labels => labels;
        /// <summary>Each frame's SSEC stamp, e.g. 20260916.210000, for the page to format.</summary>
        public IReadOnlyList<string> Stamps => stamps;
        /// <summary>Each frame's observation time in UTC, for where the sun was.</summary>
        public IReadOnlyList<DateTime> Times => times;
        public Vector2 Watermark { get; private set; }
        /// <summary>How many observations the manifest lists, loaded or not.</summary>
        public int Expected { get; private set; }
        public string Error { get; private set; }

        readonly List<Texture2D> frames = new List<Texture2D>();
        readonly List<string> labels = new List<string>();
        readonly List<string> stamps = new List<string>();
        readonly List<DateTime> times = new List<DateTime>();
        readonly List<Texture2D> winds = new List<Texture2D>();
        readonly List<Texture2D> motions = new List<Texture2D>();

        [Serializable]
        class MotionEntry
        {
            public string from;
            public string to;
            public string file;
        }

        [Serializable]
        class MotionManifest
        {
            public float scale;
            public List<MotionEntry> intervals;
        }

        [Serializable]
        class WindEntry
        {
            public string time;
            public string file;
        }

        [Serializable]
        class WindManifest
        {
            public List<WindEntry> winds;
        }

        [Serializable]
        class Frame
        {
            public string time;
            public string file;
            public string source;
            public string sha256;
            public long bytes;
        }

        [Serializable]
        class Manifest
        {
            public List<Frame> globalir;
        }

        public IEnumerator Load()
        {
            string root = SiteRoot();

            yield return Texture(root + "assets/earth.jpg", TextureWrapMode.Repeat, texture =>
            {
                Earth = texture;
            });
            if (Earth == null)
            {
                Error = "The ground reference texture could not be loaded.";
                yield break;
            }

            // Only the night side uses it, so the globe goes on without it.
            yield return Texture(root + "assets/night.jpg", TextureWrapMode.Repeat, texture =>
            {
                Night = texture;
            });

            // Only the night side uses it, to keep land and sea apart; optional.
            yield return Texture(root + "assets/land.png", TextureWrapMode.Repeat, texture =>
            {
                Land = texture;
            });

            // The observed wind for the flow lines: the same file the JavaScript version's
            // wind model reads. Optional, like the other layers.
            string windJson = null;
            yield return Text(root + "data/amv.json", text => windJson = text);
            if (windJson != null)
            {
                try
                {
                    WindField.Bundle bundle = JsonUtility.FromJson<WindField.Bundle>(windJson);
                    if (bundle?.points != null && bundle.points.Length > 0)
                    {
                        Wind = WindField.Build(bundle.points, out int texels);
                        WindTexels = texels;
                        WindStamp = bundle.time ?? "";
                    }
                }
                catch (Exception e)
                {
                    Debug.LogWarning("MyAtras: the observed wind could not be read: " + e.Message);
                }
            }

            // Only the background uses it, so this too is optional.
            yield return Texture(root + "assets/stars.png", TextureWrapMode.Repeat, texture =>
            {
                Stars = texture;
            });

            string manifestJson = null;
            yield return Text(root + "weather/sequence/manifest.json", text => manifestJson = text);
            if (manifestJson == null)
            {
                Error = "The observation manifest could not be loaded.";
                yield break;
            }

            Manifest manifest = null;
            try
            {
                manifest = JsonUtility.FromJson<Manifest>(manifestJson);
            }
            catch (Exception e)
            {
                Error = "The observation manifest could not be read: " + e.Message;
                yield break;
            }
            if (manifest?.globalir == null || manifest.globalir.Count == 0)
            {
                Error = "The observation manifest lists no infrared frames.";
                yield break;
            }

            // Oldest first. The stamps sort as text, so this holds whatever order the
            // manifest was written in.
            manifest.globalir.Sort((a, b) => string.CompareOrdinal(a.time, b.time));
            Expected = manifest.globalir.Count;

            foreach (Frame frame in manifest.globalir)
            {
                // Without a valid time there is no knowing where the sun was, or where the
                // frame belongs in the sequence; treat it as a gap.
                if (!TryParseStamp(frame.time, out DateTime observedAt))
                {
                    Error = $"The observation {frame.time} has no valid time; showing only the ones before it.";
                    break;
                }

                Texture2D observation = null;
                yield return Texture(root + "weather/sequence/" + frame.file, TextureWrapMode.Clamp,
                    texture => observation = texture);
                if (observation == null)
                {
                    // Stop at the first gap rather than skip it: playing on past a missing
                    // hour would show two observations as if they were an hour apart.
                    Error = $"The observation for {Label(frame.time)} could not be loaded; " +
                            "showing only the ones before it.";
                    break;
                }
                frames.Add(observation);
                labels.Add(Label(frame.time));
                stamps.Add(frame.time);
                times.Add(observedAt);
            }

            if (frames.Count == 0)
            {
                Error = "No stored observation could be loaded.";
                yield break;
            }

            Watermark = new Vector2(
                WatermarkPixels.x / Mathf.Max(1, frames[0].width),
                WatermarkPixels.y / Mathf.Max(1, frames[0].height));

            // The wind at each frame's time, matched by the time itself: a wind is only
            // ever used for the observation it was observed with. Optional - without them
            // the clouds are carried by the single wind loaded above.
            var windFiles = new Dictionary<string, string>();
            string windManifestJson = null;
            yield return Text(root + "data/wind/manifest.json", text => windManifestJson = text);
            if (windManifestJson != null)
            {
                try
                {
                    WindManifest windManifest = JsonUtility.FromJson<WindManifest>(windManifestJson);
                    if (windManifest?.winds != null)
                    {
                        foreach (WindEntry entry in windManifest.winds)
                        {
                            if (!string.IsNullOrEmpty(entry.time) && !string.IsNullOrEmpty(entry.file))
                                windFiles[entry.time] = entry.file;
                        }
                    }
                }
                catch (Exception e)
                {
                    Debug.LogWarning("MyAtras: the wind manifest could not be read: " + e.Message);
                }
            }
            foreach (string stamp in stamps)
            {
                Texture2D wind = null;
                if (windFiles.TryGetValue(stamp, out string file))
                {
                    yield return Texture(root + "data/wind/" + file, TextureWrapMode.Repeat, texture => wind = texture);
                }
                winds.Add(wind);
                if (wind != null) WindsLoaded++;
            }

            // The measured motion between each frame and the next. Used only for the pair
            // it was measured from - the same two times - and optional like the winds.
            var motionFiles = new Dictionary<string, string>();
            string motionManifestJson = null;
            yield return Text(root + "data/motion/manifest.json", text => motionManifestJson = text);
            if (motionManifestJson != null)
            {
                try
                {
                    MotionManifest motionManifest = JsonUtility.FromJson<MotionManifest>(motionManifestJson);
                    if (motionManifest != null && motionManifest.scale > 0f) MotionScale = motionManifest.scale;
                    if (motionManifest?.intervals != null)
                    {
                        foreach (MotionEntry entry in motionManifest.intervals)
                        {
                            if (!string.IsNullOrEmpty(entry.from) && !string.IsNullOrEmpty(entry.file))
                                motionFiles[entry.from + ">" + entry.to] = entry.file;
                        }
                    }
                }
                catch (Exception e)
                {
                    Debug.LogWarning("MyAtras: the motion manifest could not be read: " + e.Message);
                }
            }
            for (int k = 0; k + 1 < stamps.Count; k++)
            {
                Texture2D measured = null;
                if (motionFiles.TryGetValue(stamps[k] + ">" + stamps[k + 1], out string file))
                {
                    yield return Texture(root + "data/motion/" + file, TextureWrapMode.Repeat, texture => measured = texture);
                }
                motions.Add(measured);
                if (measured != null) MotionsLoaded++;
            }
        }

        /// <summary>
        /// The directory the site is served from. In a browser that is the folder above
        /// dist/unity/; in the editor it is dist/ in the working tree, so the same files
        /// are read either way.
        /// </summary>
        static string SiteRoot()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            string page = Application.absoluteURL;
            int query = page.IndexOfAny(new[] { '?', '#' });
            if (query >= 0) page = page.Substring(0, query);
            int slash = page.LastIndexOf('/');
            string directory = slash >= 0 ? page.Substring(0, slash + 1) : page + "/";
            return directory + "../";
#else
            string dist = Path.GetFullPath(Path.Combine(Application.dataPath, "../../../dist"));
            return "file://" + dist.Replace('\\', '/') + "/";
#endif
        }

        static IEnumerator Text(string url, Action<string> onLoaded)
        {
            using (UnityWebRequest request = UnityWebRequest.Get(url))
            {
                yield return request.SendWebRequest();
                if (request.result == UnityWebRequest.Result.Success)
                {
                    onLoaded(request.downloadHandler.text);
                }
                else
                {
                    Debug.LogWarning($"MyAtras: {url} could not be read ({request.error})");
                }
            }
        }

        static IEnumerator Texture(string url, TextureWrapMode wrapU, Action<Texture2D> onLoaded)
        {
            using (UnityWebRequest request = UnityWebRequestTexture.GetTexture(url, true))
            {
                yield return request.SendWebRequest();
                if (request.result != UnityWebRequest.Result.Success)
                {
                    Debug.LogWarning($"MyAtras: {url} could not be read ({request.error})");
                    yield break;
                }
                Texture2D texture = DownloadHandlerTexture.GetContent(request);
                // The globe wraps in longitude and stops at the poles, as in the WebGL version.
                texture.wrapModeU = wrapU;
                texture.wrapModeV = TextureWrapMode.Clamp;
                texture.filterMode = FilterMode.Bilinear;
                onLoaded(texture);
            }
        }

        static bool TryParseStamp(string stamp, out DateTime utc)
        {
            return DateTime.TryParseExact(stamp, "yyyyMMdd.HHmmss", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out utc);
        }

        /// <summary>"20260916.210000" as an observation time in UTC and JST.</summary>
        static string Label(string stamp)
        {
            if (DateTime.TryParseExact(stamp, "yyyyMMdd.HHmmss", CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTime utc))
            {
                DateTime jst = utc.AddHours(9);
                return $"{utc:yyyy-MM-dd HH:mm} UTC / {jst:yyyy-MM-dd HH:mm} JST";
            }
            return stamp;
        }
    }
}
