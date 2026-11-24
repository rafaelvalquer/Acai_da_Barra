'use strict';
// Technical log of the scale (PDV_SCALE_LOG=true): one JSON line per event in logs/balanca.log. It cannot grow without
// limit: at maxBytes the file becomes balanca.1.log, then .2 …, and the oldest is deleted. Only technical data goes in
// (bytes of the scale, timings, cycle and sale ids): never names, passwords or tokens. Written in batches, off the
// path of the weighing.
const fs=require('node:fs'),path=require('node:path');
function scaleLog(dir,{maxBytes=10*1024*1024,files=5,flushMs=1000}={}){
  const file=n=>path.join(dir,n?`balanca.${n}.log`:'balanca.log');
  let buffer=[],timer=null,size=0;
  try{fs.mkdirSync(dir,{recursive:true});size=fs.statSync(file(0)).size;}catch(_){}
  function rotate(){
    try{fs.rmSync(file(files-1),{force:true});for(let n=files-2;n>=0;n--)if(fs.existsSync(file(n)))fs.renameSync(file(n),file(n+1));}catch(_){}
    size=0;
  }
  function flush(){
    if(timer)clearTimeout(timer);timer=null;if(!buffer.length)return;
    const text=buffer.join('');buffer=[];
    try{if(size+Buffer.byteLength(text)>maxBytes)rotate();fs.appendFileSync(file(0),text);size+=Buffer.byteLength(text);}catch(_){}
  }
  return {
    write(event){buffer.push(JSON.stringify(event)+'\n');if(buffer.length>=500)flush();else if(!timer){timer=setTimeout(flush,flushMs);timer.unref?.();}},
    flush
  };
}
module.exports={scaleLog};
