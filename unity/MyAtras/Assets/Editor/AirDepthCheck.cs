using UnityEditor;
using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// Checks <see cref="AirDepthTable"/> the way the shader reads it - bilinear, between
    /// rows and columns - against a far finer integration, over the heights and sun angles
    /// the shader actually looks up: any point in the air, with the sun above its horizon.
    ///
    ///   Unity -batchmode -quit -projectPath unity/MyAtras -executeMethod MyAtras.AirDepthCheck.Run
    ///
    /// What matters to the picture is how much light gets through, so the error is judged
    /// on transmittance for blue light, which Rayleigh scattering takes most of, and for
    /// Mie: exp(-beta * depth) from the table against the fine integration. A relative
    /// error on the depth itself would blow up near the top of the air, where the depth is
    /// almost nothing and so is its effect.
    ///
    /// The bar is the method the table replaces - four steps towards the sun, which the
    /// shader used to march - and an absolute 0.02 (about 5 in 255). The error that remains
    /// is interpolation where the depth changes fastest, on rays just grazing the horizon;
    /// more integration steps do not move it.
    /// </summary>
    public static class AirDepthCheck
    {
        [MenuItem("MyAtras/Check the air depth table")]
        public static void Run()
        {
            Texture2D table = AirDepthTable.Build(keepReadable: true);
            float worstRayleigh = 0f, worstMie = 0f, oldRayleigh = 0f, oldMie = 0f;
            string worstAt = "";
            int checkedPoints = 0;
            var random = new System.Random(12345);
            for (int n = 0; n < 400; n++)
            {
                float v = (float)random.NextDouble();
                float height = v * v * (AirDepthTable.Top - 1f);
                float r = 1f + height;
                // The lowest the sun can be and still reach this point: its horizon.
                float horizon = -Mathf.Sqrt(Mathf.Max(0f, 1f - 1f / (r * r)));
                float mu = Mathf.Lerp(horizon + 0.03f, 1f, (float)random.NextDouble());

                Vector2 at = AirDepthTable.ToTable(height, mu);
                Color looked = table.GetPixelBilinear(at.x, at.y);
                Vector2 exact = AirDepthTable.Integrate(height, mu, 4000);
                // Scattering coefficients per Earth radius, thinned as in the shader.
                float blue = 33.1e-6f * 6371000f / AirDepthTable.Scale;
                float mieExtinction = 21e-6f * 6371000f / AirDepthTable.Scale * 1.1f;
                float errR = Mathf.Abs(Mathf.Exp(-blue * looked.r) - Mathf.Exp(-blue * exact.x));
                float errM = Mathf.Abs(Mathf.Exp(-mieExtinction * looked.g) - Mathf.Exp(-mieExtinction * exact.y));
                Vector2 marched = AirDepthTable.Integrate(height, mu, 4);
                oldRayleigh = Mathf.Max(oldRayleigh, Mathf.Abs(Mathf.Exp(-blue * marched.x) - Mathf.Exp(-blue * exact.x)));
                oldMie = Mathf.Max(oldMie, Mathf.Abs(Mathf.Exp(-mieExtinction * marched.y) - Mathf.Exp(-mieExtinction * exact.y)));
                if (errR > worstRayleigh) { worstRayleigh = errR; worstAt = $"height {height * 6371f / AirDepthTable.Scale:F1} km, sun zenith {Mathf.Acos(mu) * Mathf.Rad2Deg:F1} deg"; }
                worstMie = Mathf.Max(worstMie, errM);
                checkedPoints++;
            }

            bool ok = worstRayleigh < 0.02f && worstMie < 0.02f && worstRayleigh < oldRayleigh && worstMie < oldMie;
            Debug.Log($"MyAtras air: {checkedPoints} points; largest transmittance error, table: blue Rayleigh {worstRayleigh:F4} ({worstAt}), Mie {worstMie:F4}");
            Debug.Log($"MyAtras air: the four-step march it replaces: blue Rayleigh {oldRayleigh:F4}, Mie {oldMie:F4}");
            Debug.Log(ok ? "MyAtras air: all checks passed" : "MyAtras air: the table is not good enough");
            if (Application.isBatchMode) EditorApplication.Exit(ok ? 0 : 1);
        }
    }
}
