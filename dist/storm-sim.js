'use strict';
// What happens after the last observation: every storm the observations found, carried on
// by dist/typhoon.js until it dies, with the clouds moving round it.
//
// Steps two and three of three. The clouds on screen are the last observation's clouds,
// moved by three things added together:
// - the background flow (dist/background-flow.js): the motion the observations last
//   showed, carried on by the vorticity equation so troughs and ridges travel and
//   meander. Without it - with the typical circulation by latitude alone, as step two
//   had it - every cloud in the westerlies was drawn out into an east-west streak;
// - near each storm, the storm's own motion, so its cloud goes where it goes;
// - the storm's spin - anticlockwise in the north, clockwise in the south - fastest a
//   little way out from the centre and weaker further out, with a slight inflow.
// Around each centre cloud builds in proportion to the storm's strength: a dense core and
// two spiral bands of a typical pitch. The spin alone was meant to make the bands - cloud
// nearer the centre goes round faster - but cloud that is built evenly has no pattern to
// wind, and the first try showed only a small white dot. The spin winds the bands on,
// and the observed cloud near the storm with them. When the storm ends the cloud stops
// being made and thins away, and everything slowly tends to the average cloudiness of
// its latitude.
//
// The observation is not pushed along frame by frame. Every resampling softens an image a
// little, and a hundred of them a second leave only fog - the first version did exactly
// that. What is carried along instead is, for every point, where its air was at the last
// observation; the clouds are then read from the observation once, at that place. The
// map of where things came from is smooth, so carrying it costs nothing visible, and the
// cloud keeps the observation's own detail however long the scene runs. The storm's own
// cloud, which is built rather than observed, is carried the ordinary way.
//
// Not an observation and not a forecast. The strength of a storm cannot be read from these
// images (the eye is smaller than a pixel), so every storm starts at ASSUMED_KT.
//
// Values are held at 16 bits in two 8-bit channels: at 8 bits the slow changes round away
// to nothing, and half-float textures cannot be counted on in a phone's browser.
(function (root) {
  const W = 1024, H = 512;
  const ASSUMED_KT = 80;          // a typhoon, since strength cannot be measured here
  const MAX_STORMS = 4;
  const AFTER_END_HOURS = 18;     // the scene keeps running at least this long after the last storm ends
  // How long the scene runs, storms or none: long enough that the clouds are seen to move
  // on from the last observation rather than being snatched back to the first. Longer, and
  // the clouds carried this far lose the observation's detail (see RELAX_HOURS).
  const HORIZON_HOURS = 120;
  const MAX_HOURS = 240;
  const STEP_HOURS = 0.5;         // the largest step things are moved by at once
  const RELAX_HOURS = 240;        // how slowly the clouds tend to their latitude's average
  const MAX_START_KMH = 45;       // a faster start is a detection hopping between systems
  const FLOW_STEP_HOURS = 2;      // how often the background flow is moved on
  const FLICKER = { amp: 0.55, cell: 1.8, tau: 1.5, birth: 0.05 };

  const VERTEX = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  const COMMON = `precision highp float;
  const float PI=3.14159265359;const float KM=111.195;
  uniform vec2 size;
  vec2 pack(float c){c=clamp(c,0.,1.)*255.;float hi=floor(c);return vec2(hi/255.,fract(c));}
  float unpack2(vec2 t){return t.x+t.y/255.;}
  float unpack(vec4 t){return unpack2(t.rg);}
  vec2 wrapUV(vec2 uv){return vec2(fract(uv.x),clamp(uv.y,0.,1.));}
  // Four texels by hand: a packed value cannot be filtered by the hardware.
  vec4 taps(sampler2D f,vec2 uv,out vec2 w,out vec2 a,out vec2 b,out vec2 c,out vec2 d){
   vec2 p=uv*size-.5;vec2 i=floor(p);w=p-i;
   a=wrapUV((i+.5)/size);b=wrapUV((i+vec2(1.,0.)+.5)/size);c=wrapUV((i+vec2(0.,1.)+.5)/size);d=wrapUV((i+1.5)/size);
   return vec4(0.);}
  float field(sampler2D f,vec2 uv){vec2 w,a,b,c,d;taps(f,uv,w,a,b,c,d);
   return mix(mix(unpack(texture2D(f,a)),unpack(texture2D(f,b)),w.x),mix(unpack(texture2D(f,c)),unpack(texture2D(f,d)),w.x),w.y);}
  // A displacement in degrees, lon in rg over +-180 and lat in ba over +-90.
  vec2 decodeD(vec4 t){return vec2(unpack2(t.rg)*360.-180.,unpack2(t.ba)*180.-90.);}
  vec4 encodeD(vec2 d){d.x=mod(d.x+180.,360.)-180.;return vec4(pack((d.x+180.)/360.),pack((d.y+90.)/180.));}
  vec2 displacement(sampler2D f,vec2 uv){vec2 w,a,b,c,d;taps(f,uv,w,a,b,c,d);
   return mix(mix(decodeD(texture2D(f,a)),decodeD(texture2D(f,b)),w.x),mix(decodeD(texture2D(f,c)),decodeD(texture2D(f,d)),w.x),w.y);}
  // The background flow, km/h east and north, on its 128 x 64 grid: 16 bits a component
  // over +-400, so filtered by hand.
  uniform sampler2D background;
  vec2 decodeW(vec4 t){return vec2(unpack2(t.rg),unpack2(t.ba))*800.-400.;}
  vec2 backgroundWind(float lat,float lon){
   vec2 s=vec2(128.,64.);vec2 p=vec2((lon+180.)/360.,(lat+90.)/180.)*s-.5;vec2 i=floor(p);vec2 w=p-i;
   vec2 a=(i+.5)/s,b=(i+vec2(1.,0.)+.5)/s,c=(i+vec2(0.,1.)+.5)/s,d=(i+1.5)/s;
   a.y=clamp(a.y,.5/s.y,1.-.5/s.y);b.y=a.y;c.y=clamp(c.y,.5/s.y,1.-.5/s.y);d.y=c.y;
   return mix(mix(decodeW(texture2D(background,a)),decodeW(texture2D(background,b)),w.x),
              mix(decodeW(texture2D(background,c)),decodeW(texture2D(background,d)),w.x),w.y);}
  uniform vec4 storm[${MAX_STORMS}];uniform vec4 motion[${MAX_STORMS}];uniform float count;
  // The wind at a point in km/h, and how much storm cloud is being made there.
  vec2 wind(float lat,float lon,out float source){
   vec2 vel=backgroundWind(lat,lon);vec2 swirl=vec2(0.);source=0.;
   for(int i=0;i<${MAX_STORMS};i++){if(float(i)>=count)break;
    float dlon=mod(lon-storm[i].y+540.,360.)-180.;
    vec2 d=vec2(dlon*KM*cos(radians(lat)),(lat-storm[i].x)*KM);float r=max(length(d),1.);
    float s=storm[i].z,R=storm[i].w;
    vel=mix(vel,motion[i].xy,exp(-(r*r)/(900.*900.))*motion[i].z);
    float vt=s*80.*(r<R?r/R:pow(R/r,.6));
    float hemi=storm[i].x>=0.?1.:-1.;
    swirl+=vt*(hemi*vec2(-d.y,d.x)/r-.22*d/r);
    // Where its cloud is made: a dense core some 250 km across and two bands spiralling in
    // towards it the way the winds do, anticlockwise in the north. The spiral's pitch is a
    // typical one; the spin then winds the carried cloud on from there.
    float turn=hemi*atan(d.y,d.x)+2.5*log(r/100.);
    float band=pow(.5+.5*cos(2.*turn),3.)*smoothstep(120.,260.,r)*exp(-(r*r)/(650.*650.));
    // A storm dying past its forecast (w, 0..1) loses its bands, and its dense cloud is
    // drawn out ahead of it along its path, the way recurving storms end in a streak.
    float st=motion[i].w;vec2 dir=length(motion[i].xy)>1.?normalize(motion[i].xy):vec2(0.,1.);
    vec2 e=d-dir*st*250.;
    float re=length(vec2(dot(e,dir)/(1.+2.5*st),(dir.x*e.y-dir.y*e.x)/(1.+.3*st)));
    source=max(source,s*max(exp(-(re*re)/(230.*230.)),.85*band*(1.-st)));}
   return abs(lat)>80.?vec2(0.):vel+swirl;}
  vec2 degreesPerHour(vec2 kmh,float lat){return vec2(kmh.x/(KM*max(.15,cos(radians(lat)))),kmh.y/KM);}`;

  // The last observation's clouds, from its Mercator layout into latitude-longitude, by the
  // same brightness curve the globe draws them with. The SSEC logo in its corner is left out.
  const INIT = COMMON + `
  uniform sampler2D obs;uniform vec2 watermark;
  void main(){vec2 uv=gl_FragCoord.xy/size;float lat=uv.y*180.-90.;float c=0.;
   if(abs(lat)<85.05){float my=.5-log(tan(PI*.25+radians(lat)*.5))/(2.*PI);
    vec4 o=texture2D(obs,vec2(uv.x,my));
    float mark=step(uv.x,watermark.x)*step(1.-watermark.y,my);
    c=smoothstep(.38,.82,dot(o.rgb,vec3(.299,.587,.114)))*o.a*(1.-mark);}
   gl_FragColor=vec4(c,c,c,1.);}`;

  // The average cloudiness of each latitude, for the clouds to tend towards.
  const BASELINE = COMMON + `
  uniform sampler2D start;
  void main(){float y=gl_FragCoord.y/size.y;float sum=0.;
   for(int k=0;k<128;k++){sum+=texture2D(start,vec2((float(k)+.5)/128.,y)).r;}
   gl_FragColor=vec4(pack(sum/128.),0.,1.);}`;

  // Zero displacement: every point's air is where it is.
  const ZERO = COMMON + `void main(){gl_FragColor=encodeD(vec2(0.));}`;
  const CLEAR = COMMON + `void main(){gl_FragColor=vec4(0.,0.,0.,1.);}`;

  // Where each point's air was at the last observation, carried on by dt hours.
  const FLOW = COMMON + `
  uniform sampler2D prev;uniform float dt;
  void main(){vec2 uv=gl_FragCoord.xy/size;float lat=uv.y*180.-90.,lon=uv.x*360.-180.;
   float source;vec2 move=degreesPerHour(wind(lat,lon,source),lat)*dt;
   vec2 back=vec2(lon,lat)-move;
   vec2 d=displacement(prev,vec2((back.x+180.)/360.,(back.y+90.)/180.))-move;
   gl_FragColor=encodeD(d);}`;

  // The storm's own cloud: carried the ordinary way, made near each centre, thinning after.
  const STORM = COMMON + `
  uniform sampler2D prev;uniform float dt;
  void main(){vec2 uv=gl_FragCoord.xy/size;float lat=uv.y*180.-90.,lon=uv.x*360.-180.;
   float source;vec2 move=degreesPerHour(wind(lat,lon,source),lat)*dt;
   vec2 back=vec2(lon,lat)-move;
   float s=field(prev,vec2((back.x+180.)/360.,(back.y+90.)/180.));
   s*=exp(-dt/30.);
   s+=(1.-s)*source*(1.-exp(-dt/1.5));
   gl_FragColor=vec4(pack(s),0.,1.);}`;

  // For the globe to draw: the observation read once at where each point's air came from,
  // tending to its latitude's average, with the storm cloud over it. One 8-bit channel,
  // filtered by the hardware.
  const RESOLVE = COMMON + `
  uniform sampler2D start;uniform sampler2D flow;uniform sampler2D stormCloud;uniform sampler2D baseline;uniform float relax;
  uniform float hour,flickerAmp,flickerCell,flickerTau,flickerBirth;
  float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
  float vnoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
   return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
              mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
  void main(){vec2 uv=gl_FragCoord.xy/size;float lat=uv.y*180.-90.,lon=uv.x*360.-180.;
   vec2 d=decodeD(texture2D(flow,uv));
   vec2 from=vec2(lon,lat)+d;
   float c=texture2D(start,wrapUV(vec2((from.x+180.)/360.,(from.y+90.)/180.))).r;
   c=mix(c,unpack(texture2D(baseline,vec2(.5,uv.y))),relax);
   // The flicker: cloud edges grown and eaten away a little every hour, and a little
   // cloud come and gone in the clear, as real cloud does and cloud only carried does
   // not. Drawn on where the air came from, so it moves with the cloud, and changing
   // with the hour. For the look alone: sized so the change an hour and the fine
   // detail match the observations', not a model of any weather.
   vec2 q=vec2(from.x*cos(radians(from.y)),from.y)/flickerCell;float t=hour/flickerTau;
   float n=(vnoise(vec3(q,t))*.6+vnoise(vec3(q*2.3+17.,t*1.4+5.))*.4)*2.-1.;
   c=clamp(c+flickerAmp*n*(4.*c*(1.-c)+flickerBirth),0.,1.);
   float s=unpack(texture2D(stormCloud,uv));
   c=1.-(1.-c)*(1.-s);
   gl_FragColor=vec4(c,c,c,1.);}`;

  class StormSimulation {
    /// The hour on screen is bound to displayUnit, the hour before it to previousUnit, for
    /// the globe to dissolve from one to the other as it does between observations.
    constructor(gl, displayUnit = 7, previousUnit = 6) {
      this.gl = gl;
      this.displayUnit = displayUnit;
      this.previousUnit = previousUnit;
      this.shownHours = 0;
      this.shownAt = 0;
      // See RESOLVE. Amplitude, cell size in degrees, correlation time in hours, and how
      // much of it reaches clear sky; chosen by scripts measuring the observations.
      this.flicker = Object.assign({}, FLICKER);
      this.active = false;
      this.hours = 0;
      this.tracks = [];
      this.ready = false;
      this.borrowed = new Map();
      try { this.setUp(); this.ready = true; } catch (error) { console.warn('storm simulation unavailable:', error.message); }
    }

    setUp() {
      const gl = this.gl;
      const compile = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = fs => {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
      };
      this.programs = { init: program(INIT), baseline: program(BASELINE), zero: program(ZERO),
        clear: program(CLEAR), flow: program(FLOW), storm: program(STORM), resolve: program(RESOLVE) };
      this.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const target = (w, h, linear) => {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + 5);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const filter = linear ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w > 1 ? gl.REPEAT : gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { texture, fb, w, h };
      };
      this.start0 = target(W, H, true);
      this.flow = [target(W, H, false), target(W, H, false)];
      this.cloud = [target(W, H, false), target(W, H, false)];
      this.baseline = target(1, H, false);
      // Two, the hour on screen and the one before: the scene is shown an hour at a time,
      // like the observations before it, not moving on every frame. Computed continuously
      // and shown in steps, it keeps the rhythm of what it follows on from.
      this.shown = [target(W, H, true), target(W, H, true)];
      this.showing = 0;
      this.background = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + 6);
      gl.bindTexture(gl.TEXTURE_2D, this.background);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 128, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.bindShown();
    }

    get display() { return this.shown[this.showing]; }
    get previous() { return this.shown[1 - this.showing]; }

    bindShown() {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + this.previousUnit);
      gl.bindTexture(gl.TEXTURE_2D, this.previous.texture);
      gl.activeTexture(gl.TEXTURE0 + this.displayUnit);
      gl.bindTexture(gl.TEXTURE_2D, this.display.texture);
      gl.activeTexture(gl.TEXTURE0);
    }

    /// Draws one full-screen pass into a target, with the given textures on units 3 onward.
    /// The globe keeps its own textures on 0-4 and 7 bound across frames, so every pass ends
    /// by putting back whatever it borrowed (restore()).
    pass(name, into, inputs, uniforms) {
      const gl = this.gl, p = this.programs[name];
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.fb);
      gl.viewport(0, 0, into.w, into.h);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      const a = gl.getAttribLocation(p, 'a');
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      // A phone may have only eight units, so the passes use 5 and 6, which the globe leaves
      // free, and borrow 3 and 4, putting back what was there.
      const units = [5, 6, 3, 4];
      Object.entries(inputs || {}).forEach(([nameOf, texture], k) => {
        gl.activeTexture(gl.TEXTURE0 + units[k]);
        if (units[k] < 5 && !this.borrowed.has(units[k])) this.borrowed.set(units[k], gl.getParameter(gl.TEXTURE_BINDING_2D));
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(gl.getUniformLocation(p, nameOf), units[k]);
      });
      gl.uniform2f(gl.getUniformLocation(p, 'size'), into.w, into.h);
      for (const [k, v] of Object.entries(uniforms || {})) {
        const loc = gl.getUniformLocation(p, k);
        if (loc === null) continue;
        if (Array.isArray(v) && v.length === 2) gl.uniform2f(loc, v[0], v[1]);
        else if (v instanceof Float32Array) gl.uniform4fv(loc, v);
        else gl.uniform1f(loc, v);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.disableVertexAttribArray(a);
    }

    restore() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (this.viewport) gl.viewport(0, 0, this.viewport[0], this.viewport[1]);
      for (const [unit, texture] of this.borrowed) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); }
      this.borrowed.clear();
      this.bindShown();
    }

    /// Starts from the observation on screen. storms: [{lat, lon, u, v}] - where each was
    /// last seen and its motion over the last twelve hours, in km/h. air: a
    /// BarotropicFlow already started, from the measured motion or, without it, the
    /// typical circulation.
    start({ observation, watermark, storms, model, viewport, air }) {
      // With no storm, or no model to move one, the clouds still ride the flow.
      if (!this.ready || !air) return false;
      // A storm that comes with its own track (a forecast it follows) needs no model.
      if (!model) storms = storms.filter(s => s.track);
      this.viewport = viewport;
      this.air = air;
      this.airHours = 0;
      this.uploadAir();
      this.tracks = storms.slice(0, MAX_STORMS).map(s => {
        if (s.track) return Object.assign({ from: s }, s.track);
        // A detection that hopped between systems shows up as an impossible speed; the
        // object starts no faster than any storm in the record kept up.
        const speed = Math.hypot(s.u, s.v), k = speed > MAX_START_KMH ? MAX_START_KMH / speed : 1;
        const run = model.run({ lat: s.lat, lon: s.lon, kt: ASSUMED_KT, u: s.u * k, v: s.v * k });
        return { from: s, points: run.points, end: run.end };
      });
      this.lastEnd = this.tracks.length ? Math.max(...this.tracks.map(t => t.end.t)) : 0;
      this.horizon = Math.min(MAX_HOURS, Math.max(HORIZON_HOURS, this.lastEnd + AFTER_END_HOURS));
      this.pass('init', this.start0, { obs: observation }, { watermark });
      this.pass('baseline', this.baseline, { start: this.start0.texture });
      this.pass('zero', this.flow[0]);
      this.pass('clear', this.cloud[0]);
      this.current = 0;
      this.hours = 0;
      this.finished = false;
      // Hour 0 on both, so the first hour has nothing to dissolve from but itself.
      this.resolve(0);
      this.resolve(0);
      this.shownAt = 0;
      this.active = true;
      this.restore();
      return true;
    }

    uploadAir() {
      const gl = this.gl;
      this.airPixels = this.air.texture(this.airPixels);
      gl.activeTexture(gl.TEXTURE0 + 6);
      gl.bindTexture(gl.TEXTURE_2D, this.background);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 64, gl.RGBA, gl.UNSIGNED_BYTE, this.airPixels);
    }

    /// Puts the hour just reached on screen, the one before it becoming the previous.
    resolve(now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
      const into = this.previous;
      const f = this.flicker;
      this.pass('resolve', into, { start: this.start0.texture, flow: this.flow[this.current].texture,
        stormCloud: this.cloud[this.current].texture, baseline: this.baseline.texture },
        { relax: 1 - Math.exp(-Math.floor(this.hours) / RELAX_HOURS), hour: Math.floor(this.hours + 1e-6),
          flickerAmp: f.amp, flickerCell: f.cell, flickerTau: f.tau, flickerBirth: f.birth });
      this.showing = 1 - this.showing;
      this.shownHours = Math.floor(this.hours + 1e-6);
      this.shownAt = now;
    }

    /// Where a storm is at an hour of the simulation, between its hourly points; after its
    /// end, fading where it ended.
    stormAt(track, hours) {
      const pts = track.points, last = pts[pts.length - 1];
      if (hours >= last.t) {
        const fade = Math.max(0, 1 - (hours - last.t) / 12);
        return { lat: last.lat, lon: last.lon, kt: last.kt * fade, u: 0, v: 0, alive: false, fade, decay: last.decay || 0 };
      }
      const i = Math.floor(hours), f = hours - i;
      const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
      const dlon = ((b.lon - a.lon + 540) % 360) - 180;
      return {
        lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + dlon * f, kt: a.kt + (b.kt - a.kt) * f,
        u: dlon * 111.195 * Math.cos(a.lat * Math.PI / 180), v: (b.lat - a.lat) * 111.195,
        alive: true, fade: 1, decay: (a.decay || 0) + ((b.decay || 0) - (a.decay || 0)) * f,
      };
    }

    uniformsAt(hours) {
      const storm = new Float32Array(MAX_STORMS * 4), motion = new Float32Array(MAX_STORMS * 4);
      this.tracks.forEach((track, i) => {
        const s = this.stormAt(track, hours);
        // While dying past the forecast it weakens from how strong it was when the forecast
        // stopped, all the way to nothing, rather than dropping out once below a typhoon.
        const at = track.points[track.forecastHours] || track.points[0];
        const strength = s.decay > 0
          ? Math.max(0, Math.min(1, (at.kt - 34) / 66)) * (1 - s.decay) * s.fade
          : Math.max(0, Math.min(1, (s.kt - 34) / 66)) * s.fade;
        storm.set([s.lat, s.lon, strength, 90], i * 4);
        motion.set([s.u, s.v, s.alive ? 1 : s.fade, s.decay], i * 4);
      });
      return { storm, motion, count: this.tracks.length };
    }

    /// Moves the scene on by some hours. Returns false once it has run its course.
    advance(hours, viewport) {
      if (!this.active || this.finished) return false;
      this.viewport = viewport || this.viewport;
      let left = Math.min(hours, 6);
      while (left > 1e-6) {
        const dt = Math.min(STEP_HOURS, left);
        const u = Object.assign({ dt }, this.uniformsAt(this.hours + dt / 2));
        const next = 1 - this.current;
        const air = this.background;
        this.pass('flow', this.flow[next], { prev: this.flow[this.current].texture, background: air }, u);
        this.pass('storm', this.cloud[next], { prev: this.cloud[this.current].texture, background: air }, u);
        this.current = next;
        this.hours += dt;
        left -= dt;
        if (this.hours >= this.airHours + FLOW_STEP_HOURS) {
          this.air.step(FLOW_STEP_HOURS);
          this.airHours += FLOW_STEP_HOURS;
          this.uploadAir();
        }
      }
      // A new hour reached is put on screen; within an hour nothing on screen changes.
      if (Math.floor(this.hours + 1e-6) > this.shownHours) this.resolve();
      this.restore();
      // At the end it stays on screen as it is, until the page takes it away.
      if (this.hours >= this.horizon) { this.finished = true; return false; }
      return true;
    }

    stop() { this.active = false; this.finished = false; this.hours = 0; }

    /// Where the storms are now and where they are going, for the marks on the globe: the
    /// path a day apart, which stays readable when zoomed in on one storm.
    marks() {
      if (!this.active) return [];
      return this.tracks.map(track => {
        // The hour on screen, like the clouds: marks step with them.
        const now = this.stormAt(track, this.shownHours);
        // On a forecast, the forecast's own hours; past it, and otherwise, a day apart.
        const knots = new Set(track.knotHours || []), until = track.forecastHours || 0;
        const ahead = track.points.filter(p => p.t > this.shownHours + 3 && (p.t <= until ? knots.has(p.t) : (p.t - until) % 24 === 0));
        return { now, ahead, ended: !now.alive };
      });
    }

    /// The simulated cloud at a place, read back from the GPU: for checks, not for drawing.
    sample(lat, lon, radius = 3) {
      const gl = this.gl;
      const x = Math.round((lon + 180) / 360 * W), y = Math.round((lat + 90) / 180 * H);
      const size = radius * 2 + 1, buffer = new Uint8Array(size * size * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.display.fb);
      gl.readPixels(Math.max(0, x - radius), Math.max(0, y - radius), size, size, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let max = 0, sum = 0;
      for (let i = 0; i < buffer.length; i += 4) { max = Math.max(max, buffer[i]); sum += buffer[i]; }
      return { max: max / 255, mean: sum / (buffer.length / 4) / 255 };
    }
  }

  root.StormSimulation = StormSimulation;
  root.StormSimulation.ASSUMED_KT = ASSUMED_KT;
  if (typeof module !== 'undefined') module.exports = { StormSimulation, ASSUMED_KT };
})(typeof window === 'undefined' ? globalThis : window);
