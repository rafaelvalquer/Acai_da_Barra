'use strict';
// Settings of this computer's devices (the scale's serial port), kept in config/hardware.json and not in the
// commercial database: they belong to the machine, so restoring a backup made on another computer never points the
// PDV at a port that does not exist here. After a restore the remembered port is checked again.
const fs=require('node:fs'),path=require('node:path');
function writeAtomic(file,text){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,text);fs.renameSync(tmp,file);
}
class HardwareConfig {
  constructor(file){this.file=file;}
  read(){try{const v=JSON.parse(fs.readFileSync(this.file,'utf8'));return v&&typeof v==='object'?v:{};}catch(_){return {};}}
  scale(){const s=this.read().scale;return s&&typeof s.path==='string'&&s.path?{path:s.path,baudRate:Number(s.baudRate)||2400}:null;}
  // path null forgets the port (the scale was disconnected on purpose), so the next start does not reconnect it.
  rememberScale(portPath,baudRate=2400){
    const all=this.read();
    if(portPath)all.scale={path:String(portPath),baudRate:Number(baudRate)||2400,updatedAt:new Date().toISOString()};else delete all.scale;
    writeAtomic(this.file,JSON.stringify(all,null,2));
  }
  // Is the remembered port present on this computer? {configured, path, found}
  async check(scale){
    const s=this.scale();if(!s)return {configured:false};
    try{const ports=await scale.ports();return {configured:true,path:s.path,found:ports.some(p=>p.path===s.path)};}
    catch(e){return {configured:true,path:s.path,found:false,error:e.message};}
  }
}
module.exports={HardwareConfig,writeAtomic};
