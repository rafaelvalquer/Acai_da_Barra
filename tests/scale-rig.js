'use strict';
// The PDV as installed (store, till sign-in, server) on a simulated serial scale. options go to ScaleDriver: with none
// the driver runs with its production timing.
const {tempStore,until,wait}=require('./helpers');const {posAuth}=require('./pos-helpers');
const {ScaleDriver}=require('../src/scale');const {createServer}=require('../src/server');const {scaleSimulator}=require('./serial-sim');
async function scaleRig({open=true,options={},sim=scaleSimulator(),http=false}={}){
  const box=await tempStore('luminor-pesagem-');const db=box.s;
  const operator=(await db.saveEmployee({name:'Ana'})).id;if(open)await db.openShift('0',operator);
  const pos=await posAuth(db);const me=await pos.signIn('Ana');
  const scale=new ScaleDriver({SerialPort:sim.SerialPort,...options});
  const server=createServer({db,scale,auth:pos.auth,simulator:'off'});
  const r={db,scale,sim,pos,me,operator,server,
    // Items of a sale (default: the one on the scale).
    async items(saleId){const id=saleId||await db.activeSaleId();return id?(await db.getDraftSale(id)).items:[];},
    async waitItems(n,ms=5000,saleId){await until(async()=>(await r.items(saleId)).length>=n,ms);return r.items(saleId);},
    // Every write of a weighing takes this long (a slow disk or a busy database).
    slowDatabase(ms){const sales=db.ctx.sales,add=sales.addWeighed;sales.addWeighed=async function(...a){await wait(ms);return add.apply(this,a);};},
    async connect(){await scale.connect('COM9',2400);await until(()=>scale.snapshot().status==='stable'||scale.snapshot().status==='unstable');},
    async clean(){scale.disconnect();await server.settle();if(http){server.closeAllConnections();await new Promise(x=>server.close(x));}await pos.close();await box.clean();}};
  if(http){
    await new Promise(x=>server.listen(0,'127.0.0.1',x));const base=`http://127.0.0.1:${server.address().port}`;
    const {token}=await (await fetch(base+'/api/session')).json();
    r.get=async(p,cookie=me.cookie)=>{const x=await fetch(base+p,{headers:cookie?{Cookie:cookie}:{}});return {status:x.status,body:await x.json()};};
    r.post=async(p,body={},cookie=me.cookie)=>{const x=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':token,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});return {status:x.status,body:await x.json()};};
  }
  return r;
}
module.exports={scaleRig};
