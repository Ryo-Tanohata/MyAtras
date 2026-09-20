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
   out.push({centre:storm.points[i],trail:storm.points.slice(0,i+1)});
  }
  return out;
 }
}

// Drawn with the same camera the globe uses, so a centre lands on the place in the
// picture it was measured from. Points only: line width is not dependable across drivers.
class StormRenderer{
 constructor(gl,track){
  this.gl=gl;this.track=track;this.buffer=gl.createBuffer();this.data=new Float32Array(0);
  this.maxPoint=gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
  const vs=`precision highp float;
  attribute vec3 centre;attribute vec2 style;
  uniform vec2 resolution;uniform float yaw,pitch,zoom,maxPoint;
  varying float kind;varying float shade;
  vec3 toView(vec3 q){float cy=cos(yaw),sy=sin(yaw),cp=cos(pitch),sp=sin(pitch);float x=q.x*cy-q.z*sy;float z=q.x*sy+q.z*cy;return vec3(x,q.y*cp-z*sp,q.y*sp+z*cp);}
  void main(){vec3 c=toView(centre);kind=style.x;shade=style.y;float s=min(resolution.x,resolution.y)*zoom*.77;gl_Position=vec4(c.xy*s/resolution,0.,1.);gl_PointSize=min(maxPoint,(kind>.5?.052:.017)*s);}`;
  // A ring for where the storm is now, a soft dot for where it has been. Amber, because
  // the globe is white cloud on blue sea and neither reads as a mark.
  const fs=`precision highp float;
  varying float kind;varying float shade;
  void main(){vec2 d=gl_PointCoord-vec2(.5);float r=length(d)*2.;float alpha;
   if(kind>.5){float ring=1.-smoothstep(.0,.28,abs(r-.72));alpha=ring*.95;}
   else{alpha=(1.-smoothstep(.25,1.,r))*.75*shade;}
   if(alpha<.01)discard;
   gl_FragColor=vec4(vec3(1.,.72,.26)*(kind>.5?1.:.92),alpha);}`;
  const compile=(type,code)=>{const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
  this.program=gl.createProgram();gl.attachShader(this.program,compile(gl.VERTEX_SHADER,vs));gl.attachShader(this.program,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(this.program);
  if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(this.program));
  this.attributes=['centre','style'].map(k=>gl.getAttribLocation(this.program,k));
  this.uniforms={};for(const k of ['resolution','yaw','pitch','zoom','maxPoint'])this.uniforms[k]=gl.getUniformLocation(this.program,k);
 }
 /// The visible marks for one observation time: trail dots fading with age, then the ring.
 /// A point on the far side of the globe is dropped rather than drawn through the Earth.
 marks(time,yaw,pitch){
  const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const out=[];
  for(const {centre,trail} of this.track.at(time)){
   const put=(p,kind,shade)=>{
    const lat=p.lat*RAD,lon=p.lon*RAD,r=1.004;
    const x=r*Math.cos(lat)*Math.sin(lon),y=r*Math.sin(lat),z=r*Math.cos(lat)*Math.cos(lon);
    if(y*sp+(x*sy+z*cy)*cp<.02)return;                 // behind the globe
    out.push(x,y,z,kind,shade);
   };
   const n=trail.length;
   for(let i=0;i<n-1;i++){
    if((n-1-i)%2)continue;                             // every other hour: a dotted trail
    put(trail[i],0,.25+.75*(i/Math.max(1,n-1)));
   }
   put(centre,1,1);
  }
  return out;
 }
 draw({width,height,yaw,pitch,zoom,time,enabled}){
  const gl=this.gl;
  if(!enabled||!this.track.loaded)return 0;
  const marks=this.marks(time,yaw,pitch);
  if(!marks.length)return 0;
  if(this.data.length<marks.length)this.data=new Float32Array(marks.length);
  this.data.set(marks);
  const n=marks.length/5;
  gl.useProgram(this.program);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
  gl.bufferData(gl.ARRAY_BUFFER,this.data.subarray(0,marks.length),gl.DYNAMIC_DRAW);
  const sizes=[3,2],offsets=[0,12];
  for(let i=0;i<2;i++){gl.enableVertexAttribArray(this.attributes[i]);gl.vertexAttribPointer(this.attributes[i],sizes[i],gl.FLOAT,false,20,offsets[i]);}
  gl.uniform2f(this.uniforms.resolution,width,height);
  for(const [k,v] of Object.entries({yaw,pitch,zoom,maxPoint:this.maxPoint}))gl.uniform1f(this.uniforms[k],v);
  gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.POINTS,0,n);
  gl.disable(gl.BLEND);
  for(const a of this.attributes)gl.disableVertexAttribArray(a);
  return n;
 }
}
root.StormTrack=StormTrack;root.StormRenderer=StormRenderer;
if(typeof module!=='undefined')module.exports={StormTrack,StormRenderer};
})(typeof window==='undefined'?globalThis:window);
