'use strict';
// The close by payment method with sales paid in parts: the expected amount of each method is the sum of its parts, the
// drawer is opening + cash parts + supplies - withdrawals, the Elgin i9 report prints the same numbers, and the blind close
// stays blind. SQLite and PostgreSQL.
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {till,draftOf,part,uid,pay}=require('./split-helpers');
const {closingLines}=require('../src/printing/ThermalReceiptBuilder');
const {tillServer}=require('./pos-helpers');const {DEFAULTS}=require('../src/auth/PermissionCatalog');
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.result;};
const rows=items=>items.map(i=>[i.method,i.expectedCents,i.countedCents,i.differenceCents]);

// Opening R$ 100,00. Sales: A 50,00 = cash 20,00 + pix 30,00; B 40,00 = four parts of 10,00; C 25,00 credit; D 10,00 cash + pix canceled.
// Supply 15,00 and withdrawal 5,00.
async function busyShift(s){
  await pay(s,await draftOf(s,'50,00'),[part('cash','20,00','50,00'),part('pix','30,00')]);
  await pay(s,await draftOf(s,'40,00'),[part('cash','10,00'),part('pix','10,00'),part('credit','10,00'),part('debit','10,00')]);
  await pay(s,await draftOf(s,'25,00'),[part('credit','25,00')]);
  const d=await pay(s,await draftOf(s,'10,00'),[part('cash','5,00'),part('pix','5,00')]);await s.cancelSale(d.sale.id,'Cancelada no teste');
  await s.moveCash('supply','15,00');await s.moveCash('withdrawal','5,00');
}

test('PR01 expected per method is the sum of the parts, the drawer follows the cash parts, and canceled sales count nowhere',async()=>{
  const t=await till();try{
    const {s}=t;await busyShift(s);
    const sum=await s.cashSummary();
    assert.deepEqual(sum.methods,{cash:3000,pix:4000,credit:3500,debit:1000});assert.equal(sum.expectedCents,10000+3000+1500-500);
    assert.deepEqual([sum.salesCount,sum.canceledCount,sum.totalCents],[3,1,11500]);
    const r=await s.closeShift({cash:'136,00',pix:'40,00',credit:'35,00',debit:'10,00'},{idempotencyKey:'k-'+uid()});
    const rec=r.reconciliation;
    assert.deepEqual(rows(rec.items),[['cash',14000,13600,-400],['pix',4000,4000,0],['credit',3500,3500,0],['debit',1000,1000,0]]);
    assert.deepEqual([rec.totals.revenueCents,rec.totals.salesCount,rec.totals.canceledCount,rec.totals.expectedCents],[11500,3,1,22500]);
    assert.deepEqual([rec.cash.openingCents,rec.cash.cashSalesCents,rec.cash.suppliesCents,rec.cash.withdrawalsCents],[10000,3000,1500,500]);
    // The saved snapshot never changes with the sales: cancelling nothing later can move it, and it is read back as saved.
    const again=await s.getConfirmedReport({shiftId:rec.shiftId});assert.deepEqual(rows(again.items),rows(rec.items));
  }finally{await t.clean();}
});

test('PR02 sales paid in a single method give the same numbers as before: nothing shifts for the old way of paying',async()=>{
  const t=await till();try{
    const {s}=t;
    for(const [m,v] of [['cash','10,00'],['pix','20,00'],['credit','30,00'],['debit','40,00']]){const d=await draftOf(s,v);await s.checkoutDraftSale(d.id,m,uid(),undefined,d.revision);}
    const r=await s.closeShift({cash:'110,00',pix:'20,00',credit:'30,00',debit:'40,00'},{idempotencyKey:'k-'+uid()});
    assert.deepEqual(rows(r.reconciliation.items),[['cash',11000,11000,0],['pix',2000,2000,0],['credit',3000,3000,0],['debit',4000,4000,0]]);
    assert.equal(r.reconciliation.totals.salesCount,4);
  }finally{await t.clean();}
});

test('PR03 the Elgin i9 report prints the expected and counted amounts of the four methods from the parts',async()=>{
  const t=await till();try{
    const {s}=t;await busyShift(s);
    const r=await s.closeShift({cash:'140,00',pix:'40,00',credit:'35,00',debit:'10,00'},{idempotencyKey:'k-'+uid()});
    const text=closingLines(r.reconciliation,{width:48}).join('\n');
    for(const w of ['DINHEIRO','PIX','CREDITO','DEBITO','140,00','40,00','35,00','10,00','115,00','225,00'])assert.ok(text.includes(w),`${w} em\n${text}`);
    for(const l of closingLines(r.reconciliation,{width:32}))assert.ok([...l].length<=32,l);
  }finally{await t.clean();}
});

test('PR04 a shift closed before the update is read as it was saved, and a new close after the update uses the parts',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'30,00');await s.checkoutDraftSale(d.id,'cash',uid(),undefined,d.revision);
    const first=await s.closeShift({cash:'130,00',pix:'0,00',credit:'0,00',debit:'0,00'},{idempotencyKey:'k-'+uid()});
    await s.openShift('50,00',t.ana);await pay(s,await draftOf(s,'20,00'),[part('cash','5,00'),part('pix','15,00')]);
    const second=await s.closeShift({cash:'55,00',pix:'15,00',credit:'0,00',debit:'0,00'},{idempotencyKey:'k-'+uid()});
    assert.deepEqual(rows(second.reconciliation.items),[['cash',5500,5500,0],['pix',1500,1500,0],['credit',0,0,0],['debit',0,0,0]]);
    assert.deepEqual(rows((await s.getConfirmedReport({shiftId:first.reconciliation.shiftId})).items),rows(first.reconciliation.items));
  }finally{await t.clean();}
});

test('PR05 the blind close of a sale paid in parts answers only Conferido, Falta or Sobra and reveals no amount',async()=>{
  const t=await tillServer();await t.db.updateConfig({priceKg:'100,00'});try{
    const c=await t.signIn('Carla',DEFAULTS.filter(p=>p!=='cash.reconciliation.view_confirmed'));ok(await t.post('/api/shift/open',{opening:'200,00'},c));
    const st=(await t.get('/api/state',c)).body;ok(await t.post('/api/cart/manual-weight',{saleId:st.activeSaleId,weight:'0,500'},c));
    const rev=(await t.get('/api/state',c)).body.activeSale.revision;
    ok(await t.post('/api/checkout',{saleId:st.activeSaleId,revision:rev,uuid:randomUUID(),payments:[{method:'cash',amount:'20,00'},{method:'pix',amount:'30,00'}]},c));
    const state=(await t.get('/api/state',c)).body;
    assert.equal(state.cash.blind,true);assert.equal(state.cash.methods,undefined);assert.equal(state.cash.expectedCents,undefined);assert.equal(state.cash.salesCount,1);
    const shiftId=(await t.db.shift()).id;
    const r=ok(await t.post('/api/shift/close',{shiftId,idempotencyKey:'k-'+randomUUID(),counted:{cash:'220,00',pix:'30,00',credit:'0,00',debit:'0,00'}},c));
    assert.equal(r.blind,true);assert.equal(r.report,null);
    const text=JSON.stringify(r);assert.ok(!/"expectedCents"|"methods"|"revenueCents"|"payments"/.test(text),text);
  }finally{await t.close();}
});
