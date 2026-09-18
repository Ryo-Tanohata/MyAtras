using UnityEngine;

namespace MyAtras
{
    /// <summary>
    /// A table of how much air lies between a point in the atmosphere and the sun, for the
    /// globe shader's scattering: Rayleigh optical depth in red, Mie in green, in Earth
    /// radii with density 1 at the ground. Built once at start-up by integrating along
    /// each ray, it replaces a four-step march towards the sun that the shader repeated at
    /// every one of its eight steps along every line of sight - most of the cost of the
    /// atmosphere, and a large part of why the page stuttered on phones.
    ///
    /// Laid out as in Bruneton and Neyret's precomputed atmospheric scattering, for rays
    /// that reach the top of the air without meeting the ground: across, where the ray's
    /// distance to the top of the air falls between the shortest possible (straight up)
    /// and the longest (along the horizon); up, the distance to the horizon over its
    /// greatest. Spacing by distance puts the columns where the depth changes fastest, at
    /// the horizon, at every height; a table spaced evenly in angle missed by up to 0.21 in
    /// transmittance there. AirDepthCheck holds it to 0.01.
    ///
    /// The constants must match EarthComposite.shader, which draws the same air.
    /// </summary>
    public static class AirDepthTable
    {
        public const float Scale = 6f;
        public const float Top = 1f + 100f / 6371f * Scale;
        public const float RayleighHeight = 8f / 6371f * Scale;
        public const float MieHeight = 1.2f / 6371f * Scale;
        public const int Heights = 64;
        public const int Angles = 256;
        const int Steps = 160;

        /// <summary>Distance from the ground to the top of the air along the horizon.</summary>
        static float Horizon => Mathf.Sqrt(Top * Top - 1f);

        public static Texture2D Build(bool keepReadable = false)
        {
            var texture = new Texture2D(Angles, Heights, TextureFormat.RGBAHalf, false, true)
            {
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
            };
            var pixels = new Color[Angles * Heights];
            for (int y = 0; y < Heights; y++)
            {
                for (int x = 0; x < Angles; x++)
                {
                    FromTable((x + 0.5f) / Angles, (y + 0.5f) / Heights, out float height, out float mu);
                    Vector2 depth = Integrate(height, mu);
                    pixels[y * Angles + x] = new Color(depth.x, depth.y, 0f, 1f);
                }
            }
            texture.SetPixels(pixels);
            texture.Apply(false, !keepReadable);
            return texture;
        }

        /// <summary>Where a height and sun zenith cosine fall in the table, 0..1 each way.</summary>
        public static Vector2 ToTable(float height, float mu)
        {
            float r = 1f + height;
            float rho = Mathf.Sqrt(Mathf.Max(0f, r * r - 1f));
            float b = r * mu;
            float d = -b + Mathf.Sqrt(Mathf.Max(0f, b * b - (r * r - Top * Top)));
            float dMin = Top - r, dMax = rho + Horizon;
            return new Vector2(Mathf.Clamp01((d - dMin) / (dMax - dMin)), rho / Horizon);
        }

        static void FromTable(float across, float up, out float height, out float mu)
        {
            float rho = Horizon * up;
            float r = Mathf.Sqrt(rho * rho + 1f);
            float dMin = Top - r, dMax = rho + Horizon;
            float d = dMin + across * (dMax - dMin);
            mu = d <= 0f ? 1f : Mathf.Clamp((Horizon * Horizon - rho * rho - d * d) / (2f * r * d), -1f, 1f);
            height = r - 1f;
        }

        /// <summary>
        /// Rayleigh and Mie optical depth from a point at this height towards a sun at this
        /// zenith cosine, to the top of the air.
        /// </summary>
        public static Vector2 Integrate(float height, float mu, int steps = Steps)
        {
            float r = 1f + height;
            float sin = Mathf.Sqrt(Mathf.Max(0f, 1f - mu * mu));
            float b = r * mu;
            float length = -b + Mathf.Sqrt(Mathf.Max(0f, b * b - (r * r - Top * Top)));
            float dt = length / steps;
            float rayleigh = 0f, mie = 0f;
            for (int i = 0; i < steps; i++)
            {
                float t = dt * (i + 0.5f);
                float x = sin * t, y = r + mu * t;
                float h = Mathf.Sqrt(x * x + y * y) - 1f;
                rayleigh += Mathf.Exp(-h / RayleighHeight) * dt;
                mie += Mathf.Exp(-h / MieHeight) * dt;
            }
            return new Vector2(rayleigh, mie);
        }
    }
}
