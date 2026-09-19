using System;
using System.Collections.Generic;
using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// The observed wind as a texture the globe shader can read: one texel per degree of
    /// longitude and latitude, built from the same dist/data/amv.json the JavaScript
    /// version's wind model uses - SSEC atmospheric motion vectors, both pressure bands,
    /// only points observed at the file's own time.
    ///
    /// Each texel takes the observed vectors within <see cref="Reach"/> degrees of arc,
    /// weighted towards the nearest, and nothing else. Where no vector is that close the
    /// texel is left empty, so the globe draws no flow there: an empty patch is a gap in
    /// the observations, not calm air, and it is not filled in.
    ///
    /// Encoding, RGBA32, the same as the per-observation wind images scripts/wind-grid.cjs
    /// writes: red and green are the eastward and northward wind, -40 to +40 m/s mapped
    /// to 0..255 (128 is still air); blue is how well observed the texel is, 1 next to a
    /// vector and falling to 0 at the reach; alpha is always opaque. This one is only the
    /// fallback for when those images are missing.
    /// </summary>
    public static class WindField
    {
        public const int Width = 360;
        public const int Height = 180;
        public const float Reach = 2.5f;
        public const float Scale = 40f;

        [Serializable]
        public class Point
        {
            public float lat;
            public float lon;
            public float u;
            public float v;
            public string product;
        }

        [Serializable]
        public class Bundle
        {
            public string time;
            public Point[] points;
        }

        /// <summary>
        /// Returns the texture and how many texels hold observed wind. The CPU copy is
        /// released unless <paramref name="keepReadable"/>, which only the editor check needs.
        /// </summary>
        public static Texture2D Build(Point[] points, out int observedTexels, bool keepReadable = false)
        {
            // Two-degree buckets, so each texel only looks at the vectors near it.
            var buckets = new Dictionary<int, List<Point>>();
            foreach (Point p in points)
            {
                if (float.IsNaN(p.u) || float.IsNaN(p.v)) continue;
                int key = BucketKey(Mathf.FloorToInt((p.lon + 180f) / 2f), Mathf.FloorToInt((p.lat + 90f) / 2f));
                if (!buckets.TryGetValue(key, out List<Point> list)) buckets[key] = list = new List<Point>();
                list.Add(p);
            }

            var pixels = new Color32[Width * Height];
            observedTexels = 0;
            for (int y = 0; y < Height; y++)
            {
                // Row 0 is the south; Unity textures start at the bottom row.
                float lat = -90f + y + 0.5f;
                for (int x = 0; x < Width; x++)
                {
                    float lon = -180f + x + 0.5f;
                    float u = 0f, v = 0f, weights = 0f, nearest = float.MaxValue;
                    int bx = Mathf.FloorToInt((lon + 180f) / 2f), by = Mathf.FloorToInt((lat + 90f) / 2f);
                    for (int dy = -2; dy <= 2; dy++)
                    {
                        for (int dx = -2; dx <= 2; dx++)
                        {
                            int wx = ((bx + dx) % 180 + 180) % 180;
                            if (!buckets.TryGetValue(BucketKey(wx, by + dy), out List<Point> list)) continue;
                            foreach (Point p in list)
                            {
                                float d = ArcDegrees(lat, lon, p.lat, p.lon);
                                if (d >= Reach) continue;
                                float w = (1f - d / Reach) * (1f - d / Reach);
                                u += p.u * w;
                                v += p.v * w;
                                weights += w;
                                nearest = Mathf.Min(nearest, d);
                            }
                        }
                    }

                    if (weights <= 0f)
                    {
                        pixels[y * Width + x] = new Color32(128, 128, 0, 255);
                        continue;
                    }
                    u /= weights;
                    v /= weights;
                    float observed = Mathf.Clamp01(1f - nearest / Reach);
                    pixels[y * Width + x] = new Color32(
                        Encode(u), Encode(v), (byte)Mathf.RoundToInt(observed * 255f), 255);
                    observedTexels++;
                }
            }

            var texture = new Texture2D(Width, Height, TextureFormat.RGBA32, false, true)
            {
                wrapModeU = TextureWrapMode.Repeat,
                wrapModeV = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };
            texture.SetPixels32(pixels);
            texture.Apply(false, !keepReadable);
            return texture;
        }

        static int BucketKey(int x, int y) => y * 1000 + x;

        static byte Encode(float metresPerSecond)
        {
            return (byte)Mathf.RoundToInt(Mathf.Clamp01(metresPerSecond / (2f * Scale) + 0.5f) * 255f);
        }

        /// <summary>Great-circle distance in degrees.</summary>
        static float ArcDegrees(float lat1, float lon1, float lat2, float lon2)
        {
            float p1 = lat1 * Mathf.Deg2Rad, p2 = lat2 * Mathf.Deg2Rad;
            float dp = p2 - p1, dl = (lon2 - lon1) * Mathf.Deg2Rad;
            float a = Mathf.Sin(dp / 2f) * Mathf.Sin(dp / 2f)
                      + Mathf.Cos(p1) * Mathf.Cos(p2) * Mathf.Sin(dl / 2f) * Mathf.Sin(dl / 2f);
            return 2f * Mathf.Asin(Mathf.Sqrt(Mathf.Clamp01(a))) * Mathf.Rad2Deg;
        }
    }
}
