// The storm marks, drawn over the finished globe.
//
// Everything arrives as quads in screen space, so one shader draws them all and the shape
// comes from the quad's own coordinates. Four kinds, and they are told apart by more than
// colour: colour alone reads as importance rather than as the difference between something
// seen and something expected, and some readers cannot separate the two hues at all.
//
//   0  where the storm has been     filled, warm, unbroken
//   1  where it is now              a thick warm ring
//   2  where it may go              a hollow cool ring, one every six hours
//   3  the fan of what past storms did   a flat cool wash, an area rather than a line
Shader "MyAtras/StormMarks"
{
    SubShader
    {
        Tags { "Queue" = "Overlay" "RenderType" = "Transparent" }
        Pass
        {
            Blend SrcAlpha OneMinusSrcAlpha
            ZTest Always
            ZWrite Off
            Cull Off

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float2 uv : TEXCOORD0;
                float2 kind : TEXCOORD1;
                fixed4 color : COLOR;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;
                float kind : TEXCOORD1;
                float shade : TEXCOORD2;
            };

            static const fixed3 SEEN = fixed3(1.0, 0.72, 0.26);
            static const fixed3 AHEAD = fixed3(0.74, 0.64, 0.98);

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                o.kind = v.kind.x;
                o.shade = v.color.a;
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                // The fan is an area: it fills its quads rather than drawing a shape in them.
                if (i.kind > 2.5) return fixed4(AHEAD, 0.16 * i.shade);

                float r = length(i.uv - 0.5) * 2.0;
                float alpha;
                if (i.kind > 1.5)
                {
                    // Expected: hollow, so there is visibly nothing inside it.
                    float ring = 1.0 - smoothstep(0.0, 0.42, abs(r - 0.62));
                    alpha = ring * 0.85 * i.shade;
                }
                else if (i.kind > 0.5)
                {
                    float ring = 1.0 - smoothstep(0.0, 0.28, abs(r - 0.72));
                    alpha = ring * 0.95;
                }
                else
                {
                    alpha = (1.0 - smoothstep(0.35, 1.0, r)) * 0.85 * i.shade;
                }
                if (alpha < 0.01) discard;
                return fixed4(i.kind > 1.5 ? AHEAD : SEEN * (i.kind > 0.5 ? 1.0 : 0.92), alpha);
            }
            ENDCG
        }
    }
}
