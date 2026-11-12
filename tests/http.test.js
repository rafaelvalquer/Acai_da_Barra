'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const {ScaleDriver}=require('../src/scale');const {createServer}=require('../src/server');const {tempStore,count}=require('./helpers');const {posAuth}=require('./pos-helpers');
// Real HTTP server on a random port with a throwaway database, exercised the way the browser does, by Carla signed
// in at the till with every permission.
async function boot(){
 const box=await tempStore('luminor-http-');const db=box.s;const scale=new ScaleDriver();
 const pos=await posAuth(db);const me=await pos.signIn('Carla');
 const server=createServer({db,scale,auth:pos.auth,simulator:'open'});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const get=async(p,cookie=me.cookie)=>{const r=await fetch(base+p,{headers:cookie?{Cookie:cookie}:{}});return {status:r.status,body:await r.json()};};
 const {token}=(await get('/api/session')).body;
 const post=async(p,body={},headers={},cookie=me.cookie)=>{const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':token,...(cookie?{Cookie:cookie}:{}),...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 return {db,scale,server,base,get,post,pos,me,async close(){scale.disconnect();server.closeAllConnections();await new Promise(r=>server.close(r));await pos.close();await box.clean();}};
}
async function openWithOperator(t,opening='0,00'){assert.equal((await t.post('/api/shift/open',{opening})).status,200);return t.me.id;}

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
const active=async t=>(await t.get('/api/state')).body.activeSaleId;
test('full flow: automatic weighing, product, payment and closing',async()=>{
 const t=await boot();try{
  await openWithOperator(t,'50,00');
  assert.equal((await t.post('/api/scale/demo')).status,200);
  await t.post('/api/scale/demo-weight',{grams:840});
  let state=(await t.get('/api/state')).body;assert.equal(state.cart.length,1);assert.equal(state.cart[0].grams,840);assert.equal(state.operator.name,'Carla');
  const saleId=state.activeSaleId;assert.equal(state.activeSale.label,'Venda 01');assert.deepEqual(state.openSales.map(d=>d.label),['Venda 01']);
  // Same cup still on the plate: no second item.
  await t.post('/api/scale/demo-weight',{grams:840});
  assert.equal((await t.post('/api/cart/weight',{saleId})).status,400);
  await t.post('/api/scale/demo-weight',{grams:0});await t.post('/api/scale/demo-weight',{grams:420});
  const product=(await t.post('/api/products/save',{name:'Água sem gás',price:'5,00',stock:10})).body.result.id;
  await t.post('/api/cart/unit',{saleId,id:product,quantity:1});
  await t.post('/api/cart/manual-weight',{saleId,weight:'0,300'});
  state=(await t.get('/api/state')).body;
  assert.deepEqual(state.cart.map(x=>x.totalCents),[5452,2726,500,1947]);assert.equal(state.cartTotalCents,10625);
  const short=await t.post('/api/checkout',{saleId,method:'cash',uuid:randomUUID(),received:'100,00'});
  assert.equal(short.status,400);assert.match(short.body.error,/Valor recebido menor/);
  const paid=(await t.post('/api/checkout',{saleId,method:'cash',uuid:randomUUID(),received:'110,00',revision:state.activeSale.revision})).body.result;const sale=paid.sale;
  assert.equal(sale.total_cents,10625);assert.equal(sale.received_cents,11000);assert.equal(sale.change_cents,375);assert.equal(sale.draft_sale_id,saleId);
  assert.notEqual(paid.activeSaleId,saleId);
  assert.equal(await count(t.db,'sales'),1);
  const next=await active(t);await t.post('/api/cart/manual-value',{saleId:next,amount:'18,00'});
  const pix=(await t.post('/api/checkout',{saleId:next,method:'pix',uuid:randomUUID()})).body.result.sale;
  assert.equal(pix.total_cents,1800);
  state=(await t.get('/api/state')).body;assert.equal(state.cart.length,0);assert.equal(state.cash.expectedCents,5000+10625);
  const report=(await t.get('/api/report?period=day')).body;assert.equal(report.count,2);assert.equal(report.methods.cash,10625);assert.equal(report.methods.pix,1800);assert.equal(report.manual.count,2);
  const closed=(await t.post('/api/shift/close',{counted:'156,25'})).body.result;
  assert.equal(closed.differenceCents,0);assert.deepEqual(closed.methods,{cash:10625,pix:1800,debit:0,credit:0});
  assert.equal((await t.post('/api/checkout',{saleId:next,method:'cash',uuid:randomUUID()})).status,400);
  assert.deepEqual((await t.get('/api/open-sales')).body,{activeSaleId:null,sales:[]});
 }finally{await t.close();}
});
test('double click on charge records a single sale',async()=>{
 const t=await boot();try{
  await openWithOperator(t);
  let saleId=await active(t);await t.post('/api/cart/manual-value',{saleId,amount:'20,00'});
  const uuid=randomUUID();
  const same=await Promise.all([t.post('/api/checkout',{saleId,method:'pix',uuid}),t.post('/api/checkout',{saleId,method:'pix',uuid})]);
  assert.deepEqual(same.map(r=>r.status),[200,200]);assert.deepEqual(same.map(r=>r.body.result.duplicate).sort(),[false,true]);
  // Two different requests for the same open sale still make one sale: the open sale is referenced once.
  saleId=await active(t);await t.post('/api/cart/manual-value',{saleId,amount:'30,00'});
  const different=await Promise.all([t.post('/api/checkout',{saleId,method:'cash',uuid:randomUUID()}),t.post('/api/checkout',{saleId,method:'cash',uuid:randomUUID()})]);
  assert.deepEqual(different.map(r=>r.status),[200,200]);assert.equal(different[0].body.result.sale.id,different[1].body.result.sale.id);
  assert.equal(await count(t.db,'sales'),2);
  assert.equal((await t.get('/api/report')).body.totalCents,5000);
 }finally{await t.close();}
});
test('history, cancel and correct through the API',async()=>{
 const t=await boot();try{
  await openWithOperator(t);
  const saleId=await active(t);await t.post('/api/cart/manual-weight',{saleId,weight:'0,500'});
  const sale=(await t.post('/api/checkout',{saleId,method:'debit',uuid:randomUUID()})).body.result.sale;
  const list=(await t.get('/api/sales')).body.sales;assert.equal(list.length,1);assert.equal(list[0].operator_name,'Carla');assert.equal(list[0].has_manual,1);
  const detail=(await t.get(`/api/sales/detail?id=${sale.id}`)).body;assert.equal(detail.items.length,1);assert.equal(detail.cancelable,true);assert.equal(detail.draft_label,'Venda 01');
  assert.equal((await t.post('/api/sales/cancel',{id:sale.id,reason:''})).status,400);
  const corrected=(await t.post('/api/sales/correct',{id:sale.id,reason:'Peso digitado errado'})).body.result;
  assert.equal(corrected.sale.status,'canceled');assert.equal(corrected.draft.items.length,1);
  // The scale is empty (offline), so the correction is selected right away.
  assert.equal(corrected.selected,true);assert.equal(await active(t),corrected.draft.id);
  assert.equal((await t.post('/api/sales/cancel',{id:sale.id,reason:'de novo'})).status,400);
  assert.equal((await t.get('/api/sales?status=canceled')).body.sales.length,1);
  assert.equal((await t.get('/api/sales/detail?id=999')).status,400);
  assert.equal((await t.get('/api/report?period=week')).body.canceled.count,1);
 }finally{await t.close();}
});
