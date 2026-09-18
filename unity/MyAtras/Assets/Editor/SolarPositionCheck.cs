using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEditor;
using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Checks <see cref="SolarPosition"/> where the answer is known, so the day/night line
    /// on the globe can be trusted.
    ///
    ///   Unity -batchmode -quit -projectPath unity/MyAtras -executeMethod MyAtras.SolarPositionCheck.Run
    ///
    /// Exits 1 on any failure. The 2026 equinox and solstice instants are the published
    /// ones; the thirteen observation times are the same formulas evaluated independently
    /// in Python, so they catch a mistake in the port rather than in the astronomy.
    /// </summary>
    public static class SolarPositionCheck
    {
        struct Known
        {
            public string label;
            public DateTime utc;
            public float? lat;
            public float? lon;
            public float tolerance;
        }

        [MenuItem("MyAtras/Check the sun position")]
        public static void Run()
        {
            var cases = new List<Known>
            {
                At("March equinox", 2026, 3, 20, 14, 46, 0f, null, 0.05f),
                At("June solstice", 2026, 6, 21, 8, 24, 23.436f, null, 0.05f),
                At("September equinox", 2026, 9, 23, 0, 5, 0f, null, 0.05f),
            };

            // Subsolar points for the thirteen bundled observations, from the Python version.
            string[] stamps =
            {
                "20260916.090000", "20260916.100000", "20260916.110000", "20260916.120000",
                "20260916.130000", "20260916.140000", "20260916.150000", "20260916.160000",
                "20260916.170000", "20260916.180000", "20260916.190000", "20260916.200000",
                "20260916.210000",
            };
            float[,] expected =
            {
                { 2.573f, 43.722f }, { 2.557f, 28.718f }, { 2.541f, 13.714f }, { 2.525f, -1.290f },
                { 2.509f, -16.293f }, { 2.493f, -31.297f }, { 2.477f, -46.301f }, { 2.461f, -61.305f },
                { 2.445f, -76.308f }, { 2.429f, -91.312f }, { 2.412f, -106.316f }, { 2.396f, -121.319f },
                { 2.380f, -136.323f },
            };
            for (int i = 0; i < stamps.Length; i++)
            {
                DateTime utc = DateTime.ParseExact(stamps[i], "yyyyMMdd.HHmmss", CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
                cases.Add(new Known
                {
                    label = "observation " + stamps[i], utc = utc,
                    lat = expected[i, 0], lon = expected[i, 1], tolerance = 0.01f,
                });
            }

            int failures = 0;
            foreach (Known k in cases)
            {
                Vector2 got = SolarPosition.Subsolar(k.utc);
                bool ok = (!k.lat.HasValue || Mathf.Abs(got.x - k.lat.Value) <= k.tolerance)
                          && (!k.lon.HasValue || Mathf.Abs(Mathf.DeltaAngle(got.y, k.lon.Value)) <= k.tolerance);
                if (!ok) failures++;
                Debug.Log($"MyAtras sun: {(ok ? "ok  " : "FAIL")} {k.label}: " +
                          $"lat {got.x:F3} lon {got.y:F3}" +
                          (k.lat.HasValue ? $" (expected lat {k.lat.Value:F3})" : "") +
                          (k.lon.HasValue ? $" (expected lon {k.lon.Value:F3})" : ""));
            }

            // Greenwich sidereal time turns the stars. Meeus, Astronomical Algorithms,
            // examples 12.a and 12.b: 13h10m46.3668s and 8h34m57.0896s on 1987 April 10.
            failures += Sidereal("sidereal time, Meeus 12.a", new DateTime(1987, 4, 10, 0, 0, 0, DateTimeKind.Utc),
                (13 + 10 / 60.0 + 46.3668 / 3600.0) * 15.0);
            failures += Sidereal("sidereal time, Meeus 12.b", new DateTime(1987, 4, 10, 19, 21, 0, DateTimeKind.Utc),
                (8 + 34 / 60.0 + 57.0896 / 3600.0) * 15.0);

            // The direction must be in the frame the shader samples the ground texture in:
            // longitude = atan2(x, z), y towards the north pole.
            failures += Direction("sun over 0N 0E faces +z", new Vector2(0f, 0f), new Vector3(0f, 0f, 1f));
            failures += Direction("sun over 0N 90E faces +x", new Vector2(0f, 90f), new Vector3(1f, 0f, 0f));
            failures += Direction("sun over the north pole faces +y", new Vector2(90f, 0f), new Vector3(0f, 1f, 0f));

            Debug.Log(failures == 0 ? "MyAtras sun: all checks passed" : $"MyAtras sun: {failures} check(s) failed");
            if (Application.isBatchMode) EditorApplication.Exit(failures == 0 ? 0 : 1);
        }

        static Known At(string label, int y, int mo, int d, int h, int mi, float? lat, float? lon, float tolerance)
        {
            return new Known
            {
                label = label, utc = new DateTime(y, mo, d, h, mi, 0, DateTimeKind.Utc),
                lat = lat, lon = lon, tolerance = tolerance,
            };
        }

        static int Sidereal(string label, DateTime utc, double expectedDegrees)
        {
            double got = SolarPosition.GreenwichSiderealDegrees(utc);
            double error = Math.Abs(((got - expectedDegrees) % 360.0 + 540.0) % 360.0 - 180.0);
            bool ok = error < 0.001;
            Debug.Log($"MyAtras sun: {(ok ? "ok  " : "FAIL")} {label}: {got:F5} (expected {expectedDegrees:F5})");
            return ok ? 0 : 1;
        }

        static int Direction(string label, Vector2 subsolar, Vector3 expected)
        {
            Vector3 got = SolarPosition.Direction(subsolar);
            bool ok = (got - expected).magnitude < 1e-4f;
            Debug.Log($"MyAtras sun: {(ok ? "ok  " : "FAIL")} {label}: {got}");
            return ok ? 0 : 1;
        }
    }
}
