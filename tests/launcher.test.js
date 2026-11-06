'use strict';
// src/launcher.js: starts the PDV again after a failure and lets it finish cleanly when stopped. The PDV is replaced
// by a small script in a temporary folder, so nothing here opens a database or the real data folder.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {supervise,watchStopRequest}=require('../src/launcher');const {until}=require('./helpers');
// Fails `failures` times (exit code 1), then keeps running; on disconnect it records a clean stop and exits.
const CHILD=`
const fs=require('node:fs'),path=require('node:path');const dir=process.argv[2],failures=Number(process.argv[3]);
const runs=path.join(dir,'runs');const n=(fs.existsSync(runs)?Number(fs.readFileSync(runs,'utf8')):0)+1;fs.writeFileSync(runs,String(n));
fs.writeFileSync(path.join(dir,'env'),String(process.env.PDV_LAUNCHER));
if(n<=failures){console.error('falha simulada '+n);process.exit(1);}
fs.writeFileSync(path.join(dir,'running'),'1');
const keep=setInterval(()=>{},1000);
process.on('disconnect',()=>{clearInterval(keep);fs.writeFileSync(path.join(dir,'clean-stop'),'1');process.exit(0);});
`;
function setup(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-launcher-'));const script=path.join(dir,'child.js');fs.writeFileSync(script,CHILD);
  const lines=[];return {dir,script,lines,log:m=>lines.push(m),read:f=>fs.existsSync(path.join(dir,f))?fs.readFileSync(path.join(dir,f),'utf8'):null,clean(){fs.rmSync(dir,{recursive:true,force:true});}};
}
test('inicializador reinicia o PDV depois de falhas e o encerra de forma limpa',async()=>{
  const h=setup();
  const s=supervise({script:h.script,args:[h.dir,'2'],log:h.log,delays:[20,40],env:{...process.env,PDV_LAUNCHER:''}});
  try{
    await until(()=>h.read('running')==='1',10000);
    assert.equal(h.read('runs'),'3');assert.equal(s.starts,3);
    assert.equal(h.read('env'),'1','o PDV sabe que está sob o inicializador (aparece no diagnóstico)');
    assert.ok(h.lines.some(l=>/código 1/.test(l)&&/falha simulada 1/.test(l)),'a falha fica registrada com as últimas linhas do PDV');
    await s.stop();
    assert.equal(h.read('clean-stop'),'1','o PDV recebeu o aviso e terminou sozinho');
    assert.equal(s.child,null);
    await new Promise(r=>setTimeout(r,120));
    assert.equal(h.read('runs'),'3','depois de parado, não inicia de novo');
  }finally{await s.stop();h.clean();}
});
test('pedido de parada: o arquivo antigo é descartado e um novo pedido é atendido uma vez',async()=>{
  const h=setup();const file=path.join(h.dir,'parar-pdv');fs.writeFileSync(file,'pedido antigo');
  let calls=0;const cancel=watchStopRequest(file,()=>{calls++;},10);
  try{
    assert.equal(fs.existsSync(file),false,'um pedido que sobrou de antes não derruba o PDV ao ligar');
    await new Promise(r=>setTimeout(r,50));assert.equal(calls,0);
    fs.writeFileSync(file,'agora');
    await until(()=>calls===1,3000);
    assert.equal(fs.existsSync(file),false);
    fs.writeFileSync(file,'de novo');await new Promise(r=>setTimeout(r,60));assert.equal(calls,1);
  }finally{cancel();h.clean();}
});
test('configuração inválida (código 2) espera o intervalo mais longo antes de tentar de novo',async()=>{
  const h=setup();fs.writeFileSync(h.script,'process.exit(2)');
  const s=supervise({script:h.script,log:h.log,delays:[10,60000]});
  try{
    await until(()=>h.lines.some(l=>/Nova tentativa/.test(l)),5000);
    assert.ok(h.lines.some(l=>/Nova tentativa em 60 s/.test(l)),h.lines.join('\n'));
    assert.equal(s.starts,1);
  }finally{await s.stop();h.clean();}
});
