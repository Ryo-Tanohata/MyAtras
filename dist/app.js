'use strict';
const canvas=document.querySelector('#globe'), status=document.querySelector('#status');
const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false});
let weatherReady=false,weatherEnabled=true,rawObservation=false,showStorms=false,showOutlook=false;
// The opening view: Japan whole, from Yonaguni to Wakkanai, with sea around it.
// yaw is the longitude at the middle of the screen in radians (136°E) and pitch the
// latitude (35.5°N); the zoom keeps the islands inside the frame both on a phone held
// upright and on a wide screen. 「初期の視点に戻す」 returns here.
const HOME={yaw:2.374,pitch:.620,zoom:5};
// The opening: the whole globe, one turn eastward - Pacific, Americas, Africa, Asia -
// settling on Japan. It runs once, it never fights the viewer (the first touch, wheel,
// key or button ends it where it is), and it is skipped outright for anyone who asks
// for reduced motion, who gets the Japan view straight away.
const TURN=2*Math.PI;
// The turn is over by three quarters of the way through and the dive starts a little
// before that, so the whole globe is what turns and the close-up is the arrival.
// Turning while already zoomed in would be a blur across the surface.
const INTRO={seconds:11,zoom:.85,pitch:.22,turnBy:.75,diveFrom:.55};
const wantsIntro=typeof matchMedia==='function'&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
let intro=wantsIntro?{start:0}:null;
let yaw=intro?HOME.yaw-TURN:HOME.yaw,pitch=intro?INTRO.pitch:HOME.pitch,zoom=intro?INTRO.zoom:HOME.zoom,mode=0,panels=false,rotating=false,speed=1;
// Begun when the first observation reaches the globe, so the flight is over clouds
// rather than over a bare reference image; after four seconds regardless, in case the
// observations are slow or never arrive.
function beginIntro(){if(intro&&!intro.start)intro.start=performance.now();}
function endIntro(){intro=null;}
setTimeout(beginIntro,4000);
window.geoIntro={get running(){return !!intro;},
 skip(){if(intro){endIntro();yaw=HOME.yaw;pitch=HOME.pitch;zoom=HOME.zoom;}},home:HOME};
document.querySelector('#rotate').checked=rotating;
document.querySelector('#rawObservation').checked=rawObservation;
function fail(message){status.hidden=false;status.textContent=message;}

// What the ring means, next to the ring. Written only when it changes: the render loop
// asks every frame, and a DOM write per frame is a cost with nothing to show for it.
let stormLine='';
function showStormStatus(){
 const box=document.querySelector('#stormStatus');if(!box)return;
 if(!showStorms){box.hidden=true;stormLine='';return;}
 const track=window.geoStorms,current=window.geoWeather&&window.geoWeather.current;
 let text;
 if(!track||!track.loaded)text='台風の記録を読み込み中…';
 else{
  const found=current?track.at(current.time):[];
  const where=f=>`推定中心 ${Math.abs(f.centre.lat).toFixed(1)}°${f.centre.lat<0?'S':'N'} ${Math.abs(f.centre.lon).toFixed(1)}°${f.centre.lon<0?'W':'E'}`;
  if(!found.length)text='この観測時刻では台風を検出していません。';
  else{
   text=found.map(where).join(' / ')+' · 観測画像からの推定です。気象庁の発表でも予報でもありません。';
   // The outlook is a separate claim, so it gets its own sentence rather than being
   // folded into the one about the observation.
   if(showOutlook){
    const o=window.geoOutlook;
    if(!o||!o.grid)text+=' 見込みを読み込み中…';
    else if(found.some(f=>f.last))text+=' 紫は観測が尽きた先48時間の見込みで、過去4,759個の台風の平均です。この台風の予報ではありません。';
    else text+=' 見込みは最後の観測時刻でのみ表示します。';
   }
  }
 }
 if(text!==stormLine){stormLine=text;box.textContent=text;}
 box.hidden=false;
}
if(!gl){fail('この端末では3D表示を利用できません。WebGL対応のブラウザで開いてください。');}else{try{start();}catch(e){fail('3D表示を開始できませんでした。ページを再読み込みしてください。');console.error(e);}}
function start(){
const vs=`attribute vec2 a;varying vec2 v;void main(){v=a;gl_Position=vec4(a,0.,1.);}`;
// The observation is composited as a white layer over the ground reference texture.
// Opacity comes from an uncalibrated infrared brightness threshold: it includes cold
// land and misses warm low cloud. The source image is never modified, and the
// watermark region is drawn from the observation so the SSEC logo stays visible.
const fs=`precision highp float;varying vec2 v;uniform sampler2D earth;uniform sampler2D weather;uniform sampler2D weatherPrev;uniform float fade;uniform float weatherActive;uniform vec2 resolution;uniform float yaw,pitch,zoom,mode,panels,rawObservation;uniform vec2 watermark;uniform sampler2D detailNow,detailPrev;uniform float detailNowOn,detailPrevOn;uniform vec4 detailBox;uniform vec2 detailWatermark;uniform sampler2D simCloud;uniform float simActive;
const float PI=3.14159265359;
void main(){vec2 p=v*resolution/min(resolution.x,resolution.y);p/=zoom*.77;float rr=dot(p,p);if(rr>1.){float halo=exp(-(sqrt(rr)-1.)*25.)*.11;gl_FragColor=vec4(.25,.55,.75,halo);return;}float z=sqrt(1.-rr);vec3 n=vec3(p.x,p.y,z);float cp=cos(pitch),sp=sin(pitch);vec3 q=vec3(n.x,n.y*cp+n.z*sp,-n.y*sp+n.z*cp);float cy=cos(yaw),sy=sin(yaw);q=vec3(q.x*cy+q.z*sy,q.y,-q.x*sy+q.z*cy);vec2 uv=vec2(atan(q.x,q.z)/(2.*PI)+.5,.5-asin(clamp(q.y,-1.,1.))/PI);vec3 color=texture2D(earth,uv).rgb;color=pow(color,vec3(.85));if(weatherActive>.5){float lat=(.5-uv.y)*PI;float limit=1.48442223;if(abs(lat)<limit){float my=.5-log(tan(PI*.25+lat*.5))/(2.*PI);vec4 observed=texture2D(weather,vec2(uv.x,my));vec4 earlier=texture2D(weatherPrev,vec2(uv.x,my));vec2 du=vec2((uv.x-detailBox.x)/max(detailBox.y-detailBox.x,1e-6),(my-detailBox.z)/max(detailBox.w-detailBox.z,1e-6));float within=step(0.,du.x)*step(du.x,1.)*step(0.,du.y)*step(du.y,1.);float near=min(min(du.x,1.-du.x),min(du.y,1.-du.y));float close=within*smoothstep(0.,.02,near);float closeNow=close*detailNowOn,closeWas=close*detailPrevOn;observed=mix(observed,texture2D(detailNow,du),closeNow);earlier=mix(earlier,texture2D(detailPrev,du),closeWas);if(rawObservation>.5&&simActive<.5){vec3 now=mix(vec3(.075,.10,.13),observed.rgb,observed.a);vec3 was=mix(vec3(.075,.10,.13),earlier.rgb,earlier.a);color=mix(was,now,fade);}else{float cloudNow=smoothstep(.38,.82,dot(observed.rgb,vec3(.299,.587,.114)))*observed.a;float cloudWas=smoothstep(.38,.82,dot(earlier.rgb,vec3(.299,.587,.114)))*earlier.a;float cloud=mix(cloudWas,cloudNow,fade);vec3 white=vec3(.95,.97,1.);if(simActive>.5){cloud=texture2D(simCloud,vec2(uv.x,1.-uv.y)).r;white=mix(white,vec3(.74,.64,.98),.3);}vec3 composite=mix(color,white,cloud);float mark=step(uv.x,watermark.x)*step(1.-watermark.y,my);mark=max(mark,closeNow*step(du.x,detailWatermark.x)*step(1.-detailWatermark.y,du.y));color=mix(composite,mix(color,observed.rgb,observed.a),mark);}}else if(rawObservation>.5){color=vec3(.075,.10,.13);}}float lum=.83+.17*z;if(mode>.5){float sun=dot(n,normalize(vec3(-.8,.45,.6)));lum=.06+.94*smoothstep(-.12,.3,sun);}float rows=90.;float cols=max(8.,floor(180.*sin(uv.y*PI)));vec2 cell=fract(vec2(uv.x*cols,uv.y*rows));float seam=min(min(cell.x,1.-cell.x),min(cell.y,1.-cell.y));float grid=mix(1.,smoothstep(.015,.065,seam)*.25+.75,panels);color*=lum*grid;float rim=pow(1.-z,3.)*.20;color+=vec3(.12,.35,.5)*rim;gl_FragColor=vec4(color,1.);}`;
function shader(type,src){const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vs));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('link');gl.useProgram(program);
const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);const a=gl.getAttribLocation(program,'a');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);const uniforms={};for(const k of ['resolution','yaw','pitch','zoom','mode','panels','weatherActive','rawObservation','watermark','fade','detailNowOn','detailPrevOn','detailBox','detailWatermark','simActive'])uniforms[k]=gl.getUniformLocation(program,k);
gl.uniform1i(gl.getUniformLocation(program,'earth'),0);gl.uniform1i(gl.getUniformLocation(program,'weather'),1);gl.uniform1i(gl.getUniformLocation(program,'weatherPrev'),2);gl.uniform1i(gl.getUniformLocation(program,'detailNow'),3);gl.uniform1i(gl.getUniformLocation(program,'detailPrev'),4);gl.uniform1i(gl.getUniformLocation(program,'simCloud'),7);
function observationTexture(unit){const texture=gl.createTexture();gl.activeTexture(unit);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,0]));gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return texture;}
// Two observations are on the globe during a dissolve: the one just loaded and the
// one before it. Both are observations; nothing between them is invented.
let weatherTexture=observationTexture(gl.TEXTURE1),previousTexture=observationTexture(gl.TEXTURE2);
// The same two, for the close-up. detailNowOn/detailPrevOn say whether each one
// holds the crop of the observation being shown; when it does not, the globe keeps
// the global frame for that time rather than an older crop.
let detailTexture=observationTexture(gl.TEXTURE3),detailPrevTexture=observationTexture(gl.TEXTURE4);gl.activeTexture(gl.TEXTURE0);
const detail=new DetailLayer();window.geoDetail=detail;
// After the last observation (step two of three): the storms carried on to their end,
// with the clouds moved round them. Off unless asked for; see dist/storm-sim.js.
const stormSim=new StormSimulation(gl,7);window.geoStormSim=stormSim;
let simulate=false,typhoonModel=null,motionFields=null,simResume=null,simFrom=null,simLine='';
let detailNowOn=0,detailPrevOn=0,detailBox=[0,1,0,1],detailWatermark=[0,0];
// The close-up pair is swapped in step with the observation pair, so a dissolve mixes
// two observations at one resolution rather than two resolutions of one observation.
// A time with no crop turns the layer off for that frame; the globe then shows the
// global observation there instead of keeping an older crop on screen.
function showDetail(time){
 const image=detail.imageFor(time);
 detailPrevOn=detailNowOn;
 const spare=detailPrevTexture;detailPrevTexture=detailTexture;detailTexture=spare;
 gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,detailTexture);
 if(image){
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
  detailWatermark=[WATERMARK_PX[0]/(image.width||1),WATERMARK_PX[1]/(image.height||1)];
  const b=detail.box();if(b)detailBox=[b.u0,b.u1,b.v0,b.v1];
 }
 gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_2D,detailPrevTexture);
 gl.activeTexture(gl.TEXTURE0);
 detailNowOn=image?1:0;
}
// A crop that arrives while the globe is holding still still has to reach the screen.
function refreshDetail(){const c=window.geoWeather&&window.geoWeather.current;if(!c)return;
 if((detail.imageFor(c.time)?1:0)!==detailNowOn)showDetail(c.time);}
let detailLine='';
function showDetailStatus(){
 const note=document.querySelector('#detailNote');if(!note||!detail.manifest)return;
 const m=detail.manifest,total=m.frames.length;
 let text;
 if(!detail.enabled){
  text=`同じ観測の${m.name==='japan'?'日本付近':m.name}を切り出した高解像度版です。追加で約${detail.megabytes.toFixed(0)} MBを読み込みます。`;
 }else if(detail.loading){
  text=`高解像度の観測を読み込み中… ${detail.ready} / ${total}`;
 }else{
  // 40075 km around the Earth over 512 pixels, narrowed by the latitude: what the
  // global frames are, and what the crop is instead.
  text=`日本付近は約${m.kmPerPixel.toFixed(1)} km/画素の観測です（全球の観測は同じ緯度で約64 km/画素）。`;
  if(detail.ready<total)text+=` ${total-detail.ready}時刻は読み込めず、全球の観測のままです。`;
 }
 if(text!==detailLine){detailLine=text;note.textContent=text;}
 note.hidden=false;
}
detail.onChange=()=>{refreshDetail();showDetailStatus();};
(async()=>{
 const manifest=await detail.describe();
 const label=document.querySelector('#detailToggle'),box=document.querySelector('#detail');
 // Nothing was fetched for this build - the standalone export never carries one -
 // so the switch is not offered at all.
 if(!manifest||!label||!box)return;
 label.hidden=false;
 // The box is Japan unless someone fetched another one; the switch then says which.
 if(manifest.name&&manifest.name!=='japan'&&label.firstChild&&label.firstChild.nodeType===3){
  label.firstChild.nodeValue=manifest.name+'付近を細かく表示（高解像度の観測）';}
 box.addEventListener('change',e=>detail.setEnabled(e.target.checked));
 showDetailStatus();
})();
const fade=new ObservationFade();window.geoFade=fade;let observationsShown=0;
// SSEC stamps a fixed-size logo into the lower-left corner of every image it serves.
const WATERMARK_PX=[54,44];let watermark=[0,0];
const cloudSim=new CloudSimulation();const cloudRenderer=new CloudRenderer(gl,cloudSim);window.geoClouds=cloudSim;
// The storms found in the bundled observations. Loaded once; a failure leaves the globe
// with no marks on it, which is also what it shows when no storm was found.
const stormTrack=new StormTrack();const stormOutlook=new StormOutlook();const stormRenderer=new StormRenderer(gl,stormTrack,stormOutlook);window.geoStorms=stormTrack;window.geoOutlook=stormOutlook;stormTrack.load().then(()=>showStormStatus());
const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
let ready=false;const img=new Image();img.onload=()=>{gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,img);ready=true;status.hidden=true;};img.onerror=()=>fail('地球画像を読み込めませんでした。ページを再読み込みしてください。');img.src=window.GEO_EARTH_IMAGE||'assets/earth.jpg';
window.geoWeather=new WeatherController({onImage(image,time){const target=previousTexture;previousTexture=weatherTexture;weatherTexture=target;gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,weatherTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,previousTexture);gl.activeTexture(gl.TEXTURE0);showDetail(time);fade.matchInterval(window.geoPlayback&&window.geoPlayback.interval);fade.start(performance.now(),observationsShown>0&&!!(window.geoPlayback&&window.geoPlayback.continuing));observationsShown++;watermark=[WATERMARK_PX[0]/(image.width||1024),WATERMARK_PX[1]/(image.height||1024)];weatherReady=true;beginIntro();},onEnabled(value){weatherEnabled=value;}});const playback=new WeatherPlayback(window.geoWeather);window.geoPlayback=playback;
// Where each storm was last seen, and how it moved over the twelve hours before: what the
// typhoon object is started from. Only storms found in the last observation carry on.
function stampHours(v){const m=/^(\d{4})(\d{2})(\d{2})[._](\d{2})(\d{2})/.exec(v||'');return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5])/3600000:NaN;}
function startingStorms(time){
 const track=window.geoStorms;if(!track||!track.loaded)return [];
 return track.at(time).filter(f=>f.last).map(({centre,trail})=>{
  const now=stampHours(centre.time);
  const before=trail.slice().reverse().find(p=>now-stampHours(p.time)>=11)||trail[0];
  const hours=Math.max(1,now-stampHours(before.time));
  const dlon=((centre.lon-before.lon+540)%360)-180;
  return {lat:centre.lat,lon:centre.lon,u:dlon*111.195*Math.cos(centre.lat*Math.PI/180)/hours,v:(centre.lat-before.lat)*111.195/hours};
 });
}
playback.onLastFrame=(time,resume)=>{
 if(!simulate||!typhoonModel||!stormSim.ready||cloudSim.enabled)return false;
 const storms=startingStorms(time);
 if(!storms.length)return false;
 if(!stormSim.start({observation:weatherTexture,watermark,storms,model:typhoonModel,viewport:[canvas.width,canvas.height],air:startingAir(time)}))return false;
 simResume=resume;simFrom=time;simLine='';showSimStatus();return true;
};
// The background flow, started from the cloud motion measured over the six hours before
// the last observation. Motion from more than twelve hours earlier - after a refresh brought
// newer observations than the bundled motion - is not passed off as the last observation's:
// the flow then starts from the typical circulation, and the page says so.
function startingAir(time){
 const until=stampHours(time),recent=(motionFields||[]).filter(f=>stampHours(f.to)<=until&&until-stampHours(f.to)<=12).slice(-6);
 const start=BackgroundFlow.startingWinds(recent);const air=new BackgroundFlow.BarotropicFlow();air.setWinds(start.u,start.v);air.measured=recent.length;return air;
}
async function loadMotion(){
 const data=await window.GeoData.motion();if(!data)return [];
 const load=iv=>new Promise(resolve=>{const img=new Image();img.onload=()=>{try{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(img,0,0);const px=x.getImageData(0,0,img.width,img.height).data;resolve(Object.assign(BackgroundFlow.motionField(px,img.width,img.height,4,data.scale),{to:iv.to}));}catch(e){resolve(null);}};img.onerror=()=>resolve(null);img.src=iv.url;});
 return (await Promise.all(data.intervals.slice(-12).map(load))).filter(Boolean);
}
playback.onStop=()=>{if(stormSim.active)endSimulation(false);};
// Paused, it stays where it is: the render loop only moves it on while playback plays.
playback.onHold=()=>{simLine='';showSimStatus();};
function endSimulation(carryOn){
 stormSim.stop();const next=simResume;simResume=null;simLine='';
 const note=document.querySelector('#simulateNote');if(note&&simulate)note.textContent=simIdle();
 if(window.geoWeather.current)window.geoWeather.renderCurrent();
 if(carryOn&&next)next();
}
function simIdle(){return `観測が尽きたあと、見つけた台風を過去の台風の動き方で消滅まで進めます。強さは画像から測れないため${StormSimulation.ASSUMED_KT}ktと仮定しています。予報ではありません。`;}
// While it runs, the date says how far past the last observation it is, not a time that
// was observed.
function showSimStatus(){
 if(!stormSim.active)return;
 const h=Math.floor(stormSim.hours);
 const from=new Date(stampHours(simFrom)*3600000);
 const text=`シミュレーション +${h}時間（${new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(from)} の観測から）`;
 if(text===simLine)return;simLine=text;
 document.querySelector('#observationTime').textContent=text;
 document.querySelector('#weatherPlaybackStatus').textContent=(playback.playing?'':'一時停止 · ')+'観測の後：過去の台風の動き方で進めたシミュレーション · 予報ではありません';
 const alive=stormSim.marks().filter(m=>!m.ended).length;
 const note=document.querySelector('#simulateNote');
 const air=stormSim.air&&stormSim.air.measured?'':' 最後の観測の雲の動きを測ったデータが無いため、背景の流れは典型的な循環から始めています。';
 if(note)note.textContent=(alive?`シミュレーション中の台風 ${alive}個（紫の輪）。雲は観測ではなく計算です。`:'台風は消滅しました。まもなく最初の観測に戻ります。')+air;
}
(()=>{
 const label=document.querySelector('#simulateToggle'),box=document.querySelector('#simulateStorms'),note=document.querySelector('#simulateNote');
 // The standalone export carries no model - it would be half a megabyte more - so the
 // switch is not offered there.
 if(!label||!box||window.GEO_STANDALONE||!stormSim.ready)return;
 label.hidden=false;
 box.addEventListener('change',async e=>{
  simulate=e.target.checked;
  if(note){note.hidden=!simulate;note.textContent=simulate?'台風のデータを読み込み中…':'';}
  if(simulate&&!typhoonModel){
   const [data,motion]=await Promise.all([window.GeoData.typhoon(),loadMotion()]);
   motionFields=motion;
   if(data)typhoonModel=new Typhoon.TyphoonModel(data);
   else{if(note)note.textContent='台風のデータを読み込めませんでした。';return;}
  }
  if(!simulate&&stormSim.active)endSimulation(true);
  if(note&&simulate&&!stormSim.active)note.textContent=simIdle();
 });
})();let weatherStarted=true;
(async()=>{await window.geoWeather.init(true);if(!cloudSim.enabled&&!matchMedia('(prefers-reduced-motion: reduce)').matches)await playback.prepare(true);})().catch(()=>{document.querySelector('#weatherPlaybackStatus').textContent='読み込めませんでした。「最新を取得」を押してください。';});
document.querySelector('#rawObservation').onchange=e=>{rawObservation=e.target.checked;if(window.geoWeather.current)window.geoWeather.renderCurrent();};
document.querySelectorAll('[data-cloud-mode]').forEach(button=>button.onclick=()=>{cloudSim.enabled=button.dataset.cloudMode==='3d';if(cloudSim.enabled)playback.stop();document.querySelectorAll('[data-cloud-mode]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});document.querySelector('#cloudControls').hidden=!cloudSim.enabled;document.querySelector('#imageControls').hidden=cloudSim.enabled;if(!cloudSim.enabled){if(!weatherStarted){weatherStarted=true;window.geoWeather.init();}else if(window.geoWeather.current)window.geoWeather.renderCurrent();}else document.querySelector('#surfaceLabel').textContent='観測風による移動 · 雲の形は模型';});
let previous=0;function render(t){requestAnimationFrame(render);if(!ready||document.hidden)return;const dt=Math.min((t-previous)/1000,.05);previous=t;if(intro&&intro.start){const k=Math.min(1,(t-intro.start)/(INTRO.seconds*1000));const ease=x=>{const c=Math.min(1,Math.max(0,x));return c*c*(3.-2.*c);};const turned=ease(k/INTRO.turnBy),closed=ease((k-INTRO.diveFrom)/(1-INTRO.diveFrom));yaw=HOME.yaw-TURN*(1-turned);pitch=INTRO.pitch+(HOME.pitch-INTRO.pitch)*closed;zoom=INTRO.zoom*Math.pow(HOME.zoom/INTRO.zoom,closed);if(k>=1)endIntro();}if(rotating&&!intro&&pointers.size===0)yaw-=dt*.065*speed;const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,1.75);const w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h);}if(stormSim.active&&window.geoPlayback&&window.geoPlayback.playing){if(!stormSim.advance(dt*window.geoPlayback.hoursPerSecond,[w,h]))endSimulation(true);}if(stormSim.active)showSimStatus();gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);gl.uniform2f(uniforms.resolution,w,h);gl.uniform2f(uniforms.watermark,watermark[0],watermark[1]);for(const [k,val] of Object.entries({yaw,pitch,zoom,mode,panels:panels?1:0,rawObservation:rawObservation?1:0,fade:fade.value(t),weatherActive:weatherReady&&weatherEnabled&&!cloudSim.enabled?1:0,detailNowOn:stormSim.active?0:detailNowOn,detailPrevOn:stormSim.active?0:detailPrevOn,simActive:stormSim.active?1:0}))gl.uniform1f(uniforms[k],val);gl.uniform4f(uniforms.detailBox,detailBox[0],detailBox[1],detailBox[2],detailBox[3]);gl.uniform2f(uniforms.detailWatermark,detailWatermark[0],detailWatermark[1]);gl.drawArrays(gl.TRIANGLES,0,6);cloudSim.tick(dt);cloudRenderer.draw({width:w,height:h,yaw,pitch,zoom,mode});stormRenderer.draw({width:w,height:h,yaw,pitch,zoom,time:window.geoWeather&&window.geoWeather.current&&window.geoWeather.current.time,enabled:showStorms&&!cloudSim.enabled,outlook:showOutlook&&!stormSim.active,simulated:stormSim.active?stormSim.marks():null});if(showStorms)showStormStatus();}requestAnimationFrame(render);
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();ready=false;fail('3D表示が中断されました。ページを再読み込みしてください。');});
}
const pointers=new Map();const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));function setZoom(z){zoom=clamp(z,.65,8);}canvas.addEventListener('pointerdown',e=>{endIntro();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});canvas.setPointerCapture(e.pointerId);});canvas.addEventListener('pointermove',e=>{const old=pointers.get(e.pointerId);if(!old)return;if(pointers.size===1){yaw-=(e.clientX-old.x)*.006;pitch=clamp(pitch+(e.clientY-old.y)*.006,-1.4,1.4);}else{const other=[...pointers.entries()].find(([id])=>id!==e.pointerId)[1];const before=Math.hypot(old.x-other.x,old.y-other.y),after=Math.hypot(e.clientX-other.x,e.clientY-other.y);if(before>0)setZoom(zoom*after/before);}pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});});for(const event of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>pointers.delete(e.pointerId));canvas.addEventListener('wheel',e=>{e.preventDefault();endIntro();setZoom(zoom*Math.exp(-e.deltaY*.001));},{passive:false});canvas.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(e.key)){e.preventDefault();endIntro();}if(e.key==='ArrowLeft')yaw+=.12;if(e.key==='ArrowRight')yaw-=.12;if(e.key==='ArrowUp')pitch=clamp(pitch+.1,-1.4,1.4);if(e.key==='ArrowDown')pitch=clamp(pitch-.1,-1.4,1.4);if(e.key==='+'||e.key==='=')setZoom(zoom*1.15);if(e.key==='-')setZoom(zoom/1.15);});
document.querySelector('#smoothObservations').onchange=e=>window.geoFade.setEnabled(e.target.checked);document.querySelector('#showStorms').onchange=e=>{showStorms=e.target.checked;showStormStatus();};document.querySelector('#showOutlook').onchange=e=>{showOutlook=e.target.checked;if(showOutlook){const box=document.querySelector('#showStorms');if(!box.checked){box.checked=true;showStorms=true;}if(window.geoOutlook)window.geoOutlook.load().then(()=>showStormStatus());}showStormStatus();};document.querySelector('#panels').onchange=e=>panels=e.target.checked;document.querySelector('#rotate').onchange=e=>rotating=e.target.checked;document.querySelector('#speed').oninput=e=>{speed=Number(e.target.value);document.querySelector('#speedValue').value=speed.toFixed(1)+'×';};document.querySelector('#in').onclick=()=>{endIntro();setZoom(zoom*1.2);};document.querySelector('#out').onclick=()=>{endIntro();setZoom(zoom/1.2);};document.querySelector('#reset').onclick=()=>{endIntro();yaw=HOME.yaw;pitch=HOME.pitch;zoom=HOME.zoom;};document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=Number(b.dataset.mode);document.querySelectorAll('[data-mode]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});document.querySelector('#modeDescription').textContent=mode?'太陽光を想定した照明で、昼夜の境界を眺める。':'地球全体を照らす、発光する球体ディスプレイ。';});const full=document.querySelector('#fullscreen');if(!document.fullscreenEnabled)full.hidden=true;full.onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{full.textContent='全画面は利用できません';}};document.addEventListener('fullscreenchange',()=>full.textContent=document.fullscreenElement?'全画面を終了 ↙':'全画面 ↗');
