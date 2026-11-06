'use strict';
// What happened to the backups, kept in backups/estado.json, outside the database: a restore never erases the record
// of the last good backup, and the alert for a failed automatic backup survives a restart.
const fs=require('node:fs');const {writeAtomic}=require('../hardware');
const HISTORY=20;
class BackupStatus {
  constructor(file){this.file=file;this.data=this.read();}
  read(){try{const v=JSON.parse(fs.readFileSync(this.file,'utf8'));return v&&typeof v==='object'?{history:[],...v}:{history:[]};}catch(_){return {history:[]};}}
  save(){try{writeAtomic(this.file,JSON.stringify(this.data,null,2));}catch(e){this.saveError=e.message;}}
  get lastSuccess(){return this.data.lastSuccess||null;}
  get lastAutomatic(){return this.data.lastAutomatic||null;}
  get lastFailure(){return this.data.lastFailure||null;}
  success(entry){
    this.data.lastSuccess=entry;if(['automatico','fechamento'].includes(entry.kind))this.data.lastAutomatic=entry;
    // A backup that works again clears the alert of the last failure.
    if(this.data.lastFailure&&Date.parse(this.data.lastFailure.at)<=Date.parse(entry.at))this.data.lastFailure=null;
    if(entry.kind==='automatico')this.data.failuresInARow=0;
    this.push({at:entry.at,kind:entry.kind,ok:true,name:entry.name,bytes:entry.bytes});this.save();
  }
  failure(kind,error,at=new Date().toISOString()){
    this.data.lastFailure={at,kind,error};if(kind==='automatico')this.data.failuresInARow=(this.data.failuresInARow||0)+1;
    this.push({at,kind,ok:false,error});this.save();
  }
  copied(entry){this.data.lastCopy=entry;this.data.lastCopyFailure=null;this.save();}
  copyFailed(entry){this.data.lastCopyFailure=entry;this.save();}
  skipped(kind,reason,at=new Date().toISOString()){this.push({at,kind,ok:true,skipped:reason});this.save();}
  push(item){this.data.history=[item,...(this.data.history||[])].slice(0,HISTORY);}
}
module.exports={BackupStatus};
