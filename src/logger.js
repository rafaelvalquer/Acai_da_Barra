'use strict';
// Technical log: logs/pdv-AAAA-MM-DD.log (one file per day, 30 days kept) and the console. The latest lines stay in
// memory for the Maintenance screen. Database passwords are masked before anything is written.
const fs=require('node:fs'),path=require('node:path');const {parts}=require('./backup/clock');
const KEEP_DAYS=30,RING=400;
const mask=s=>String(s).replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi,'$1****@').replace(/(password|senha)=([^&\s]+)/gi,'$1=****');
class Logger {
  constructor({dir=null,echo=true}={}){this.dir=dir;this.echo=echo;this.lines=[];if(dir){try{fs.mkdirSync(dir,{recursive:true});this.prune();}catch(_){}}}
  write(level,message){
    const at=new Date();const line={at:at.toISOString(),level,message:mask(message)};
    this.lines.push(line);if(this.lines.length>RING)this.lines.shift();
    const text=`[${line.at}] ${level.toUpperCase().padEnd(5)} ${line.message}`;
    if(this.echo)(level==='error'?console.error:level==='warn'?console.warn:console.log)(text);
    if(this.dir){try{fs.appendFileSync(path.join(this.dir,`pdv-${parts(at).day}.log`),text+'\n');}catch(_){}}
  }
  info(m){this.write('info',m);}warn(m){this.write('warn',m);}error(m){this.write('error',m);}
  recent(limit=100,level=null){return this.lines.filter(l=>!level||l.level===level).slice(-limit).reverse();}
  prune(){
    const cutoff=Date.now()-KEEP_DAYS*86400000;
    for(const f of fs.readdirSync(this.dir))if(/^pdv-\d{4}-\d{2}-\d{2}\.log$/.test(f)&&Date.parse(f.slice(4,14))<cutoff)fs.rmSync(path.join(this.dir,f),{force:true});
  }
}
module.exports={Logger,mask};
