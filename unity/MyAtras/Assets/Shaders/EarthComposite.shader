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
        _Wind ("Observed wind at the earlier observation", 2D) = "black" {}
        _WindNext ("Observed wind at the later observation", 2D) = "black" {}
        _FlowWind ("Observed wind the flow lines are drawn from", 2D) = "black" {}
        _Motion ("Cloud motion measured between the two observations", 2D) = "black" {}
        _WeatherB ("Overlaid observation at the loop's seam", 2D) = "black" {}
        _WeatherPrevB ("Overlaid previous observation at the loop's seam", 2D) = "black" {}
        _MotionB ("Cloud motion of the overlaid pair", 2D) = "black" {}
        _AirDepth ("Optical depth to the sun", 2D) = "black" {}
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
            // The observed wind, one texel per degree (scripts/wind-grid.cjs, or WindField.cs
            // as a fallback): east and north in m/s in red and green, how well observed in
            // blue. _Wind and _WindNext are the winds at the two observations on screen;
            // _FlowWind is whichever of them is nearer in time, for the flow lines.
            // _FlowScale is degrees travelled per m/s per second on screen, set from the
            // playback speed so the flow and the clouds share a clock.
            sampler2D _Wind;
            sampler2D _WindNext;
            sampler2D _FlowWind;
            float _FlowOn, _FlowScale;
            // The model between two observations (see Pair): _Advect turns it on, _Gap is
            // the time between the two observations in seconds of the atmosphere's own time.
            float _Advect, _Gap;
            // How the cloud pattern moved between the two observations, measured from them
            // (scripts/build-motion.cjs): speed east and north in red and green, spanning
            // -_MotionScale..+_MotionScale m/s, confidence in blue. Two degrees a texel.
            sampler2D _Motion;
            float _MotionOn, _MotionScale;
            // The loop's seam (ObservationPlayback): while the end of the loop is handed
            // over to its start, a second pair of observations - with its own motion - is
            // carried the same way and overlaid, _OverlayOn being its weight.
            sampler2D _WeatherB;
            sampler2D _WeatherPrevB;
            sampler2D _MotionB;
            float _OverlayOn, _AdvectB, _GapB, _MotionOnB;

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

            // ---- The model between two observations --------------------------------------
            //
            // Between an observation and the next one (hours later), the clouds are carried
            // by the wind instead of dissolved in place: the earlier observation is moved
            // forward from its time to now, the later one is moved back from its time to
            // now, and the two are crossfaded. Where the wind is right the clouds glide;
            // where it is not, what shows is close to the plain dissolve. Every step the
            // globe is back on a real observation, so the model never drifts away from what
            // was observed; what it adds is only the motion in between, and the page says so.
            //
            // Each observation still goes through the brightness threshold on its own, and
            // only the drawn layers are mixed.

            // Where nothing was observed: a textbook general circulation, east-west only.
            // Trade winds from the east near 12 degrees, westerlies peaking near 45, weak
            // polar easterlies - about the steering level of the clouds the images show.
            float2 ClimateWind(float latDeg)
            {
                float a = abs(latDeg);
                float trades = (a - 12.0) / 10.0;
                float westerlies = (a - 45.0) / 13.0;
                float polar = (a - 75.0) / 8.0;
                float east = -6.0 * exp(-trades * trades) + 14.0 * exp(-westerlies * westerlies)
                             - 3.0 * exp(-polar * polar);
                return float2(east, 0.0);
            }

            // East and north in m/s over the interval between the two observations. First
            // choice, the motion of the cloud pattern measured between the two observations
            // themselves - what carries the earlier one onto the later one best. Where that
            // could not be measured (clear sky, or no clear best match), the observed wind at
            // each of their times, averaged; where no wind was observed either, the general
            // circulation.
            float2 WindOf(float2 lonLat, sampler2D motion, float motionOn)
            {
                float4 at = float4((lonLat.x + 180.0) / 360.0, (lonLat.y + 90.0) / 180.0, 0.0, 0.0);
                float4 before = tex2Dlod(_Wind, at);
                float4 after = tex2Dlod(_WindNext, at);
                float2 climate = ClimateWind(lonLat.y);
                float2 wind = 0.5 * (lerp(climate, (before.rg - 0.5) * 80.0, saturate(before.b)) +
                                     lerp(climate, (after.rg - 0.5) * 80.0, saturate(after.b)));
                if (motionOn > 0.5)
                {
                    float4 measured = tex2Dlod(motion, at);
                    wind = lerp(wind, (measured.rg - 0.5) * 2.0 * _MotionScale, saturate(measured.b));
                }
                return wind;
            }

            // Where air that is at lonLat now was `seconds` ago (negative) or will be
            // (positive), moving with the given wind. One step: over three hours the clouds
            // move a few degrees, a few pixels of the observation.
            float2 Carried(float2 lonLat, float2 wind, float seconds)
            {
                const float EARTH = 6371000.0;
                float dLat = degrees(wind.y * seconds / EARTH);
                float dLon = degrees(wind.x * seconds / (EARTH * max(cos(radians(lonLat.y)), 0.15)));
                float2 moved = lonLat + float2(dLon, dLat);
                moved.x = frac((moved.x + 180.0) / 360.0) * 360.0 - 180.0;
                moved.y = clamp(moved.y, -89.0, 89.0);
                return moved;
            }

            // An observation at a longitude and latitude in degrees. The images are Web
            // Mercator and stop at 85.05 degrees; beyond that nothing was observed.
            float4 ObservedAt(sampler2D image, float2 lonLat)
            {
                float lat = radians(lonLat.y);
                if (abs(lat) >= MERCATOR_LIMIT) return float4(0.0, 0.0, 0.0, 0.0);
                float my = 0.5 - log(tan(PI * 0.25 + lat * 0.5)) / (2.0 * PI);
                return tex2Dlod(image, float4(lonLat.x / 360.0 + 0.5, 1.0 - my, 0.0, 0.0));
            }

            // A pair of observations at a point, carried towards each other. With the model
            // off, or on a step that does not follow on (gap 0), both are sampled in place,
            // which is the plain dissolve.
            void PairOf(sampler2D earlier, sampler2D later, sampler2D motion, float motionOn,
                        float advect, float gap, float2 lonLat, out float4 now, out float4 was)
            {
                float2 wind = WindOf(lonLat, motion, motionOn);
                float since = advect * _Fade * gap;
                float until = advect * (1.0 - _Fade) * gap;
                was = ObservedAt(earlier, Carried(lonLat, wind, -since));
                now = ObservedAt(later, Carried(lonLat, wind, until));
            }

            // The two observations on screen.
            void Pair(float2 lonLat, out float4 now, out float4 was)
            {
                PairOf(_WeatherPrev, _Weather, _Motion, _MotionOn, _Advect, _Gap, lonLat, now, was);
            }

            // The overlaid pair at the loop's seam. Where no wind was observed it falls back
            // on the other pair's observed wind; its own measured motion covers most of it.
            void PairB(float2 lonLat, out float4 now, out float4 was)
            {
                PairOf(_WeatherPrevB, _WeatherB, _MotionB, _MotionOnB, _AdvectB, _GapB, lonLat, now, was);
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
                float2 lonLat = float2(degrees(atan2(at.x, at.z)), degrees(lat));
                float4 now, was;
                Pair(lonLat, now, was);
                float3 luma = float3(0.299, 0.587, 0.114);
                float bNow = dot(now.rgb, luma), bWas = dot(was.rgb, luma);
                float cover = lerp(smoothstep(0.38, 0.82, bWas) * was.a, smoothstep(0.38, 0.82, bNow) * now.a, _Fade);
                float height = lerp(smoothstep(0.38, 1.0, bWas) * was.a, smoothstep(0.38, 1.0, bNow) * now.a, _Fade);
                if (_OverlayOn > 0.001)
                {
                    PairB(lonLat, now, was);
                    bNow = dot(now.rgb, luma); bWas = dot(was.rgb, luma);
                    float coverB = lerp(smoothstep(0.38, 0.82, bWas) * was.a, smoothstep(0.38, 0.82, bNow) * now.a, _Fade);
                    float heightB = lerp(smoothstep(0.38, 1.0, bWas) * was.a, smoothstep(0.38, 1.0, bNow) * now.a, _Fade);
                    cover = lerp(cover, coverB, _OverlayOn);
                    height = lerp(height, heightB, _OverlayOn);
                }
                return float2(cover, height);
            }

            // ---- The air, calculated -----------------------------------------------------
            //
            // Single scattering by Rayleigh (molecules) and Mie (haze), marched along each
            // view ray and towards the sun from each step - the method of Nishita et al.
            // Blue sky, the white glow of haze towards the sun and the red of sunset all
            // come out of the wavelength dependence of the coefficients below; no colour is
            // chosen by hand. Multiple scattering is left out.
            //
            // The real atmosphere, about 100 km on a 6,371 km Earth, would be a few pixels
            // at the limb on a phone. It is drawn six times as thick and one sixth as dense,
            // which keeps the optical depth straight up - and so the colour of the sky and
            // of sunlight at the ground - as it is; paths along the limb come out somewhat
            // thinner than real. Distances here are in Earth radii.
            static const float AIR_SCALE = 6.0;
            static const float AIR_TOP = 1.0 + 100.0 / 6371.0 * AIR_SCALE;
            static const float AIR_HR = 8.0 / 6371.0 * AIR_SCALE;     // Rayleigh scale height
            static const float AIR_HM = 1.2 / 6371.0 * AIR_SCALE;     // Mie scale height
            // Sea-level scattering coefficients per metre (red, green, blue for Rayleigh),
            // turned into per Earth radius and thinned by the same factor.
            static const float3 AIR_BETA_R = float3(5.8e-6, 13.5e-6, 33.1e-6) * (6371000.0 / AIR_SCALE);
            static const float AIR_BETA_M = 21e-6 * (6371000.0 / AIR_SCALE);
            static const float AIR_MIE_G = 0.76;
            // Exposure: how much sunlight goes in. It scales the brightness of the air, not
            // its colour - the colour comes from the calculation.
            static const float SUN_INTENSITY = 15.0;

            // Where a ray from o along unit d enters and leaves a sphere at the centre.
            float2 SphereHit(float3 o, float3 d, float radius)
            {
                float b = dot(o, d);
                float disc = b * b - (dot(o, o) - radius * radius);
                if (disc < 0.0) return float2(-1.0, -1.0);
                float root = sqrt(disc);
                return float2(-b - root, -b + root);
            }

            // Rayleigh and Mie optical depth from a point in the air to the sun, or -1 when
            // the Earth is in the way. Looked up in a table built once at start-up
            // (AirDepthTable.cs, laid out as Bruneton and Neyret do) instead of marched
            // here: this was four steps inside every step of every line of sight, most of
            // the cost of the air, and the table is also closer to the exact integral -
            // within 0.012 in transmittance where the march was out by up to 0.09.
            sampler2D _AirDepth;

            float2 SunDepth(float3 at, float3 sun)
            {
                float r = length(at);
                float mu = dot(at, sun) / r;
                if (mu < 0.0 && r * r * (1.0 - mu * mu) < 1.0) return float2(-1.0, -1.0);
                float horizon = sqrt(AIR_TOP * AIR_TOP - 1.0);
                float rho = sqrt(max(r * r - 1.0, 0.0));
                float b = r * mu;
                float d = -b + sqrt(max(b * b - (r * r - AIR_TOP * AIR_TOP), 0.0));
                float dMin = AIR_TOP - r, dMax = rho + horizon;
                float2 uv = float2(saturate((d - dMin) / (dMax - dMin)), rho / horizon);
                return tex2Dlod(_AirDepth, float4(uv, 0.0, 0.0)).rg;
            }

            // Light scattered towards the eye along a ray, up to tMax; transmittance is what
            // the air lets through from behind.
            float3 Scatter(float3 o, float3 d, float tMax, float3 sun, out float3 transmittance)
            {
                transmittance = 1.0;
                float2 top = SphereHit(o, d, AIR_TOP);
                if (top.y <= 0.0) return 0.0;
                float t0 = max(top.x, 0.0);
                float ds = (min(top.y, tMax) - t0) / 8.0;
                float2 viewDepth = 0.0;
                float3 sumR = 0.0, sumM = 0.0;
                for (int i = 0; i < 8; i++)
                {
                    float3 at = o + d * (t0 + ds * (i + 0.5));
                    float h = length(at) - 1.0;
                    float2 density = float2(exp(-h / AIR_HR), exp(-h / AIR_HM)) * ds;
                    viewDepth += density;
                    float2 sunDepth = SunDepth(at, sun);
                    if (sunDepth.x < 0.0) continue;            // in the shadow of the Earth
                    float3 through = exp(-(AIR_BETA_R * (viewDepth.x + sunDepth.x)
                                           + AIR_BETA_M * 1.1 * (viewDepth.y + sunDepth.y)));
                    sumR += density.x * through;
                    sumM += density.y * through;
                }
                transmittance = exp(-(AIR_BETA_R * viewDepth.x + AIR_BETA_M * 1.1 * viewDepth.y));
                float mu = dot(d, sun);
                float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
                float g = AIR_MIE_G;
                float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu))
                               / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
                return SUN_INTENSITY * (sumR * AIR_BETA_R * phaseR + sumM * AIR_BETA_M * phaseM);
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
                        float4 wind = tex2Dlod(_FlowWind, float4((anchor.x + 180.0) / 360.0, (anchor.y + 90.0) / 180.0, 0.0, 0.0));
                        // Only among observed vectors: where the wind was spread into a gap
                        // or not observed at all, no line is drawn.
                        float observed = smoothstep(0.55, 0.8, wind.b);
                        if (observed < 0.05) continue;
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
                        strongest = max(strongest, stroke * sin(3.14159 * phase) * observed);
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
                        // The air above the limb, calculated along the line of sight of this
                        // pixel (the globe is seen straight on, so every ray runs along -z).
                        float3 transmittance;
                        float3 light = 1.0 - exp(-Scatter(ToGlobe(float3(p, 3.0)), ToGlobe(float3(0.0, 0.0, -1.0)),
                                                          1e9, _Sun.xyz, transmittance));
                        // One alpha for the page behind: at least what the air adds, and at
                        // least what it takes away.
                        float alpha = saturate(max(max(light.r, max(light.g, light.b)),
                                                   1.0 - dot(transmittance, 1.0 / 3.0)));
                        front = float4(light / max(alpha, 1e-4), alpha);
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
                        float4 observed, earlier;
                        Pair(float2((uv.x - 0.5) * 360.0, degrees(lat)), observed, earlier);
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
                            if (_OverlayOn > 0.001)
                            {
                                // The loop's seam: the end of the loop and its start, each carried
                                // on in time, overlaid and handed over (ObservationPlayback).
                                // Each still goes through the threshold on its own.
                                float4 observedB, earlierB;
                                PairB(float2((uv.x - 0.5) * 360.0, degrees(lat)), observedB, earlierB);
                                float cloudB = lerp(smoothstep(0.38, 0.82, dot(earlierB.rgb, luma)) * earlierB.a,
                                                    smoothstep(0.38, 0.82, dot(observedB.rgb, luma)) * observedB.a, _Fade);
                                cloud = lerp(cloud, cloudB, _OverlayOn);
                            }
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
                    // Sunlight reaches the ground through the air, so it is reddened and
                    // dimmed on its long path near sunset; divided by what it keeps overhead,
                    // so the midday side stays as it was.
                    float2 sunPath = SunDepth(q * 1.0005, _Sun.xyz);
                    float3 overhead = exp(-(AIR_BETA_R * AIR_HR + AIR_BETA_M * 1.1 * AIR_HM));
                    color *= sunPath.x < 0.0 ? 0.0
                             : exp(-(AIR_BETA_R * sunPath.x + AIR_BETA_M * 1.1 * sunPath.y)) / overhead;
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
                    // The ground is seen through the air: dimmed by what the air takes away
                    // and hazed by what it scatters in, most towards the limb.
                    float3 o = ToGlobe(float3(p, 3.0));
                    float3 d = ToGlobe(float3(0.0, 0.0, -1.0));
                    float3 transmittance;
                    float3 light = Scatter(o, d, SphereHit(o, d, 1.0).x, _Sun.xyz, transmittance);
                    // The air reddens what sunlight it lets through. The night side holds no
                    // sunlight - its faint cloud and coastline are drawn for legibility - so
                    // there it is only dimmed, evenly, rather than tinted brown.
                    float lit = smoothstep(-0.10, 0.10, dot(q, _Sun.xyz));
                    float3 through = lerp(dot(transmittance, 1.0 / 3.0).xxx, transmittance, lit);
                    float3 seen = color * through + (1.0 - exp(-light));
                    // At the very limb a line of sight grazes the Earth through so much air
                    // that eight steps along it miss the bright layer, and the last ring of
                    // pixels came out darker than the air on both sides of it, as a dotted
                    // line. Within a few pixels of the edge it takes the brighter of itself
                    // and the air just beyond the limb, joining the two smoothly.
                    float pixel = 2.0 / (min(res.x, res.y) * _Zoom * 0.77);
                    float edge = smoothstep(1.0 - 3.0 * pixel, 1.0, sqrt(rr));
                    if (edge > 0.0)
                    {
                        float3 beyond;
                        float3 grazing = 1.0 - exp(-Scatter(o, d, 1e9, _Sun.xyz, beyond));
                        seen = lerp(seen, max(seen, grazing), edge);
                    }
                    color = seen;
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
