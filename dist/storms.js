'use strict';
// The storms found in the bundled observations, drawn on the globe.
//
// scripts/find-storms.cjs writes dist/data/storms.json: for each tropical cyclone it
// found, the centre of its cold cloud at every observation time. This puts a ring on
// that centre for the observation currently on screen, and a trail behind it for where
// the storm has already been, so the three days of playback read as one storm crossing
// the ocean rather than a white smudge that moves.
//
// What is drawn is a measurement of the pictures, not a storm position in the sense a
// forecaster means: the centre of the cold cloud is the centre of the storm only while
// the storm is organised, and nothing here says when it is. There is no forecast in it -
// the trail stops at the observation on screen and the ring never goes past the last
// observation. The page says both, and the label on the switch says the shorter of them.
(function(root){
const RAD=Math.PI/180;
function parseStamp(value){const m=/^(\d{4})(\d{2})(\d{2})[._](\d{2})(\d{2})(\d{2})$/.exec(value||'');return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]):null;}

// The bundled storms, and what to draw for a given observation time.
class StormTrack{
 constructor(){this.storms=[];this.loaded=false;}
 async load(){
  if(this.loaded)return this.storms;
  let bundle=null;
  try{bundle=root.GEO_STORMS||(root.GeoData?await root.GeoData.storms():null);}catch(error){bundle=null;}
  // A missing or unreadable file is not an error worth stopping the page for: the globe
  // simply shows no storms, which is also what it shows when none were found.
  this.storms=(bundle&&Array.isArray(bundle.storms)?bundle.storms:[]).map(s=>({
   from:s.from,to:s.to,
   points:(s.points||[]).map(p=>({time:p.time,at:parseStamp(p.time),lat:p.lat,lon:p.lon,circ:p.circ})).filter(p=>p.at!==null),
  })).filter(s=>s.points.length>1);
  this.loaded=true;
  return this.storms;
 }
 /// Every storm that has a centre at exactly this observation time, with the part of its
 /// track up to it. Exactly: an observation the storm was not found in draws nothing,
 /// rather than a centre interpolated from the hours either side of it.
 at(time){
  const when=parseStamp(time);
  if(when===null)return [];
  const out=[];
  for(const storm of this.storms){
   const i=storm.points.findIndex(p=>p.at===when);
   if(i<0)continue;
   out.push({centre:storm.points[i],trail:storm.points.slice(0,i+1),last:i===storm.points.length-1});
  }
  return out;
 }
}

// Where a storm would go next if it behaved like the ones before it. Built from
// dist/data/tendency.json: the median heading and pace of 4,759 past cyclones, cell by
// cell, with how widely they differed. It knows nothing of this storm or of this week's
// weather, so it is drawn only past the last observation, never over one, and the page
// says what it is. The spread is drawn too: through the turn near Japan barely half of
// past storms ran within 45 degrees of the middle, and a line without a fan around it
// would claim a certainty that the record does not support.
class StormOutlook{
 constructor(){this.grid=null;this.tried=false;}
 async load(){
  if(this.tried)return this.grid;
  this.tried=true;
  try{this.grid=root.GEO_TENDENCY||(root.GeoData?await root.GeoData.tendency():null);}catch(error){this.grid=null;}
  if(this.grid&&!Array.isArray(this.grid.cells))this.grid=null;
  this.lookup=null;
  return this.grid;
 }
 /// The flat list read back as a lookup, once. Flat because Unity's JsonUtility reads a
 /// number array and will not read a map, and both versions read the same file.
 index(){
  const stride=this.grid.stride||8, cells=this.grid.cells, map=new Map();
  for(let i=0;i+stride<=cells.length;i+=stride)
   map.set(cells[i]+','+cells[i+1],{bearing:cells[i+2],speed:cells[i+3],
     band50:[cells[i+4],cells[i+5]],band80:[cells[i+6],cells[i+7]]});
  this.lookup=map;
 }
 at(lat,lon){
  if(!this.grid)return null;
  if(!this.lookup)this.index();
  const row=Math.floor((lat+90)/this.grid.cell);
  const col=Math.floor(((((lon+180)%360)+360)%360)/this.grid.cell);
  return this.lookup.get(row+','+col)||null;
 }
 /// One path forward, held `offset` degrees off whatever the local tendency is, so an
 /// edge of the fan turns with the middle instead of running off straight.
 path(lat,lon,hours,offset){
  const out=[],STEP=3;
  for(let h=STEP;h<=hours;h+=STEP){
   const t=this.at(lat,lon); if(!t)break;
   const b=(t.bearing+offset)*RAD, d=t.speed*STEP;
   lat+=d*Math.cos(b)/111.195;
   lon+=d*Math.sin(b)/(111.195*Math.max(.2,Math.cos(lat*RAD)));
   if(Math.abs(lat)>70)break;
   out.push({lat,lon,hours:h});
  }
  return out;
 }
 /// The middle and the edges of the half of past storms that stayed closest to it.
 ahead(lat,lon,hours=48){
  const t=this.at(lat,lon); if(!t)return null;
  return {middle:this.path(lat,lon,hours,0),
    left:this.path(lat,lon,hours,t.band50[0]),
    right:this.path(lat,lon,hours,t.band50[1]),
    spread:t.band50[1]-t.band50[0]};
 }
}

// Drawn with the same camera the globe uses, so a centre lands on the place in the
// picture it was measured from. Points only: line width is not dependable across drivers.
class StormRenderer{
 constructor(gl,track,outlook){
  this.gl=gl;this.track=track;this.outlook=outlook||null;this.buffer=gl.createBuffer();this.data=new Float32Array(0);
  this.maxPoint=gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
  const vs=`precision highp float;
  attribute vec3 centre;attribute vec2 style;
  uniform vec2 resolution;uniform float yaw,pitch,zoom,maxPoint;
  varying float kind;varying float shade;
  vec3 toView(vec3 q){float cy=cos(yaw),sy=sin(yaw),cp=cos(pitch),sp=sin(pitch);float x=q.x*cy-q.z*sy;float z=q.x*sy+q.z*cy;return vec3(x,q.y*cp-z*sp,q.y*sp+z*cp);}
  void main(){vec3 c=toView(centre);kind=style.x;shade=style.y;float s=min(resolution.x,resolution.y)*zoom*.77;
   float size=kind>2.5?.052:(kind>1.5?.022:(kind>.5?.052:.016));
   gl_Position=vec4(c.xy*s/resolution,0.,1.);gl_PointSize=min(maxPoint,size*s);}`;
  // A ring for where the storm is now, a soft dot for where it has been - amber, because
  // the globe is white cloud on blue sea and neither reads as a mark. What is only
  // expected, never observed, is a different colour entirely: nothing about the outlook
  // should read as part of the same statement as the ring.
  const fs=`precision highp float;
  varying float kind;varying float shade;
  const vec3 SEEN=vec3(1.,.72,.26);
  const vec3 AHEAD=vec3(.74,.64,.98);
  void main(){
   // The fan is an area, and areas are not points: it arrives as triangles, where
   // gl_PointCoord means nothing.
   if(kind>3.5){gl_FragColor=vec4(AHEAD,.16*shade);return;}
   vec2 d=gl_PointCoord-vec2(.5);float r=length(d)*2.;float alpha;
   if(kind>1.5){float ring=1.-smoothstep(.0,.42,abs(r-.62));alpha=ring*.85*shade;}
   else if(kind>.5){float ring=1.-smoothstep(.0,.28,abs(r-.72));alpha=ring*.95;}
   else{alpha=(1.-smoothstep(.35,1.,r))*.85*shade;}
   if(alpha<.01)discard;
   gl_FragColor=vec4(kind>1.5?AHEAD:SEEN*(kind>.5?1.:.92),alpha);}`;
  const compile=(type,code)=>{const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
  this.program=gl.createProgram();gl.attachShader(this.program,compile(gl.VERTEX_SHADER,vs));gl.attachShader(this.program,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(this.program);
  if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(this.program));
  this.attributes=['centre','style'].map(k=>gl.getAttribLocation(this.program,k));
  this.uniforms={};for(const k of ['resolution','yaw','pitch','zoom','maxPoint'])this.uniforms[k]=gl.getUniformLocation(this.program,k);
 }
 /// The visible marks for one observation time: trail dots fading with age, then the ring.
 /// A point on the far side of the globe is dropped rather than drawn through the Earth.
 marks(time,yaw,pitch,outlookOn){
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const out=[],fan=[];
  for(const {centre,trail,last} of this.track.at(time)){
   const put=(p,kind,shade)=>{
    const lat=p.lat*RAD,lon=p.lon*RAD,r=1.004;
    const x=r*Math.cos(lat)*Math.sin(lon),y=r*Math.sin(lat),z=r*Math.cos(lat)*Math.cos(lon);
    if(y*sp+(x*sy+z*cy)*cp<.02)return;                 // behind the globe
    out.push(x,y,z,kind,shade);
   };
   // What was observed is drawn unbroken and filled: every hour of it, so it reads as a
   // line rather than as a suggestion.
   const n=trail.length;
   for(let i=0;i<n-1;i++) put(trail[i],0,.3+.7*(i/Math.max(1,n-1)));
   put(centre,1,1);
   // Only once the observations have run out. Drawing this over an hour the globe is
   // about to show would be putting a guess where an observation already is.
   //
   // And drawn so that nothing about it can be mistaken for the line behind it: a cool
   // colour instead of a warm one, hollow instead of filled, broken every six hours
   // instead of continuous, and with the fan of what past storms actually did drawn as an
   // area around it. Colour alone would not do - it is read as importance, not as the
   // difference between something seen and something expected, and some readers cannot
   // separate the two hues at all.
   if(outlookOn&&last&&this.outlook&&this.outlook.grid){
    const ahead=this.cached(centre);
    if(ahead){
     for(const p of ahead.middle){ if(p.hours%6===0) put(p,2,1-.4*(p.hours/48)); }
     this.fanOf(ahead,fan,sy,cy,sp,cp);
    }
   }
  }
  return {points:out,fan};
 }
 /// The half of past storms that stayed nearest the middle, as an area rather than two
 /// edges: a band has a width, and a width is what tells a range from a track.
 fanOf(ahead,fan,sy,cy,sp,cp){
  const xyz=p=>{const lat=p.lat*RAD,lon=p.lon*RAD,r=1.003;
   return [r*Math.cos(lat)*Math.sin(lon),r*Math.sin(lat),r*Math.cos(lat)*Math.cos(lon)];};
  const front=q=>q[1]*sp+(q[0]*sy+q[2]*cy)*cp>=.02;
  const n=Math.min(ahead.left.length,ahead.right.length);
  let prevL=null,prevR=null;
  for(let i=0;i<n;i++){
   const l=xyz(ahead.left[i]),r=xyz(ahead.right[i]);
   if(prevL&&front(l)&&front(r)&&front(prevL)&&front(prevR)){
    const shade=1-.5*(ahead.left[i].hours/48);
    for(const q of [prevL,prevR,l, prevR,r,l]) fan.push(q[0],q[1],q[2],4,shade);
   }
   prevL=l;prevR=r;
  }
 }
 /// The outlook changes only when the observation does, so it is worked out once per
 /// observation rather than once per frame.
 cached(centre){
  if(!this.memo||this.memo.time!==centre.time){
   this.memo={time:centre.time,ahead:this.outlook.ahead(centre.lat,centre.lon,48)};
  }
  return this.memo.ahead;
 }
 // simulated: storms carried on past the last observation (dist/storm-sim.js). Drawn in
 // the colour of what is only expected, hollow: a large ring where the storm is in the
 // simulation, small ones every six hours along where it is going. The amber ring at the
 // last observed position stays - it is where what was seen stops.
 draw({width,height,yaw,pitch,zoom,time,enabled,outlook,simulated}){
  const gl=this.gl;
  const seen=enabled&&this.track.loaded?this.marks(time,yaw,pitch,outlook):{points:[],fan:[]};
  const points=seen.points.slice(),fan=seen.fan;
  if(simulated&&simulated.length){
   const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
   const put=(p,kind,shade)=>{
    const lat=p.lat*RAD,lon=p.lon*RAD,r=1.004;
    const x=r*Math.cos(lat)*Math.sin(lon),y=r*Math.sin(lat),z=r*Math.cos(lat)*Math.cos(lon);
    if(y*sp+(x*sy+z*cy)*cp<.02)return;
    points.push(x,y,z,kind,shade);
   };
   for(const s of simulated){
    for(const p of s.ahead)put(p,2,.8);
    put(s.now,3,s.ended?Math.max(.2,s.now.fade):1);
   }
  }
  if(!points.length&&!fan.length)return 0;
  gl.useProgram(this.program);
  gl.uniform2f(this.uniforms.resolution,width,height);
  for(const [k,v] of Object.entries({yaw,pitch,zoom,maxPoint:this.maxPoint}))gl.uniform1f(this.uniforms[k],v);
  gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  const send=(values,mode)=>{
   if(!values.length)return 0;
   if(this.data.length<values.length)this.data=new Float32Array(values.length);
   this.data.set(values);
   gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
   gl.bufferData(gl.ARRAY_BUFFER,this.data.subarray(0,values.length),gl.DYNAMIC_DRAW);
   const sizes=[3,2],offsets=[0,12];
   for(let i=0;i<2;i++){gl.enableVertexAttribArray(this.attributes[i]);gl.vertexAttribPointer(this.attributes[i],sizes[i],gl.FLOAT,false,20,offsets[i]);}
   gl.drawArrays(mode,0,values.length/5);
   return values.length/5;
  };
  const drawn=send(fan,gl.TRIANGLES)+send(points,gl.POINTS);   // the area first, marks over it
  gl.disable(gl.BLEND);
  for(const a of this.attributes)gl.disableVertexAttribArray(a);
  return drawn;
 }
}
root.StormTrack=StormTrack;root.StormRenderer=StormRenderer;root.StormOutlook=StormOutlook;
if(typeof module!=='undefined')module.exports={StormTrack,StormRenderer,StormOutlook};
})(typeof window==='undefined'?globalThis:window);
