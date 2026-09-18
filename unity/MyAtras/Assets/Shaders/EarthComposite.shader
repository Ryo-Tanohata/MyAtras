// The globe of the JavaScript version, ported line for line from the fragment
// shader in dist/app.js. Same analytic sphere, same rotation, same Mercator
// lookup into the observation, same uncalibrated 0.38-0.82 brightness threshold
// for the white cloud layer, same preserved watermark corner. Keeping the maths
// identical is the point: both versions must show the same observation the same
// way, so the project runs in Gamma color space and the textures are sampled raw,
// exactly as WebGL samples them.
//
// One deliberate difference: Unity textures start at the bottom row, WebGL ones at
// the top, so every sample flips V. The maths above the sample is untouched.
Shader "MyAtras/EarthComposite"
{
    Properties
    {
        _MainTex ("Background", 2D) = "black" {}
        _Earth ("Ground reference", 2D) = "white" {}
        _Weather ("Observation", 2D) = "black" {}
    }

    SubShader
    {
        Cull Off
        ZWrite Off
        ZTest Always

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // tex2Dlod needs shader model 3.0; WebGL 2.0 has it.
            #pragma target 3.0
            #include "UnityCG.cginc"

            static const float PI = 3.14159265359;
            // The latitude where the observation images stop (85.05112878 degrees).
            static const float MERCATOR_LIMIT = 1.48442223;

            sampler2D _MainTex;
            sampler2D _Earth;
            sampler2D _Weather;
            float _Yaw, _Pitch, _Zoom, _Mode, _Panels, _WeatherActive, _RawObservation;
            float2 _Watermark;

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
            };

            v2f vert(appdata_img v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.texcoord;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                float2 res = _ScreenParams.xy;
                float2 p = (i.uv * 2.0 - 1.0) * res / min(res.x, res.y);
                p /= _Zoom * 0.77;
                float rr = dot(p, p);
                float3 background = tex2D(_MainTex, i.uv).rgb;
                if (rr > 1.0)
                {
                    float halo = exp(-(sqrt(rr) - 1.0) * 25.0) * 0.11;
                    return float4(lerp(background, float3(0.25, 0.55, 0.75), halo), 1.0);
                }

                float z = sqrt(1.0 - rr);
                float3 n = float3(p.x, p.y, z);
                float cp = cos(_Pitch), sp = sin(_Pitch);
                float3 q = float3(n.x, n.y * cp + n.z * sp, -n.y * sp + n.z * cp);
                float cy = cos(_Yaw), sy = sin(_Yaw);
                q = float3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);

                // uv is in the JavaScript version's convention: v = 0 at the north pole.
                float2 uv = float2(atan2(q.x, q.z) / (2.0 * PI) + 0.5,
                                   0.5 - asin(clamp(q.y, -1.0, 1.0)) / PI);
                // Always the full-resolution level, as the WebGL version samples a texture
                // with no mipmaps. atan2 jumps from +pi to -pi at the antimeridian, so the
                // screen-space derivatives there are huge; letting the sampler pick a mip
                // from them draws a thin line down the globe along longitude 180.
                float3 color = tex2Dlod(_Earth, float4(uv.x, 1.0 - uv.y, 0.0, 0.0)).rgb;
                color = pow(color, 0.85);

                if (_WeatherActive > 0.5)
                {
                    float lat = (0.5 - uv.y) * PI;
                    if (abs(lat) < MERCATOR_LIMIT)
                    {
                        float my = 0.5 - log(tan(PI * 0.25 + lat * 0.5)) / (2.0 * PI);
                        float4 observed = tex2Dlod(_Weather, float4(uv.x, 1.0 - my, 0.0, 0.0));
                        if (_RawObservation > 0.5)
                        {
                            color = lerp(float3(0.075, 0.10, 0.13), observed.rgb, observed.a);
                        }
                        else
                        {
                            // Uncalibrated: cold land is included, warm low cloud is missed.
                            float brightness = dot(observed.rgb, float3(0.299, 0.587, 0.114));
                            float cloud = smoothstep(0.38, 0.82, brightness) * observed.a;
                            float3 composite = lerp(color, float3(0.95, 0.97, 1.0), cloud);
                            // The SSEC logo corner is drawn from the observation itself.
                            float mark = step(uv.x, _Watermark.x) * step(1.0 - _Watermark.y, my);
                            color = lerp(composite, lerp(color, observed.rgb, observed.a), mark);
                        }
                    }
                    else if (_RawObservation > 0.5)
                    {
                        color = float3(0.075, 0.10, 0.13);
                    }
                }

                float lum = 0.83 + 0.17 * z;
                if (_Mode > 0.5)
                {
                    float sun = dot(n, normalize(float3(-0.8, 0.45, 0.6)));
                    lum = 0.06 + 0.94 * smoothstep(-0.12, 0.3, sun);
                }

                float rows = 90.0;
                float cols = max(8.0, floor(180.0 * sin(uv.y * PI)));
                float2 cell = frac(float2(uv.x * cols, uv.y * rows));
                float seam = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));
                float grid = lerp(1.0, smoothstep(0.015, 0.065, seam) * 0.25 + 0.75, _Panels);
                color *= lum * grid;
                color += float3(0.12, 0.35, 0.5) * pow(1.0 - z, 3.0) * 0.20;
                return float4(color, 1.0);
            }
            ENDCG
        }
    }

    Fallback Off
}
