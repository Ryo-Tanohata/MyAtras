#!/usr/bin/env python3
"""Compact offline preview of the observed cloud playback, for pasting into a chat.

Writes /workspace/blue-earth.html: the same Earth fragment shader as the site, the
same 13 bundled observations downsampled, drag rotation, a time scrubber and
playback. It makes no network calls, downloads nothing and publishes nothing.

Needs Pillow:  python -m pip install Pillow
The output path is fixed on purpose; this script is not part of the browser build.
"""
import base64
import io
import json
import pathlib
import re
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - dependency is optional for the site
    raise SystemExit("Pillow is required: python -m pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
OUT = pathlib.Path("/workspace/blue-earth.html")
FRAME_PX = 256
EARTH_PX = 1024
# The SSEC logo keeps its share of the image when the image is scaled down.
WATERMARK = [54 / 512, 44 / 512]


def shaders():
    """Reuse the shipped shader source instead of keeping a second copy of it."""
    source = (DIST / "app.js").read_text(encoding="utf-8")
    found = {}
    for name in ("vs", "fs"):
        match = re.search("const " + name + "=`(.*?)`;", source, re.DOTALL)
        if not match:
            raise SystemExit("could not find the " + name + " shader in dist/app.js")
        found[name] = match.group(1)
    return found


def data_uri(image, fmt, **options):
    buffer = io.BytesIO()
    image.save(buffer, fmt, **options)
    mime = "image/jpeg" if fmt == "JPEG" else "image/png"
    return "data:%s;base64,%s" % (mime, base64.b64encode(buffer.getvalue()).decode("ascii"))


def main():
    manifest = json.loads((DIST / "weather/sequence/manifest.json").read_text(encoding="utf-8"))
    frames = []
    for frame in manifest["globalir"]:
        path = DIST / "weather/sequence" / frame["file"]
        with Image.open(path) as image:
            small = image.convert("L").resize((FRAME_PX, FRAME_PX), Image.LANCZOS)
        frames.append({"time": frame["time"], "url": data_uri(small, "PNG", optimize=True)})
        print("  %s  %s" % (frame["time"], path.name))
    with Image.open(DIST / "assets/earth.jpg") as image:
        ratio = image.height / image.width
        earth = image.convert("RGB").resize((EARTH_PX, int(EARTH_PX * ratio)), Image.LANCZOS)
    earth_uri = data_uri(earth, "JPEG", quality=78, optimize=True)

    html = TEMPLATE
    for key, value in {
        "__VS__": json.dumps(shaders()["vs"]),
        "__FS__": json.dumps(shaders()["fs"]),
        "__EARTH__": json.dumps(earth_uri),
        "__FRAMES__": json.dumps(frames, ensure_ascii=False),
        "__WATERMARK__": json.dumps(WATERMARK),
    }.items():
        html = html.replace(key, value)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print("wrote %s (%.2f MB, %d observations)" % (OUT, OUT.stat().st_size / 1e6, len(frames)))


TEMPLATE = """<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>青い地球と雲の流れ</title>
<style>
:root{color-scheme:dark;font-family:"Helvetica Neue",Arial,"Noto Sans JP",sans-serif;color:#e8eff4}
body{margin:0;background:#070c12;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px}
canvas{width:min(92vw,560px);height:min(92vw,560px);touch-action:none;cursor:grab}
.row{display:flex;align-items:center;gap:10px;width:min(92vw,560px);font-size:13px}
button{font:inherit;font-size:13px;color:#10202a;background:#c0dcde;border:0;border-radius:6px;min-height:40px;padding:8px 14px;cursor:pointer}
input[type=range]{flex:1;accent-color:#b1d3d5}
time{font-variant-numeric:tabular-nums}
p{width:min(92vw,560px);margin:0;font-size:11px;line-height:1.7;color:#8fa4b5}
label{display:flex;align-items:center;gap:6px;font-size:12px;color:#a7b7c3}
</style></head><body>
<canvas id="globe"></canvas>
<div class="row"><button id="play">❚❚ 一時停止</button><input type="range" id="scrub" min="0" max="0" value="0"><time id="stamp"></time></div>
<div class="row"><label><input type="checkbox" id="raw"> 元の白黒観測を表示</label><span id="count"></span></div>
<p>SSEC RealEarth (UW-Madison) の全球赤外線観測13時刻を順に再生しています。白い雲は観測の明るさ0.38–0.82から合成した簡易表示で、検証された雲判定ではありません。冷たい地表を雲として含み、暖かい低層雲を見落とします。地表は雲のない参考画像で、雪氷は固定です。予報ではありません。表示用に縮小した観測を同梱し、通信は行いません。</p>
<script>
const FRAMES=__FRAMES__, WATERMARK=__WATERMARK__;
const canvas=document.getElementById('globe');
const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false});
if(!gl)document.body.innerHTML='<p>WebGL対応のブラウザで開いてください。</p>';
else{
const compile=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
const program=gl.createProgram();
gl.attachShader(program,compile(gl.VERTEX_SHADER,__VS__));
gl.attachShader(program,compile(gl.FRAGMENT_SHADER,__FS__));
gl.linkProgram(program);gl.useProgram(program);
const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
const a=gl.getAttribLocation(program,'a');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
const u={};for(const k of ['resolution','yaw','pitch','zoom','mode','panels','weatherActive','rawObservation','watermark'])u[k]=gl.getUniformLocation(program,k);
gl.uniform1i(gl.getUniformLocation(program,'earth'),0);gl.uniform1i(gl.getUniformLocation(program,'weather'),1);
function texture(unit,wrap){const t=gl.createTexture();gl.activeTexture(unit);gl.bindTexture(gl.TEXTURE_2D,t);
 gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
 gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,wrap);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;}
const earthTexture=texture(gl.TEXTURE0,gl.REPEAT), weatherTexture=texture(gl.TEXTURE1,gl.CLAMP_TO_EDGE);
let ready=false,weatherReady=false;
const earth=new Image();earth.onload=()=>{gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,earthTexture);
 gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,earth);ready=true;};earth.src=__EARTH__;
const images=FRAMES.map(f=>{const i=new Image();i.src=f.url;return i;});
let index=0,playing=true,yaw=2.35,pitch=.2,zoom=1,raw=false,last=0;
const stamp=document.getElementById('stamp'),scrub=document.getElementById('scrub'),play=document.getElementById('play');
scrub.max=String(FRAMES.length-1);
document.getElementById('count').textContent=FRAMES.length+' 時刻の実観測';
const format=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function show(i){index=(i+FRAMES.length)%FRAMES.length;const image=images[index];if(!image.complete||!image.naturalWidth)return;
 gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,weatherTexture);
 gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);gl.activeTexture(gl.TEXTURE0);weatherReady=true;
 const t=FRAMES[index].time,iso=t.slice(0,4)+'-'+t.slice(4,6)+'-'+t.slice(6,8)+'T'+t.slice(9,11)+':'+t.slice(11,13)+':00Z';
 stamp.textContent=format.format(new Date(iso))+' 日本時間';scrub.value=String(index);}
play.onclick=()=>{playing=!playing;play.textContent=playing?'❚❚ 一時停止':'▶ 再生';};
scrub.oninput=e=>{playing=false;play.textContent='▶ 再生';show(Number(e.target.value));};
document.getElementById('raw').onchange=e=>{raw=e.target.checked;};
const pointers=new Map();
canvas.addEventListener('pointerdown',e=>{pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{const old=pointers.get(e.pointerId);if(!old)return;
 if(pointers.size===1){yaw-=(e.clientX-old.x)*.006;pitch=Math.max(-1.4,Math.min(1.4,pitch+(e.clientY-old.y)*.006));}
 else{const other=[...pointers.entries()].find(([id])=>id!==e.pointerId)[1];
  const before=Math.hypot(old.x-other.x,old.y-other.y),after=Math.hypot(e.clientX-other.x,e.clientY-other.y);
  if(before>0)zoom=Math.max(.65,Math.min(1.7,zoom*after/before));}
 pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});});
for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>pointers.delete(e.pointerId));
function frame(t){requestAnimationFrame(frame);if(!ready)return;
 if(playing&&t-last>700){last=t;show(index+1);}
 else if(!weatherReady)show(index);
 const dpr=Math.min(devicePixelRatio||1,2),rect=canvas.getBoundingClientRect();
 const w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);
 if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h);}
 gl.uniform2f(u.resolution,w,h);gl.uniform2f(u.watermark,WATERMARK[0],WATERMARK[1]);
 gl.uniform1f(u.yaw,yaw);gl.uniform1f(u.pitch,pitch);gl.uniform1f(u.zoom,zoom);
 gl.uniform1f(u.mode,0);gl.uniform1f(u.panels,0);
 gl.uniform1f(u.rawObservation,raw?1:0);gl.uniform1f(u.weatherActive,weatherReady?1:0);
 gl.drawArrays(gl.TRIANGLES,0,6);}
requestAnimationFrame(frame);
}
</script></body></html>
"""

if __name__ == "__main__":
    sys.exit(main())
