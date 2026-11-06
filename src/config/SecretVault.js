'use strict';
// The installation's secrets (backup key, cloud database address with its password), encrypted on disk in
// config/cofre.dat. Never sent to the browser.
//   dpapi   (Windows, default): Windows DPAPI, machine scope. Only this computer can open the file, and the installer
//           limits the config folder to the PDV service and the computer's administrators.
//   arquivo (development and tests): AES-256-GCM with a random key kept in config/cofre.key.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const {spawn}=require('node:child_process');
const {writeAtomic}=require('../hardware');
const ENTROPY='luminor-pdv-cofre-v1';
function powershell(script,input){
  return new Promise((resolve,reject)=>{
    const ps=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});
    let out='',err='';ps.stdout.on('data',d=>{out+=d;});ps.stderr.on('data',d=>{err+=d;});ps.on('error',reject);
    ps.on('close',code=>code===0?resolve(out.trim()):reject(Error(`DPAPI indisponível (${code}): ${err.replace(/#< CLIXML[\s\S]*?<\/Objs>/g,'').trim().slice(0,200)}`)));
    ps.stdin.end(input);
  });
}
const dpapi=(op,data)=>powershell(`$ProgressPreference='SilentlyContinue'; Add-Type -AssemblyName System.Security; `+
  `$d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}'); `+
  `$r=[System.Security.Cryptography.ProtectedData]::${op}($d,$e,[System.Security.Cryptography.DataProtectionScope]::LocalMachine); `+
  `[Console]::Out.Write([Convert]::ToBase64String($r))`,data.toString('base64')).then(b=>Buffer.from(b,'base64'));
class SecretVault {
  constructor(file,{mode='arquivo'}={}){this.file=file;this.mode=mode;this.keyFile=file.replace(/\.dat$/,'')+'.key';this.secrets=null;}
  fileKey(){
    try{const k=Buffer.from(fs.readFileSync(this.keyFile,'utf8').trim(),'base64');if(k.length===32)return k;}catch(e){if(e.code!=='ENOENT')throw e;}
    const k=crypto.randomBytes(32);writeAtomic(this.keyFile,k.toString('base64'));return k;
  }
  async protect(plain){
    if(this.mode==='dpapi')return {protection:'dpapi-maquina',data:(await dpapi('Protect',plain)).toString('base64')};
    const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',this.fileKey(),iv);const body=Buffer.concat([c.update(plain),c.final(),c.getAuthTag()]);
    return {protection:'arquivo-aes-gcm',iv:iv.toString('base64'),data:body.toString('base64')};
  }
  async unprotect(box){
    const data=Buffer.from(box.data,'base64');
    if(box.protection==='dpapi-maquina')return dpapi('Unprotect',data);
    if(box.protection==='arquivo-aes-gcm'){const d=crypto.createDecipheriv('aes-256-gcm',this.fileKey(),Buffer.from(box.iv,'base64'));d.setAuthTag(data.subarray(data.length-16));return Buffer.concat([d.update(data.subarray(0,data.length-16)),d.final()]);}
    throw Error('Formato do cofre desconhecido');
  }
  async load(){
    if(this.secrets)return this.secrets;
    let box;try{box=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code==='ENOENT'){this.secrets={};return this.secrets;}throw Error(`Cofre de senhas ilegível (${this.file}): ${e.message}`);}
    try{this.secrets=JSON.parse((await this.unprotect(box)).toString('utf8'));}
    catch(e){throw Error(`Não foi possível abrir o cofre de senhas deste computador (${e.message}). Ele só abre no computador em que foi criado.`);}
    return this.secrets;
  }
  get(name){if(!this.secrets)throw Error('Cofre não carregado');return this.secrets[name]??null;}
  // Writes several secrets at once; null removes one.
  async update(values){
    const next={...(await this.load())};for(const [k,v] of Object.entries(values)){if(v===null||v===undefined)delete next[k];else next[k]=v;}
    const box=await this.protect(Buffer.from(JSON.stringify(next),'utf8'));
    fs.mkdirSync(path.dirname(this.file),{recursive:true});writeAtomic(this.file,JSON.stringify({version:1,...box}));this.secrets=next;
  }
}
module.exports={SecretVault};
