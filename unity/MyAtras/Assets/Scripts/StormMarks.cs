using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

namespace MyAtras
{
    /// <summary>
    /// The storms found in the bundled observations, and where storms have gone before,
    /// drawn over the finished globe. The same two files the JavaScript version reads -
    /// data/storms.json and data/tendency.json - so both show the same thing.
    ///
    /// What is drawn is fenced the same way it is there. A centre is shown for an
    /// observation the storm was found in and for no other time: nothing is interpolated
    /// into the hour between two of them. The outlook appears only at a storm's own last
    /// observation, so a guess is never drawn over an hour the globe already has, and it is
    /// the middle of 4,759 past storms rather than a forecast of this one.
    ///
    /// Drawn after the globe's blit, in screen space, because the globe here is a
    /// full-screen shader and there is no sphere to hang anything on. The camera arithmetic
    /// is the shader's own, so a centre lands on the place in the picture it was measured
    /// from.
    /// </summary>
    public sealed class StormMarks
    {
        const float Radius = 1.004f;        // just off the surface, so marks are not buried
        const float FanRadius = 1.003f;
        const int OutlookHours = 48;        // beyond this the middle of past storms stops tracking
        const int OutlookStepHours = 3;
        const int DashHours = 6;            // one hollow ring every six hours: a broken line
        const float KmPerDegree = 111.195f;
        const float Front = 0.02f;          // view depth a point must clear to be on this side

        [Serializable] public sealed class Point
        {
            public string time;
            public float lat;
            public float lon;
            public float circ;
        }

        [Serializable] public sealed class Storm
        {
            public string from;
            public string to;
            public Point[] points;
        }

        [Serializable] public sealed class Bundle
        {
            public Storm[] storms;
        }

        /// <summary>
        /// The tendency grid. A flat list of numbers rather than a map, because
        /// JsonUtility reads a float array and will not read a map at all.
        /// </summary>
        [Serializable] public sealed class Grid
        {
            public float cell;
            public int stride;
            public float[] cells;
        }

        public struct Cell
        {
            public float Bearing;
            public float Speed;
            public float Band50Low;
            public float Band50High;
        }

        readonly List<Storm> storms = new List<Storm>();
        readonly Dictionary<Storm, DateTime[]> when = new Dictionary<Storm, DateTime[]>();
        readonly Dictionary<int, Cell> grid = new Dictionary<int, Cell>();
        float cellSize = 2.5f;
        Material material;
        Mesh mesh;
        readonly List<Vector3> vertices = new List<Vector3>();
        readonly List<Vector2> uvs = new List<Vector2>();
        readonly List<Vector2> kinds = new List<Vector2>();
        readonly List<Color> colours = new List<Color>();
        readonly List<int> triangles = new List<int>();
        string outlookKey;
        List<Vector2>[] outlookPaths;

        public bool HasStorms => storms.Count > 0;
        public bool HasGrid => grid.Count > 0;

        /// <summary>The observation times a storm was found in, parsed once.</summary>
        static DateTime Parse(string stamp)
        {
            // 20260917.050000
            if (string.IsNullOrEmpty(stamp) || stamp.Length < 15) return DateTime.MinValue;
            try
            {
                return new DateTime(int.Parse(stamp.Substring(0, 4)), int.Parse(stamp.Substring(4, 2)),
                    int.Parse(stamp.Substring(6, 2)), int.Parse(stamp.Substring(9, 2)),
                    int.Parse(stamp.Substring(11, 2)), int.Parse(stamp.Substring(13, 2)), DateTimeKind.Utc);
            }
            catch (Exception) { return DateTime.MinValue; }
        }

        public IEnumerator Load(string root)
        {
            yield return Text(root + "data/storms.json", text =>
            {
                try
                {
                    Bundle bundle = JsonUtility.FromJson<Bundle>(text);
                    if (bundle?.storms == null) return;
                    foreach (Storm storm in bundle.storms)
                    {
                        if (storm?.points == null || storm.points.Length < 2) continue;
                        var times = new DateTime[storm.points.Length];
                        bool sound = true;
                        for (int i = 0; i < storm.points.Length; i++)
                        {
                            times[i] = Parse(storm.points[i].time);
                            if (times[i] == DateTime.MinValue) sound = false;
                        }
                        if (!sound) continue;
                        storms.Add(storm);
                        when[storm] = times;
                    }
                }
                // A storm that will not parse leaves the globe bare, which is also what it
                // shows when none were found. It is not worth failing the page over.
                catch (Exception error) { Debug.LogWarning($"MyAtras: storms.json: {error.Message}"); }
            });
        }

        /// <summary>The grid is 116 KB and most visits never ask for it, so it waits.</summary>
        public IEnumerator LoadOutlook(string root)
        {
            if (grid.Count > 0) yield break;
            yield return Text(root + "data/tendency.json", text =>
            {
                try
                {
                    Grid read = JsonUtility.FromJson<Grid>(text);
                    if (read?.cells == null || read.cells.Length == 0) return;
                    cellSize = read.cell > 0f ? read.cell : 2.5f;
                    int stride = read.stride > 0 ? read.stride : 8;
                    for (int i = 0; i + stride <= read.cells.Length; i += stride)
                    {
                        grid[Key((int)read.cells[i], (int)read.cells[i + 1])] = new Cell
                        {
                            Bearing = read.cells[i + 2],
                            Speed = read.cells[i + 3],
                            Band50Low = read.cells[i + 4],
                            Band50High = read.cells[i + 5],
                        };
                    }
                }
                catch (Exception error) { Debug.LogWarning($"MyAtras: tendency.json: {error.Message}"); }
            });
        }

        static IEnumerator Text(string url, Action<string> onLoaded)
        {
            using (UnityWebRequest request = UnityWebRequest.Get(url))
            {
                yield return request.SendWebRequest();
                if (request.result == UnityWebRequest.Result.Success) onLoaded(request.downloadHandler.text);
                else Debug.LogWarning($"MyAtras: {url} could not be read ({request.error})");
            }
        }

        static int Key(int row, int col) => row * 1000 + col;

        public bool TendencyAt(float lat, float lon, out Cell cell)
        {
            int row = Mathf.FloorToInt((lat + 90f) / cellSize);
            int col = Mathf.FloorToInt((((lon + 180f) % 360f + 360f) % 360f) / cellSize);
            return grid.TryGetValue(Key(row, col), out cell);
        }

        /// <summary>
        /// One path forward, held a fixed angle off whatever the local tendency is, so an
        /// edge of the fan turns with the middle instead of running off straight.
        /// </summary>
        List<Vector2> Path(float lat, float lon, float offset)
        {
            var path = new List<Vector2>();
            for (int h = OutlookStepHours; h <= OutlookHours; h += OutlookStepHours)
            {
                if (!TendencyAt(lat, lon, out Cell cell)) break;
                float bearing = (cell.Bearing + offset) * Mathf.Deg2Rad;
                float km = cell.Speed * OutlookStepHours;
                lat += km * Mathf.Cos(bearing) / KmPerDegree;
                lon += km * Mathf.Sin(bearing) / (KmPerDegree * Mathf.Max(0.2f, Mathf.Cos(lat * Mathf.Deg2Rad)));
                if (Mathf.Abs(lat) > 70f) break;
                path.Add(new Vector2(lat, lon));
            }
            return path;
        }

        /// <summary>Worked out once per observation rather than once per frame.</summary>
        List<Vector2>[] Ahead(Point centre)
        {
            if (outlookKey == centre.time) return outlookPaths;
            outlookKey = centre.time;
            outlookPaths = null;
            if (TendencyAt(centre.lat, centre.lon, out Cell cell))
            {
                outlookPaths = new[]
                {
                    Path(centre.lat, centre.lon, 0f),
                    Path(centre.lat, centre.lon, cell.Band50Low),
                    Path(centre.lat, centre.lon, cell.Band50High),
                };
            }
            return outlookPaths;
        }

        static Vector3 OnGlobe(float lat, float lon, float radius)
        {
            float a = lat * Mathf.Deg2Rad, o = lon * Mathf.Deg2Rad;
            return new Vector3(radius * Mathf.Cos(a) * Mathf.Sin(o), radius * Mathf.Sin(a),
                radius * Mathf.Cos(a) * Mathf.Cos(o));
        }

        /// <summary>The shader's own camera: yaw, then pitch, seen straight on.</summary>
        static Vector3 ToView(Vector3 q, float yaw, float pitch)
        {
            float cy = Mathf.Cos(yaw), sy = Mathf.Sin(yaw), cp = Mathf.Cos(pitch), sp = Mathf.Sin(pitch);
            float x = q.x * cy - q.z * sy;
            float z = q.x * sy + q.z * cy;
            return new Vector3(x, q.y * cp - z * sp, q.y * sp + z * cp);
        }

        void Quad(Vector2 centre, float halfX, float halfY, float kind, float shade)
        {
            int at = vertices.Count;
            vertices.Add(new Vector3(centre.x - halfX, centre.y - halfY, 0f));
            vertices.Add(new Vector3(centre.x + halfX, centre.y - halfY, 0f));
            vertices.Add(new Vector3(centre.x + halfX, centre.y + halfY, 0f));
            vertices.Add(new Vector3(centre.x - halfX, centre.y + halfY, 0f));
            uvs.Add(new Vector2(0f, 0f)); uvs.Add(new Vector2(1f, 0f));
            uvs.Add(new Vector2(1f, 1f)); uvs.Add(new Vector2(0f, 1f));
            for (int i = 0; i < 4; i++)
            {
                kinds.Add(new Vector2(kind, 0f));
                colours.Add(new Color(1f, 1f, 1f, shade));
            }
            triangles.Add(at); triangles.Add(at + 1); triangles.Add(at + 2);
            triangles.Add(at); triangles.Add(at + 2); triangles.Add(at + 3);
        }

        void Band(Vector2 a, Vector2 b, Vector2 c, Vector2 d, float shade)
        {
            int at = vertices.Count;
            foreach (Vector2 p in new[] { a, b, c, d })
            {
                vertices.Add(new Vector3(p.x, p.y, 0f));
                uvs.Add(new Vector2(0.5f, 0.5f));
                kinds.Add(new Vector2(3f, 0f));
                colours.Add(new Color(1f, 1f, 1f, shade));
            }
            triangles.Add(at); triangles.Add(at + 1); triangles.Add(at + 2);
            triangles.Add(at); triangles.Add(at + 2); triangles.Add(at + 3);
        }

        /// <summary>
        /// Build and draw the marks for one observation. `shown` is the time on screen;
        /// a storm not found in it is not drawn, and the outlook is drawn only where the
        /// observations run out.
        /// </summary>
        public int Draw(DateTime shown, float yaw, float pitch, float zoom, int width, int height,
                        bool marks, bool outlook)
        {
            if (!marks || storms.Count == 0 || width <= 0 || height <= 0) return 0;
            if (material == null)
            {
                Shader shader = Shader.Find("MyAtras/StormMarks");
                if (shader == null) return 0;
                material = new Material(shader) { hideFlags = HideFlags.HideAndDontSave };
            }
            if (mesh == null) mesh = new Mesh { hideFlags = HideFlags.HideAndDontSave };

            vertices.Clear(); uvs.Clear(); kinds.Clear(); colours.Clear(); triangles.Clear();

            float scale = Mathf.Min(width, height) * zoom * 0.77f;
            float cy = Mathf.Cos(yaw), sy = Mathf.Sin(yaw), cp = Mathf.Cos(pitch), sp = Mathf.Sin(pitch);
            bool Screen(float lat, float lon, float radius, out Vector2 at)
            {
                Vector3 world = OnGlobe(lat, lon, radius);
                float depth = world.y * sp + (world.x * sy + world.z * cy) * cp;
                Vector3 view = ToView(world, yaw, pitch);
                at = new Vector2(view.x * scale / width, view.y * scale / height);
                return depth >= Front;
            }

            foreach (Storm storm in storms)
            {
                DateTime[] times = when[storm];
                int index = Array.IndexOf(times, shown);
                if (index < 0) continue;
                bool last = index == storm.points.Length - 1;

                // What was observed: unbroken and filled, every hour of it.
                for (int i = 0; i < index; i++)
                {
                    if (!Screen(storm.points[i].lat, storm.points[i].lon, Radius, out Vector2 at)) continue;
                    float shade = 0.3f + 0.7f * (i / Mathf.Max(1f, index));
                    Quad(at, 0.016f * scale / width * 0.5f, 0.016f * scale / height * 0.5f, 0f, shade);
                }
                if (Screen(storm.points[index].lat, storm.points[index].lon, Radius, out Vector2 here))
                    Quad(here, 0.052f * scale / width * 0.5f, 0.052f * scale / height * 0.5f, 1f, 1f);

                if (!outlook || !last || grid.Count == 0) continue;
                List<Vector2>[] paths = Ahead(storm.points[index]);
                if (paths == null) continue;

                // The fan first, as an area, then the broken hollow line over it.
                List<Vector2> left = paths[1], right = paths[2];
                int pairs = Mathf.Min(left.Count, right.Count);
                for (int i = 1; i < pairs; i++)
                {
                    bool ok = Screen(left[i - 1].x, left[i - 1].y, FanRadius, out Vector2 a)
                        & Screen(right[i - 1].x, right[i - 1].y, FanRadius, out Vector2 b)
                        & Screen(right[i].x, right[i].y, FanRadius, out Vector2 c)
                        & Screen(left[i].x, left[i].y, FanRadius, out Vector2 d);
                    if (!ok) continue;
                    Band(a, b, c, d, 1f - 0.5f * (i * OutlookStepHours / (float)OutlookHours));
                }
                List<Vector2> middle = paths[0];
                for (int i = 0; i < middle.Count; i++)
                {
                    int hours = (i + 1) * OutlookStepHours;
                    if (hours % DashHours != 0) continue;    // broken, not continuous
                    if (!Screen(middle[i].x, middle[i].y, Radius, out Vector2 at)) continue;
                    Quad(at, 0.022f * scale / width * 0.5f, 0.022f * scale / height * 0.5f, 2f,
                        1f - 0.4f * (hours / (float)OutlookHours));
                }
            }

            if (triangles.Count == 0) return 0;
            mesh.Clear();
            mesh.SetVertices(vertices);
            mesh.SetUVs(0, uvs);
            mesh.SetUVs(1, kinds);
            mesh.SetColors(colours);
            mesh.SetTriangles(triangles, 0);
            GL.PushMatrix();
            GL.LoadIdentity();
            GL.LoadProjectionMatrix(Matrix4x4.Ortho(-1f, 1f, -1f, 1f, -1f, 1f));
            material.SetPass(0);
            Graphics.DrawMeshNow(mesh, Matrix4x4.identity);
            GL.PopMatrix();
            return triangles.Count / 3;
        }

        /// <summary>Where the storm is in the observation on screen, for the page to say.</summary>
        public bool CentreAt(DateTime shown, out float lat, out float lon, out bool last)
        {
            lat = lon = 0f; last = false;
            foreach (Storm storm in storms)
            {
                int index = Array.IndexOf(when[storm], shown);
                if (index < 0) continue;
                lat = storm.points[index].lat;
                lon = storm.points[index].lon;
                last = index == storm.points.Length - 1;
                return true;
            }
            return false;
        }
    }
}
