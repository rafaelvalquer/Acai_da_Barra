'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const {Store}=require('../src/db');const {ScaleDriver}=require('../src/scale');const {createServer}=require('../src/server');
// Real HTTP server on a random port with a throwaway database, exercised the way the browser does.
async function boot(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-http-'));const db=new Store(path.join(dir,'http.sqlite'));const scale=new ScaleDriver();
 const server=createServer({db,scale});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const get=async p=>{const r=await fetch(base+p);return {status:r.status,body:await r.json()};};
 const {token}=(await get('/api/session')).body;
 const post=async(p,body={},headers={})=>{const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':token,...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 return {db,scale,server,base,get,post,async close(){scale.disconnect();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
async function openWithOperator(t,opening='0,00'){const op=(await t.post('/api/employees/save',{name:'Carla'})).body.result.id;assert.equal((await t.post('/api/shift/open',{opening,operatorId:op})).status,200);return op;}

test('writes need the session token and requests must come from the local host',async()=>{
 const t=await boot();try{
  const r=await fetch(t.base+'/api/shift/open',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
  assert.equal((await t.post('/api/shift/open',{},{'X-Luminor-Token':'errado'})).status,403);
  const status=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:t.server.address().port,path:'/api/state',headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(status,403);
  for(const file of ['/','/app.js','/style.css','/logo.svg','/fonts/work-sans.woff2'])assert.equal((await fetch(t.base+file)).status,200,file);
  assert.equal((await fetch(t.base+'/../src/db.js')).status,404);
 }finally{await t.close();}
});
test('full flow: automatic weighing, product, payment and closing',async()=>{
 const t=await boot();try{
  await openWithOperator(t,'50,00');
  assert.equal((await t.post('/api/scale/demo')).status,200);
  await t.post('/api/scale/demo-weight',{grams:840});
  let state=(await t.get('/api/state')).body;assert.equal(state.cart.length,1);assert.equal(state.cart[0].grams,840);assert.equal(state.operator.name,'Carla');
  // Same cup still on the plate: no second item.
  await t.post('/api/scale/demo-weight',{grams:840});
  assert.equal((await t.post('/api/cart/weight')).status,400);
  await t.post('/api/scale/demo-weight',{grams:0});await t.post('/api/scale/demo-weight',{grams:420});
  const product=(await t.post('/api/products/save',{name:'Água sem gás',price:'5,00',stock:10})).body.result.id;
  await t.post('/api/cart/unit',{id:product,quantity:1});
  await t.post('/api/cart/manual-weight',{weight:'0,300'});
  state=(await t.get('/api/state')).body;
  assert.deepEqual(state.cart.map(x=>x.totalCents),[5452,2726,500,1947]);assert.equal(state.cartTotalCents,10625);
  const sale=(await t.post('/api/checkout',{method:'cash',uuid:randomUUID()})).body.result.sale;
  assert.equal(sale.total_cents,10625);
  await t.post('/api/cart/manual-value',{amount:'18,00'});
  const pix=(await t.post('/api/checkout',{method:'pix',uuid:randomUUID()})).body.result.sale;
  assert.equal(pix.total_cents,1800);
  state=(await t.get('/api/state')).body;assert.equal(state.cart.length,0);assert.equal(state.cash.expectedCents,5000+10625);
  const report=(await t.get('/api/report?period=day')).body;assert.equal(report.count,2);assert.equal(report.methods.cash,10625);assert.equal(report.methods.pix,1800);assert.equal(report.manual.count,2);
  const closed=(await t.post('/api/shift/close',{counted:'156,25'})).body.result;
  assert.equal(closed.differenceCents,0);assert.deepEqual(closed.methods,{cash:10625,pix:1800,debit:0,credit:0});
  assert.equal((await t.post('/api/checkout',{method:'cash',uuid:randomUUID()})).status,400);
 }finally{await t.close();}
});
test('double click on finalize records a single sale',async()=>{
 const t=await boot();try{
  await openWithOperator(t);
  await t.post('/api/cart/manual-value',{amount:'20,00'});
  const uuid=randomUUID();
  const same=await Promise.all([t.post('/api/checkout',{method:'pix',uuid}),t.post('/api/checkout',{method:'pix',uuid})]);
  assert.deepEqual(same.map(r=>r.status),[200,200]);assert.deepEqual(same.map(r=>r.body.result.duplicate).sort(),[false,true]);
  await t.post('/api/cart/manual-value',{amount:'30,00'});
  const different=await Promise.all([t.post('/api/checkout',{method:'cash',uuid:randomUUID()}),t.post('/api/checkout',{method:'cash',uuid:randomUUID()})]);
  assert.deepEqual(different.map(r=>r.status).sort(),[200,400]);assert.match(different.find(r=>r.status===400).body.error,/Carrinho vazio/);
  assert.equal(t.db.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,2);
  assert.equal((await t.get('/api/report')).body.totalCents,5000);
 }finally{await t.close();}
});
test('history, cancel and correct through the API',async()=>{
 const t=await boot();try{
  await openWithOperator(t);
  await t.post('/api/cart/manual-weight',{weight:'0,500'});
  const sale=(await t.post('/api/checkout',{method:'debit',uuid:randomUUID()})).body.result.sale;
  const list=(await t.get('/api/sales')).body.sales;assert.equal(list.length,1);assert.equal(list[0].operator_name,'Carla');assert.equal(list[0].has_manual,1);
  const detail=(await t.get(`/api/sales/detail?id=${sale.id}`)).body;assert.equal(detail.items.length,1);assert.equal(detail.cancelable,true);
  assert.equal((await t.post('/api/sales/cancel',{id:sale.id,reason:''})).status,400);
  const corrected=(await t.post('/api/sales/correct',{id:sale.id,reason:'Peso digitado errado'})).body.result;
  assert.equal(corrected.sale.status,'canceled');assert.equal(corrected.cart.length,1);
  assert.equal((await t.post('/api/sales/cancel',{id:sale.id,reason:'de novo'})).status,400);
  assert.equal((await t.get('/api/sales?status=canceled')).body.sales.length,1);
  assert.equal((await t.get('/api/sales/detail?id=999')).status,400);
  assert.equal((await t.get('/api/report?period=week')).body.canceled.count,1);
 }finally{await t.close();}
});
