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
        /// <summary>The stored observations, oldest first, as the manifest lists them.</summary>
        public IReadOnlyList<Texture2D> Frames => frames;
        /// <summary>Each frame's observation time, in ASCII (the built-in font has no CJK glyphs).</summary>
        public IReadOnlyList<string> Labels => labels;
        public Vector2 Watermark { get; private set; }
        /// <summary>How many observations the manifest lists, loaded or not.</summary>
        public int Expected { get; private set; }
        public string Error { get; private set; }

        readonly List<Texture2D> frames = new List<Texture2D>();
        readonly List<string> labels = new List<string>();

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
            }

            if (frames.Count == 0)
            {
                Error = "No stored observation could be loaded.";
                yield break;
            }

            Watermark = new Vector2(
                WatermarkPixels.x / Mathf.Max(1, frames[0].width),
                WatermarkPixels.y / Mathf.Max(1, frames[0].height));
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
