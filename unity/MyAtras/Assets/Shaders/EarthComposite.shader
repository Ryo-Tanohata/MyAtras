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
        _WeatherPrev ("Previous observation", 2D) = "black" {}
        _Night ("City lights", 2D) = "black" {}
        _StarMap ("Stars", 2D) = "black" {}
        _Land ("Land and coastline", 2D) = "black" {}
        _Wind ("Observed wind", 2D) = "black" {}
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
            sampler2D _WeatherPrev;
            float _Yaw, _Pitch, _Zoom, _Mode, _Panels, _WeatherActive, _RawObservation;
            // 0 shows the previous observation, 1 the current one; see ObservationPlayback.
            float _Fade;
            float2 _Watermark;
            // Sunlight at the observation's own time (SolarPosition.cs): _Sun is the
            // subsolar direction in the same frame as q below, so dot(q, _Sun) is the sine
            // of the sun's elevation at that point. Only this Unity build draws it.
            sampler2D _Night;
            float4 _Sun;
            float _Sunlight, _NightLights;
            // The Bright Star Catalogue's stars, as a map of right ascension and declination
            // (scripts/build-stars.py), turned by Greenwich sidereal time in radians.
            sampler2D _StarMap;
            float _StarsOn, _Sidereal;
            // Relief and shadows from each cloud's relative height; see CloudAt.
            float _CloudRelief;
            // Natural Earth's land (red) and coastline (green), scripts/build-land.py: an aid
            // on the night side, where land and sea would otherwise be the same black.
            sampler2D _Land;
            float _LandOn;
            // The observed wind, one texel per degree (WindField.cs): east and north in m/s,
            // how well observed. _FlowScale is degrees travelled per m/s per second on
            // screen, set from the playback speed so the flow and the clouds share a clock.
            sampler2D _Wind;
            float _FlowOn, _FlowScale;

            // Cloud-top height is exaggerated tenfold so it can be seen at all: 15 km at the
            // top of the troposphere, as an angle on the unit sphere, times ten.
            static const float CLOUD_TOP = 15.0 / 6371.0 * 10.0;

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

            // A view-space direction on the unit sphere, turned into the globe's own frame:
            // the frame the textures are sampled in and _Sun is given in.
            float3 ToGlobe(float3 n)
            {
                float cp = cos(_Pitch), sp = sin(_Pitch);
                float3 q = float3(n.x, n.y * cp + n.z * sp, -n.y * sp + n.z * cp);
                float cy = cos(_Yaw), sy = sin(_Yaw);
                return float3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);
            }

            // Where the sun is near the horizon, as a bump centred on the terminator. The
            // width is the sine of the solar elevation, about 7 degrees for 0.12.
            float Twilight(float sunSine, float width)
            {
                return exp(-(sunSine / width) * (sunSine / width));
            }

            // Cloud cover and relative cloud-top height at a point on the globe, from the two
            // observations on screen, mixed the same way as the drawn layer.
            //
            // The height is an estimate, and only a relative one. In infrared, colder shows
            // brighter, and a colder cloud top is a higher one; but these are processed
            // greyscale images with no temperature scale, so brightness can only rank cloud
            // tops against each other. It is drawn as an effect and the page says so.
            float2 CloudAt(float3 at)
            {
                float lat = asin(clamp(at.y, -1.0, 1.0));
                if (abs(lat) >= MERCATOR_LIMIT) return float2(0.0, 0.0);
                float u = atan2(at.x, at.z) / (2.0 * PI) + 0.5;
                float my = 0.5 - log(tan(PI * 0.25 + lat * 0.5)) / (2.0 * PI);
                float4 now = tex2Dlod(_Weather, float4(u, 1.0 - my, 0.0, 0.0));
                float4 was = tex2Dlod(_WeatherPrev, float4(u, 1.0 - my, 0.0, 0.0));
                float3 luma = float3(0.299, 0.587, 0.114);
                float bNow = dot(now.rgb, luma), bWas = dot(was.rgb, luma);
                float cover = lerp(smoothstep(0.38, 0.82, bWas) * was.a, smoothstep(0.38, 0.82, bNow) * now.a, _Fade);
                float height = lerp(smoothstep(0.38, 1.0, bWas) * was.a, smoothstep(0.38, 1.0, bNow) * now.a, _Fade);
                return float2(cover, height);
            }

            float Hash(float2 cell)
            {
                return frac(sin(dot(cell, float2(127.1, 311.7))) * 43758.5453);
            }

            // Flow lines along the observed wind. A grid of 3-degree cells carries one short
            // dash each, anchored at a jittered point and moving along the wind observed
            // there, fading in and out over its cycle; a pixel looks at the dashes of its own
            // cell and the eight around it. The dashes are a way of drawing the wind, not
            // particles of cloud. Where the wind texture says nothing was observed, no dash
            // is drawn at all.
            float Flow(float3 at)
            {
                const float CELL = 3.0;
                const float PERIOD = 2.5;
                float latP = degrees(asin(clamp(at.y, -1.0, 1.0)));
                float lonP = degrees(atan2(at.x, at.z));
                float shrink = max(cos(radians(latP)), 0.2);
                float2 home = floor(float2(lonP, latP) / CELL);
                float strongest = 0.0;
                for (int j = -1; j <= 1; j++)
                {
                    for (int k = -1; k <= 1; k++)
                    {
                        float2 cell = home + float2(k, j);
                        float2 anchor = (cell + 0.2 + 0.6 * float2(Hash(cell), Hash(cell + 17.0))) * CELL;
                        float4 wind = tex2Dlod(_Wind, float4((anchor.x + 180.0) / 360.0, (anchor.y + 90.0) / 180.0, 0.0, 0.0));
                        if (wind.a < 0.05) continue;
                        float2 uv = (wind.rg - 0.5) * 80.0;              // m/s, east and north
                        float speed = length(uv);
                        if (speed < 0.5) continue;
                        float2 dir = uv / speed;
                        float phase = frac(_Time.y / PERIOD + Hash(cell + 41.0));
                        float travel = speed * PERIOD * _FlowScale;       // degrees per cycle
                        // Local offsets in degrees of arc: longitude shrinks with latitude.
                        float2 offset = float2(lonP - anchor.x, latP - anchor.y);
                        offset.x = (frac(offset.x / 360.0 + 0.5) - 0.5) * 360.0 * shrink;
                        float2 head = dir * (phase - 0.5) * travel;
                        // Long and wide enough to read a direction on a phone: about 2 to 3
                        // degrees long and half a degree wide, brightest at the head.
                        float2 tail = head - dir * (0.8 * travel + 1.2);
                        float2 seg = head - tail;
                        float t = saturate(dot(offset - tail, seg) / max(dot(seg, seg), 1e-4));
                        float d = length(offset - (tail + seg * t));
                        float stroke = smoothstep(0.30 + 0.12 * t, 0.05, d) * (0.25 + 0.75 * t);
                        strongest = max(strongest, stroke * sin(3.14159 * phase) * wind.a);
                    }
                }
                return strongest;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                float2 res = _ScreenParams.xy;
                float2 p = (i.uv * 2.0 - 1.0) * res / min(res.x, res.y);
                p /= _Zoom * 0.77;
                float rr = dot(p, p);
                if (rr > 1.0)
                {
                    // Outside the sphere only the halo is drawn, as a translucent colour,
                    // exactly as the WebGL version does: the page's own background shows
                    // through. Unity asks for the same context the JavaScript globe does -
                    // alpha on, premultipliedAlpha off - so the browser composites this alpha.
                    float r = sqrt(rr);
                    float4 front;
                    if (_Sunlight > 0.5 && _RawObservation < 0.5)
                    {
                        // Atmosphere, for effect: the air above the limb glows blue where
                        // the sun is up there and warm where it is setting, and keeps only a
                        // faint edge on the night side. The sun's direction is real; the
                        // colours are not a scattering calculation.
                        float3 limb = ToGlobe(float3(p / r, 0.0));
                        float sunSine = dot(limb, _Sun.xyz);
                        float lit = smoothstep(-0.25, 0.15, sunSine);
                        float3 air = lerp(float3(0.30, 0.60, 0.95), float3(1.0, 0.55, 0.25),
                                          Twilight(sunSine, 0.18) * 0.6);
                        float alpha = exp(-(r - 1.0) * 14.0) * (0.05 + 0.40 * lit);
                        front = float4(air, saturate(alpha));
                    }
                    else
                    {
                        front = float4(0.25, 0.55, 0.75, exp(-(r - 1.0) * 25.0) * 0.11);
                    }
                    if (_StarsOn < 0.5) return front;

                    // The sky behind the Earth. Each background pixel looks out along a ray;
                    // the same rotation as the globe's turns it into the Earth's frame, and
                    // sidereal time turns longitude into right ascension, so the stars stand
                    // where they stood at the observation's time and move with a drag.
                    float3 ray = ToGlobe(normalize(float3(p * 0.55, -1.0)));
                    float ra = frac((atan2(ray.x, ray.z) + _Sidereal) / (2.0 * PI));
                    float dec = asin(clamp(ray.y, -1.0, 1.0));
                    float3 star = tex2Dlod(_StarMap, float4(ra, 0.5 + dec / PI, 0.0, 0.0)).rgb;
                    float starAlpha = saturate(max(star.r, max(star.g, star.b)));
                    float3 starColour = star / max(starAlpha, 1e-4);
                    // The air lies in front of the stars.
                    float outAlpha = front.a + starAlpha * (1.0 - front.a);
                    float3 outColour = (front.rgb * front.a + starColour * starAlpha * (1.0 - front.a))
                                       / max(outAlpha, 1e-4);
                    return float4(outColour, outAlpha);
                }

                float z = sqrt(1.0 - rr);
                float3 n = float3(p.x, p.y, z);
                float3 q = ToGlobe(n);

                // uv is in the JavaScript version's convention: v = 0 at the north pole.
                float2 uv = float2(atan2(q.x, q.z) / (2.0 * PI) + 0.5,
                                   0.5 - asin(clamp(q.y, -1.0, 1.0)) / PI);
                // Always the full-resolution level, as the WebGL version samples a texture
                // with no mipmaps. atan2 jumps from +pi to -pi at the antimeridian, so the
                // screen-space derivatives there are huge; letting the sampler pick a mip
                // from them draws a thin line down the globe along longitude 180.
                float3 color = tex2Dlod(_Earth, float4(uv.x, 1.0 - uv.y, 0.0, 0.0)).rgb;
                color = pow(color, 0.85);
                float3 ground = color;
                float cloudCover = 0.0;
                float markAmount = 0.0;
                float3 markColor = color;

                if (_WeatherActive > 0.5)
                {
                    float lat = (0.5 - uv.y) * PI;
                    if (abs(lat) < MERCATOR_LIMIT)
                    {
                        float my = 0.5 - log(tan(PI * 0.25 + lat * 0.5)) / (2.0 * PI);
                        float4 observed = tex2Dlod(_Weather, float4(uv.x, 1.0 - my, 0.0, 0.0));
                        float4 earlier = tex2Dlod(_WeatherPrev, float4(uv.x, 1.0 - my, 0.0, 0.0));
                        if (_RawObservation > 0.5)
                        {
                            float3 now = lerp(float3(0.075, 0.10, 0.13), observed.rgb, observed.a);
                            float3 was = lerp(float3(0.075, 0.10, 0.13), earlier.rgb, earlier.a);
                            color = lerp(was, now, _Fade);
                        }
                        else
                        {
                            // Uncalibrated: cold land is included, warm low cloud is missed.
                            // Each observation goes through the threshold on its own and only
                            // the drawn layers are mixed, so no in-between brightness is ever
                            // turned into cloud as if it had been observed.
                            float3 luma = float3(0.299, 0.587, 0.114);
                            float cloudNow = smoothstep(0.38, 0.82, dot(observed.rgb, luma)) * observed.a;
                            float cloudWas = smoothstep(0.38, 0.82, dot(earlier.rgb, luma)) * earlier.a;
                            float cloud = lerp(cloudWas, cloudNow, _Fade);
                            float3 cloudColour = float3(0.95, 0.97, 1.0);
                            float3 groundLit = color;
                            float sunSine = dot(q, _Sun.xyz);
                            float3 toSun = _Sun.xyz - q * sunSine;
                            float along = length(toSun);
                            if (_CloudRelief > 0.5 && _Sunlight > 0.5 && sunSine > 0.0 && along > 1e-4)
                            {
                                toSun /= along;
                                // Relief: where the cloud top falls away towards the sun it faces
                                // the sun and is lit; where it rises towards the sun it is turned
                                // away. Strongest with the sun low, as on the real thing.
                                // The slope is taken a whole observation pixel either side
                                // (512 across 360 degrees, about 0.012 radians); a finer step
                                // only traced the pixel grid and creased the clouds like paper.
                                float ahead = CloudAt(normalize(q + toSun * 0.012)).y;
                                float behind = CloudAt(normalize(q - toSun * 0.012)).y;
                                cloudColour *= clamp(1.0 - (ahead - behind) * 3.5 * (1.2 - sunSine), 0.72, 1.18);
                                // Shadow: the cloud that shades this point lies towards the sun,
                                // as far as a cloud top at about two thirds of the exaggerated
                                // height casts at this elevation. Long near the terminator,
                                // short around noon.
                                float tanElevation = sunSine / max(along, 1e-3);
                                float reach = min(CLOUD_TOP * 0.6 / max(tanElevation, 0.12), 0.12);
                                float2 caster = CloudAt(normalize(q + toSun * reach));
                                groundLit *= 1.0 - caster.x * smoothstep(0.15, 0.7, caster.y) * 0.35;
                            }
                            float3 composite = lerp(groundLit, cloudColour, cloud);
                            // The SSEC logo corner is drawn from the observation itself.
                            float mark = step(uv.x, _Watermark.x) * step(1.0 - _Watermark.y, my);
                            color = lerp(composite, lerp(color, observed.rgb, observed.a), mark);
                            cloudCover = cloud;
                            markAmount = mark;
                            markColor = lerp(ground, observed.rgb, observed.a);
                        }
                    }
                    else if (_RawObservation > 0.5)
                    {
                        color = float3(0.075, 0.10, 0.13);
                    }
                }

                if (_Sunlight > 0.5 && _RawObservation < 0.5)
                {
                    // The day side is left exactly as it was drawn above. Across the
                    // terminator - a soft band of about 6 degrees of solar elevation either
                    // side - the night side takes over: the ground falls to 5%, cloud stays
                    // faintly visible, since infrared observes it by night as by day, and
                    // the towns of NASA's Black Marble come on.
                    float day = smoothstep(-0.10, 0.10, dot(q, _Sun.xyz));
                    float3 luma = float3(0.299, 0.587, 0.114);
                    float2 at = float2(uv.x, 1.0 - uv.y);
                    // A town is a point of light and, around it, light spilling into the air -
                    // what makes cities read from orbit at all. The spill is the same image a
                    // few mip levels down (8 texels across, about 1.4 degrees), and it passes
                    // partly through cloud, lighting its underside the way cloud over a city
                    // glows orange in photographs from space; the point itself only shows
                    // where the sky is clear. The spill starts above 0.22 because Black Marble
                    // also shows moonlit land faintly - the Sahara at about 0.17 - and that is
                    // not town light: a lower threshold lit all of inland Australia.
                    float core = smoothstep(0.06, 0.7, dot(tex2Dlod(_Night, float4(at, 0.0, 0.0)).rgb, luma));
                    float spill = smoothstep(0.22, 0.6, dot(tex2Dlod(_Night, float4(at, 0.0, 3.0)).rgb, luma));
                    float3 towns = float3(1.0, 0.78, 0.48)
                                   * (core * 1.35 * (1.0 - cloudCover) + spill * 0.45 * (1.0 - cloudCover * 0.6))
                                   * _NightLights;
                    // Land and sea stay apart at night: the sea nearly black, land lifted a
                    // little, and a thin coastline, faint even under cloud, so the edges of
                    // the land can always be found. Natural Earth's coastline, not observed.
                    float3 darkGround = ground * 0.05;
                    float coastline = 0.0;
                    if (_LandOn > 0.5)
                    {
                        float2 land = tex2Dlod(_Land, float4(at, 0.0, 0.0)).rg;
                        darkGround = lerp(float3(0.006, 0.012, 0.030), ground * 0.08 + 0.015, land.r);
                        coastline = land.g;
                    }
                    float3 night = lerp(darkGround, float3(0.95, 0.97, 1.0) * 0.16, cloudCover) + towns
                                   + float3(0.45, 0.62, 0.78) * coastline * 0.30 * (1.0 - cloudCover * 0.75);
                    color = lerp(night, color, day);
                    // The SSEC logo stays readable on either side.
                    color = lerp(color, markColor, markAmount);
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
                if (_Sunlight > 0.5 && _RawObservation < 0.5)
                {
                    // Atmosphere, for effect, lit by the real sun: looking through more air
                    // towards the limb hazes the day side blue, and across the terminator,
                    // where sunlight crosses the most air, ground and cloud tops take a warm
                    // tint - cloud tops more, as they still catch the setting sun.
                    float sunSine = dot(q, _Sun.xyz);
                    float lit = smoothstep(-0.25, 0.15, sunSine);
                    // The warm light belongs to the side where the sun is still just up: the
                    // bump sits a degree above the horizon and dies away within a few degrees
                    // below it. Open ground takes little of it, cloud tops more.
                    float dusk = Twilight(sunSine - 0.02, 0.09) * smoothstep(-0.08, 0.0, sunSine);
                    float3 air = lerp(float3(0.35, 0.62, 1.0), float3(1.0, 0.5, 0.2), dusk * 0.7);
                    color += air * pow(1.0 - z, 2.5) * 0.45 * lit;
                    color += float3(1.0, 0.5, 0.2) * dusk * (0.03 + 0.18 * cloudCover);
                }
                else
                {
                    color += float3(0.12, 0.35, 0.5) * pow(1.0 - z, 3.0) * 0.20;
                }
                if (_FlowOn > 0.5)
                {
                    color = lerp(color, float3(0.72, 0.90, 1.0), Flow(q) * 0.7);
                }
                return float4(color, 1.0);
            }
            ENDCG
        }
    }

    Fallback Off
}
