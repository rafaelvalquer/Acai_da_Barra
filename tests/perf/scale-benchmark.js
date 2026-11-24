'use strict';
// Weighing performance on the simulated serial scale, for any version of the code:
//   node tests/perf/scale-benchmark.js [--root <project folder>] [--n 60] [--json out.json]
// To compare with a previous version, extract its src, public and tests folders somewhere and point --root at it
// (with NODE_PATH at this project's node_modules). The simulator is always this one.
// Simulated: ENQ answered after 35 ms; the scale needs 300 ms to settle after the plate changes. That settling time is
// the scale's, not the PDV's: every latency below starts at the first stable value the scale can report.
const path=require('node:path'),fs=require('node:fs');
const {scaleSimulator,wait}=require('../serial-sim');
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const root=path.resolve(arg('root',path.join(__dirname,'../..')));
const need=p=>require(path.join(root,p));
const {tempStore}=need('tests/helpers');const {posAuth}=need('tests/pos-helpers');
const {ScaleDriver}=need('src/scale');const {createServer}=need('src/server');
const N=Number(arg('n',60)),SETTLE=300,SWAPS=Number(arg('swaps',20));
// A fixed sequence of pseudo-random numbers, so both versions get the same plate timings.
let seed=20261124;const random=()=>(seed=(seed*48271)%2147483647)/2147483647;
function stats(list){
  const s=[...list].sort((a,b)=>a-b),p=q=>s[Math.min(s.length-1,Math.ceil(q/100*s.length)-1)];
  return s.length?{n:s.length,media:Math.round(s.reduce((t,x)=>t+x,0)/s.length),mediana:p(50),p95:p(95),p99:p(99),maxima:s[s.length-1]}:{n:0};
}
async function rig(){
  const box=await tempStore('luminor-bench-');const db=box.s;
  await db.openShift('0',(await db.saveEmployee({name:'Ana'})).id);const pos=await posAuth(db);const {cookie}=await pos.signIn('Ana');
  const sim=scaleSimulator({latencyMs:35});const scale=new ScaleDriver({SerialPort:sim.SerialPort});
  const server=createServer({db,scale,auth:pos.auth});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;const get=async p=>(await fetch(base+p,{headers:{Cookie:cookie}})).json();
  // When each item reached the database.
  const stored=[];const sales=db.ctx.sales,add=sales.addWeighed;sales.addWeighed=async function(...a){const r=await add.apply(this,a);if(!r.duplicate)stored.push(Date.now());return r;};
  await scale.connect('COM9',2400);await wait(1200);
  return {db,sim,get,stored,
    slow(ms){const f=sales.addWeighed;sales.addWeighed=async function(...a){await wait(ms);return f.apply(this,a);};},
    async close(){scale.disconnect();server.closeAllConnections();await new Promise(r=>server.close(r));await wait(100);await pos.close();await box.clean();}};
}
// What the till screen does (public/app.js of that version): the full state every 850 ms after the last answer and,
// where it exists, the light read of the scale every 200 ms that asks for the state as soon as something changed.
function screen(r,shown){
  let on=true,key=null,items=0;const light=fs.readFileSync(path.join(root,'src/server.js'),'utf8').includes("'/api/scale/state'");
  const full=async()=>{const s=await r.get('/api/state');key=s.liveKey;while(items<s.cart.length){items++;shown.push(Date.now());}};
  const loops=[(async()=>{await wait(random()*850);while(on){await full();await wait(850);}})()];
  if(light)loops.push((async()=>{while(on){const x=await r.get('/api/scale/state');if(key!==null&&x.liveKey!==key)await full();await wait(200);}})());
  return async()=>{on=false;await Promise.all(loops);};
}
const until=async(check,ms)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)return false;await wait(5);}return true;};
async function latency(){
  const r=await rig(),shown=[],toDb=[],toScreen=[],total=[];const stop=screen(r,shown);let lost=0;
  for(let i=0;i<N;i++){
    await wait(random()*500);   // any moment in relation to the polling
    const placedAt=Date.now(),stableAt=await r.sim.place(300+(i%40),SETTLE),n=r.stored.length,v=shown.length;
    if(!await until(()=>r.stored.length>n,5000))lost++;
    else{toDb.push(r.stored[n]-stableAt);total.push(r.stored[n]-placedAt);if(await until(()=>shown.length>v,3000))toScreen.push(shown[v]-stableAt);}
    // Plate left empty long enough for any version, so only the latency is measured here.
    await r.sim.remove(150);await wait(1600);
  }
  await stop();await r.close();
  return {estavelAteGravado:stats(toDb),estavelAteTela:stats(toScreen),colocarAteGravado:stats(total),naoRegistradas:lost};
}
// Cup after cup with the plate empty (stable zero) only for a moment, the same weight every time.
async function swaps(){
  const out={};
  for(const empty of [100,200,300,500,700,1000,1500]){
    const r=await rig();await r.sim.place(480,SETTLE);await until(()=>r.stored.length===1,4000);
    for(let i=0;i<SWAPS;i++){await wait(150+random()*400);await r.sim.remove(0);await wait(empty);await r.sim.place(480,SETTLE);await wait(1800);}
    await wait(1000);const items=(await r.db.getDraftSale(await r.db.activeSaleId())).items.length;
    out[`vazio_${empty}ms`]={trocas:SWAPS,registradas:items-1};await r.close();
  }
  return out;
}
// The next cup placed while the previous weighing is still being written.
async function slowDatabase(){
  const out={};
  for(const ms of [100,500,1000,2000]){
    let both=0;const tries=3;
    for(let i=0;i<tries;i++){
      const r=await rig();r.slow(ms);await r.sim.place(480,SETTLE);
      await wait(1700);await r.sim.remove(150);await wait(1200);await r.sim.place(350,SETTLE);
      await wait(ms*2+3500);if((await r.db.getDraftSale(await r.db.activeSaleId())).items.length===2)both++;await r.close();
    }
    out[`banco_${ms}ms`]={tentativas:tries,com_as_duas_pesagens:both};
  }
  return out;
}
(async()=>{
  const result={root,quando:new Date().toISOString(),node:process.version,latencia:await latency(),trocas:await swaps(),bancoLento:await slowDatabase()};
  console.log(JSON.stringify(result,null,2));
  if(arg('json'))fs.writeFileSync(arg('json'),JSON.stringify(result,null,2));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
