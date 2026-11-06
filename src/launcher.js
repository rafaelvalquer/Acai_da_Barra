'use strict';
// Keeps the PDV running on the store's computer. The "Luminor PDV" Windows task (created by instalador\instalar.ps1)
// starts this file as SYSTEM when the computer boots; it starts src/main.js and starts it again if it stops, waiting a
// little longer after each failure in a row (1 s, 3 s, 10 s, 30 s, then every 60 s). A run that lasted 5 minutes
// counts as healthy and resets the wait. An invalid configuration (exit code 2) and a busy port (exit code 3) are not
// fixed by trying again at once, so they wait the longest.
//
// Stopping: the installer asks for a clean stop by creating tmp/parar-pdv in the data folder (only SYSTEM and the
// administrators can write there). The launcher then closes its IPC channel to the PDV, which finishes its work
// (closes the database, stops the scale) and exits, and the launcher exits too. Ending the task by force also ends
// the PDV (Windows ends a child together with its parent); the database stays consistent, only that clean stop is
// skipped. The PDV's own log stays in logs/pdv-*.log; logs/inicializador.log only records starts, stops and the last
// lines written before a failure.
const fs=require('node:fs'),path=require('node:path');const {spawn}=require('node:child_process');
const DELAYS=[1000,3000,10000,30000,60000];
const STABLE_MS=5*60000,TAIL_LINES=20,LOG_MAX_BYTES=1024*1024;
function fileLog(dir){
  if(!dir)return m=>console.log(`[${new Date().toISOString()}] ${m}`);
  const file=path.join(dir,'inicializador.log');
  return m=>{
    try{
      fs.mkdirSync(dir,{recursive:true});
      try{if(fs.statSync(file).size>LOG_MAX_BYTES)fs.renameSync(file,file+'.1');}catch(_){}
      fs.appendFileSync(file,`[${new Date().toISOString()}] ${m}\n`);
    }catch(_){}
  };
}
function supervise({script=path.join(__dirname,'main.js'),args=[],env=process.env,log=console.log,delays=DELAYS,stableMs=STABLE_MS,exec=process.execPath}={}){
  let child=null,stopped=false,failures=0,timer=null,starts=0,stopping=null;
  const run=()=>{
    if(stopped)return;
    const startedAt=Date.now();const tail=[];starts++;
    const keep=chunk=>{for(const line of String(chunk).split(/\r?\n/))if(line.trim()){tail.push(line);if(tail.length>TAIL_LINES)tail.shift();}};
    try{child=spawn(exec,[script,...args],{env:{...env,PDV_LAUNCHER:'1'},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});}
    catch(e){log(`Não foi possível iniciar o PDV: ${e.message}`);return retry(null);}
    const current=child;
    current.stdout.on('data',keep);current.stderr.on('data',keep);
    current.on('error',e=>{log(`Falha no processo do PDV: ${e.message}`);});
    current.on('exit',(code,signal)=>{
      if(child===current)child=null;
      if(stopped)return;
      if(Date.now()-startedAt>=stableMs)failures=0;
      log(`PDV encerrou (código ${code??signal}).${tail.length?' Últimas linhas:\n  '+tail.join('\n  '):''}`);
      retry(code);
    });
    log(`PDV iniciado (processo ${current.pid}).`);
  };
  const retry=code=>{
    const wait=code===2||code===3?delays[delays.length-1]:delays[Math.min(failures,delays.length-1)];
    failures++;log(`Nova tentativa em ${Math.round(wait/1000)} s.`);
    timer=setTimeout(run,wait);
  };
  run();
  return {
    get child(){return child;},get starts(){return starts;},
    // Asks the PDV to finish (closing the channel) and waits; after `timeoutMs` it is ended by force.
    stop({timeoutMs=15000}={}){
      if(stopping)return stopping;
      stopped=true;clearTimeout(timer);
      const c=child;if(!c)return stopping=Promise.resolve();
      return stopping=new Promise(resolve=>{
        const force=setTimeout(()=>{try{c.kill();}catch(_){}},timeoutMs);
        c.once('exit',()=>{clearTimeout(force);resolve();});
        try{c.connected?c.disconnect():c.kill();}catch(_){c.kill();}
      });
    }
  };
}
// Calls onRequest once when `file` appears; a request left over from before is discarded first.
function watchStopRequest(file,onRequest,interval=1000){
  try{fs.rmSync(file,{force:true});}catch(_){}
  const timer=setInterval(()=>{
    if(!fs.existsSync(file))return;
    clearInterval(timer);try{fs.rmSync(file,{force:true});}catch(_){}
    onRequest();
  },interval);
  return ()=>clearInterval(timer);
}
if(require.main===module){
  let paths=null;try{paths=require('./config').loadConfig().paths;}catch(_){}
  const log=fileLog(paths?.logs);log('Inicializador do Luminor PDV em execução.');
  const s=supervise({log});
  let ending=false;
  const quit=reason=>{
    if(ending)return;ending=true;log(reason);
    s.stop().then(()=>{log('Inicializador encerrado.');process.exit(0);});
  };
  process.on('SIGINT',()=>quit('Parada pedida no console.'));process.on('SIGBREAK',()=>quit('Parada pedida no console.'));
  if(paths)watchStopRequest(path.join(paths.tmp,'parar-pdv'),()=>quit('Parada pedida pelo instalador.'));
}
module.exports={supervise,watchStopRequest,DELAYS};
