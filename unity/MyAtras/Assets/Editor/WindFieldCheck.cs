using UnityEditor;
using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Checks <see cref="WindField"/> on vectors whose texels are known in advance, so the
    /// flow lines point the way the wind was observed.
    ///
    ///   Unity -batchmode -quit -projectPath unity/MyAtras -executeMethod MyAtras.WindFieldCheck.Run
    ///
    /// Exits 1 on any failure.
    /// </summary>
    public static class WindFieldCheck
    {
        [MenuItem("MyAtras/Check the wind field")]
        public static void Run()
        {
            int failures = 0;
            var points = new[]
            {
                // A westerly over Tokyo (blowing east), a northerly over the mid-Atlantic
                // (blowing south), and an easterly (blowing west) just east of the
                // antimeridian, which must reach texels on the other side of it.
                new WindField.Point { lat = 35.5f, lon = 139.5f, u = 20f, v = 0f },
                new WindField.Point { lat = -10.5f, lon = -30.5f, u = 0f, v = -15f },
                new WindField.Point { lat = 0.5f, lon = -179.5f, u = -10f, v = 0f },
            };
            Texture2D field = WindField.Build(points, out int texels, keepReadable: true);

            failures += Expect("the texel on the Tokyo vector carries it", Read(field, 35.5f, 139.5f), 20f, 0f);
            failures += Expect("the texel on the Atlantic vector carries it", Read(field, -10.5f, -30.5f), 0f, -15f);
            failures += Expect("the vector at 179.5W reaches across the antimeridian", Read(field, 0.5f, 179.5f), -10f, 0f);
            failures += Empty("nothing is invented far from any vector", Read(field, 60.5f, 60.5f));
            // 4 degrees of longitude at 35.5N is 3.3 degrees of arc, beyond the 2.5 reach.
            failures += Empty("nothing is invented just beyond the reach", Read(field, 35.5f, 143.5f));
            // South must be south: a texel north of the Atlantic vector by more than the reach
            // is empty, one within it is not.
            failures += Empty("a texel 3 degrees north of the Atlantic vector is empty", Read(field, -7.5f, -30.5f));
            failures += Present("a texel 1 degree south of it is not", Read(field, -11.5f, -30.5f));

            Debug.Log($"MyAtras wind: {texels} observed texels from {points.Length} vectors");
            Debug.Log(failures == 0 ? "MyAtras wind: all checks passed" : $"MyAtras wind: {failures} check(s) failed");
            if (Application.isBatchMode) EditorApplication.Exit(failures == 0 ? 0 : 1);
        }

        /// <summary>The texel at a latitude and longitude, decoded to m/s and coverage.</summary>
        static Vector3 Read(Texture2D field, float lat, float lon)
        {
            int x = Mathf.FloorToInt(lon + 180f);
            int y = Mathf.FloorToInt(lat + 90f);
            Color32 c = field.GetPixels32()[y * WindField.Width + x];
            float Decode(byte b) => (b / 255f - 0.5f) * 2f * WindField.Scale;
            return new Vector3(Decode(c.r), Decode(c.g), c.b / 255f);
        }

        static int Expect(string label, Vector3 got, float u, float v)
        {
            bool ok = got.z > 0.5f && Mathf.Abs(got.x - u) < 0.5f && Mathf.Abs(got.y - v) < 0.5f;
            Debug.Log($"MyAtras wind: {(ok ? "ok  " : "FAIL")} {label}: u {got.x:F1} v {got.y:F1} observed {got.z:F2}");
            return ok ? 0 : 1;
        }

        static int Empty(string label, Vector3 got)
        {
            bool ok = got.z == 0f;
            Debug.Log($"MyAtras wind: {(ok ? "ok  " : "FAIL")} {label}: observed {got.z:F2}");
            return ok ? 0 : 1;
        }

        static int Present(string label, Vector3 got)
        {
            bool ok = got.z > 0f;
            Debug.Log($"MyAtras wind: {(ok ? "ok  " : "FAIL")} {label}: observed {got.z:F2}");
            return ok ? 0 : 1;
        }
    }
}
