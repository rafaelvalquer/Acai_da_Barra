'use strict';
// POST /api/checkout with a list of payments, through the HTTP server: the contract, the permission, and what a blind
// operator never gets (src/auth/CashVisibilityPolicy.js). SQLite and PostgreSQL.
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {tillServer}=require('./pos-helpers');const {DEFAULTS}=require('../src/auth/PermissionCatalog');
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.result;};
const tillOf=async()=>{const t=await tillServer();await t.db.updateConfig({priceKg:'100,00'});return t;};
// A sale of R$ 50,00 (0,500 kg at R$ 100,00/kg) on the till.
async function cart(t,cookie,kg='0,500'){const st=(await t.get('/api/state',cookie)).body;ok(await t.post('/api/cart/manual-weight',{saleId:st.activeSaleId,weight:kg},cookie));
  const s2=(await t.get('/api/state',cookie)).body;return {saleId:st.activeSaleId,revision:s2.activeSale.revision};}

test('PH01 the new contract pays in parts and answers with the sale, its parts and the next active sale',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);ok(await t.post('/api/shift/open',{opening:'100,00'},c));
    const {saleId,revision}=await cart(t,c);const uuid=randomUUID();
    const body={saleId,revision,uuid,payments:[{method:'cash',amount:'20,00',received:'50,00'},{method:'pix',amount:'30,00'}]};
    const r=ok(await t.post('/api/checkout',body,c));
    assert.equal(r.duplicate,false);assert.equal(r.sale.method,'mixed');assert.equal(r.sale.total_cents,5000);
    assert.deepEqual(r.sale.payments.map(p=>[p.method,p.amountCents,p.receivedCents,p.changeCents]),[['cash',2000,5000,3000],['pix',3000,null,null]]);
    assert.ok(r.activeSaleId&&r.activeSaleId!==saleId);
    // The same request again (a lost answer, a double click): the same sale, flagged as repeated.
    const again=ok(await t.post('/api/checkout',body,c));assert.equal(again.duplicate,true);assert.equal(again.sale.id,r.sale.id);assert.equal(again.sale.payments.length,2);
    assert.equal((await t.db.adapter.get('SELECT COUNT(*) AS n FROM sales')).n,1);
  }finally{await t.close();}
});

test('PH02 the contract of before still works: one method, with the amount received for cash',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);ok(await t.post('/api/shift/open',{opening:'100,00'},c));
    const {saleId,revision}=await cart(t,c);
    const r=ok(await t.post('/api/checkout',{saleId,revision,method:'cash',received:'60,00',uuid:randomUUID()},c));
    assert.deepEqual([r.sale.method,r.sale.received_cents,r.sale.change_cents],['cash',6000,1000]);assert.deepEqual(r.sale.payments.map(p=>p.method),['cash']);
  }finally{await t.close();}
});

test('PH03 wrong sums, repeated methods and conflicts answer 400 with a message, and write nothing',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);ok(await t.post('/api/shift/open',{opening:'100,00'},c));
    const {saleId,revision}=await cart(t,c);
    const tries=[[{payments:[{method:'cash',amount:'20,00'},{method:'pix',amount:'20,00'}]},/menor que o total/],[{payments:[{method:'cash',amount:'30,00'},{method:'pix',amount:'30,00'}]},/maior que o total/],
      [{payments:[{method:'pix',amount:'25,00'},{method:'pix',amount:'25,00'}]},/mais de uma vez/],[{payments:[{method:'pix',amount:'-50,00'}]},/negativo/],[{payments:[{method:'pix',amount:'0,00'},{method:'cash',amount:'50,00'}]},/maior que zero/],
      [{method:'cash',payments:[{method:'pix',amount:'50,00'}]},/não confere/],[{payments:'pix'},/inválidas/],[{payments:[{method:'cash',amount:'50,00',received:'10,00'}]},/menor/]];
    for(const [extra,re] of tries){const r=await t.post('/api/checkout',{saleId,revision,uuid:randomUUID(),...extra},c);assert.equal(r.status,400,JSON.stringify(extra));assert.match(r.body.error||r.body.message||JSON.stringify(r.body),re);}
    assert.equal((await t.db.adapter.get('SELECT COUNT(*) AS n FROM sales')).n,0);assert.equal((await t.db.adapter.get('SELECT COUNT(*) AS n FROM sale_payments')).n,0);
    const stale=await t.post('/api/checkout',{saleId,revision:revision-1,uuid:randomUUID(),payments:[{method:'pix',amount:'50,00'}]},c);assert.equal(stale.status,400);assert.match(JSON.stringify(stale.body),/mudou depois da conferência/);
  }finally{await t.close();}
});

test('PH04 without "sales.checkout" the payment in parts is refused like any charge',async()=>{
  const t=await tillOf();try{
    const boss=await t.signIn('Chefe',DEFAULTS);ok(await t.post('/api/shift/open',{opening:'100,00'},boss));const {saleId,revision}=await cart(t,boss);
    const weak=await t.signIn('Eva',DEFAULTS.filter(p=>p!=='sales.checkout'));
    const r=await t.post('/api/checkout',{saleId,revision,uuid:randomUUID(),payments:[{method:'cash',amount:'20,00'},{method:'pix',amount:'30,00'}]},weak);assert.equal(r.status,403);
    assert.equal((await t.db.adapter.get('SELECT COUNT(*) AS n FROM sales')).n,0);
  }finally{await t.close();}
});

test('PH05 a blind operator pays in parts but the history, the detail and the report carry no method, no amount per method and no parts',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);ok(await t.post('/api/shift/open',{opening:'100,00'},c));
    const {saleId,revision}=await cart(t,c);
    const r=ok(await t.post('/api/checkout',{saleId,revision,uuid:randomUUID(),payments:[{method:'cash',amount:'20,00',received:'20,00'},{method:'credit',amount:'30,00'}]},c));
    assert.equal(r.sale.payments.length,2,'quem cobrou vê a própria cobrança');
    const hist=(await t.get('/api/sales',c)).body;const detail=(await t.get(`/api/sales/detail?id=${r.sale.id}`,c)).body;
    for(const x of [...hist.sales,detail]){assert.equal(x.method,null);assert.equal(x.received_cents,null);assert.equal(x.change_cents,null);}
    assert.deepEqual(detail.payments,[]);
    const text=JSON.stringify([hist,detail]);assert.ok(!/"amountCents"|"amount_cents"|"pix"|"credit"|"mixed"/.test(text),text);
    const boss=await t.signInAdmin();const full=(await t.get(`/api/sales/detail?id=${r.sale.id}`,boss)).body;
    assert.equal(full.method,'mixed');assert.deepEqual(full.payments.map(p=>[p.method,p.amountCents]),[['cash',2000],['credit',3000]]);
    const rep=(await t.get('/api/report?period=day',c)).body;assert.equal(rep.methods,undefined);assert.equal(rep.sales,undefined);
    const adminReport=(await t.get('/api/report?period=day',boss)).body;assert.deepEqual([adminReport.methods.cash,adminReport.methods.credit,adminReport.count],[2000,3000,1]);
  }finally{await t.close();}
});

test('PH06 cancelling through the API hides the parts from a blind operator and keeps them for the administrator',async()=>{
  const t=await tillOf();try{
    const blind=await t.signIn('Bia',[...DEFAULTS,'sales.cancel']);ok(await t.post('/api/shift/open',{opening:'100,00'},blind));
    const {saleId,revision}=await cart(t,blind);
    const r=ok(await t.post('/api/checkout',{saleId,revision,uuid:randomUUID(),payments:[{method:'cash',amount:'20,00'},{method:'debit',amount:'30,00'}]},blind));
    const c=ok(await t.post('/api/sales/cancel',{id:r.sale.id,reason:'Cliente desistiu'},blind));
    assert.equal(c.status,'canceled');assert.equal(c.method,null);assert.deepEqual(c.payments,[]);
    const admin=await t.signInAdmin();
    const kept=(await t.get(`/api/sales/detail?id=${r.sale.id}`,admin)).body;assert.deepEqual(kept.payments.map(p=>p.method),['cash','debit']);
  }finally{await t.close();}
});
