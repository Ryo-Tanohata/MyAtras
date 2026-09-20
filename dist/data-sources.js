'use strict';
// Bundled observation assets.
// The standalone export inlines these as window.GEO_* globals. When the files are
// served as a directory, the same observations are read from their manifests so
// both builds show identical data. Failure returns null and the UI keeps running
// with whatever it already shows; nothing is substituted for a missing observation.
(function(root){
const SNAPSHOT='weather/snapshot.json',SEQUENCE='weather/sequence/manifest.json',AMV='data/amv.json',STORMS='data/storms.json',TENDENCY='data/tendency.json';
const pending=new Map();
function loadJSON(path){if(pending.has(path))return pending.get(path);const request=(async()=>{const response=await fetch(path,{credentials:'omit'});if(!response.ok)throw Error('HTTP '+response.status);return response.json();})();pending.set(path,request);return request;}
function beside(path,file){return path.slice(0,path.lastIndexOf('/')+1)+file;}
const GeoData={
 async snapshot(){if(root.GEO_WEATHER_SNAPSHOT)return root.GEO_WEATHER_SNAPSHOT;try{const data=await loadJSON(SNAPSHOT);const out={};for(const [product,entry] of Object.entries(data))out[product]={time:entry.time,url:beside(SNAPSHOT,entry.file),sha256:entry.sha256};root.GEO_WEATHER_SNAPSHOT=out;return out;}catch(error){return null;}},
 async sequence(){if(root.GEO_WEATHER_SEQUENCE)return root.GEO_WEATHER_SEQUENCE;try{const data=await loadJSON(SEQUENCE);const out={};for(const [product,frames] of Object.entries(data))out[product]=frames.map(f=>({time:f.time,url:beside(SEQUENCE,f.file),source:f.source,sha256:f.sha256}));root.GEO_WEATHER_SEQUENCE=out;return out;}catch(error){return null;}},
 async amv(){if(root.GEO_AMV_SNAPSHOT)return root.GEO_AMV_SNAPSHOT;try{const bundle=await loadJSON(AMV);root.GEO_AMV_SNAPSHOT=bundle;return bundle;}catch(error){return null;}},
 async storms(){if(root.GEO_STORMS)return root.GEO_STORMS;try{const bundle=await loadJSON(STORMS);root.GEO_STORMS=bundle;return bundle;}catch(error){return null;}},
 async tendency(){if(root.GEO_TENDENCY)return root.GEO_TENDENCY;try{const bundle=await loadJSON(TENDENCY);root.GEO_TENDENCY=bundle;return bundle;}catch(error){return null;}}
};
root.GeoData=GeoData;
if(typeof module!=='undefined')module.exports=GeoData;
})(typeof window==='undefined'?globalThis:window);
