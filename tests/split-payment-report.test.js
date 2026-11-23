'use strict';
// The day, week and month reports with sales paid in parts: revenue by the sales' own totals, the split by method from
// the parts, every sale counted once. SQLite and PostgreSQL.
const test=require('node:test'),assert=require('node:assert/strict');
const {till,draftOf,part,uid,pay}=require('./split-helpers');

async function sales(s){
  await pay(s,await draftOf(s,'50,00'),[part('cash','20,00'),part('pix','30,00')]);
  await pay(s,await draftOf(s,'40,00'),[part('cash','10,00'),part('pix','10,00'),part('credit','10,00'),part('debit','10,00')]);
  const d=await draftOf(s,'25,00');await s.checkoutDraftSale(d.id,'credit',uid(),undefined,d.revision);
  const x=await pay(s,await draftOf(s,'10,00'),[part('cash','5,00'),part('pix','5,00')]);await s.cancelSale(x.sale.id,'Cancelada no teste');
}

test('PT01 the day report: revenue from the sales, methods from the parts, each sale counted once, canceled apart',async()=>{
  const t=await till();try{
    const {s}=t;await sales(s);
    const r=await s.report({period:'day'});
    assert.equal(r.totalCents,11500);assert.equal(r.count,3);assert.equal(r.avgTicketCents,Math.round(11500/3));
    assert.deepEqual(r.methods,{cash:3000,pix:4000,credit:3500,debit:1000});
    assert.equal(Object.values(r.methods).reduce((a,b)=>a+b,0),r.totalCents,'as formas somam o faturamento');
    assert.deepEqual([r.canceled.count,r.canceled.totalCents],[1,1000]);
    assert.deepEqual(r.byDay.map(d=>[d.count,d.totalCents]).filter(x=>x[0]),[[3,11500]]);
    assert.equal(r.byOperator.length,1);assert.deepEqual([r.byOperator[0].count,r.byOperator[0].totalCents],[3,11500]);
    assert.equal(r.sales.length,4);assert.equal(r.sales.filter(x=>x.method==='mixed').length,3);
  }finally{await t.clean();}
});

test('PT02 week and month reports give the same split, and the weight and manual lines are not doubled by the parts',async()=>{
  const t=await till();try{
    const {s}=t;await t.s.updateConfig({priceKg:'100,00'});
    const id=await s.activeSaleId();await s.addManualWeight(id,'0,500');const d={id,revision:(await s.getDraftSale(id)).revision};
    await pay(s,d,[part('cash','20,00'),part('pix','30,00')]);
    for(const period of ['week','month']){
      const r=await s.report({period});assert.equal(r.totalCents,5000);assert.equal(r.count,1);assert.deepEqual([r.methods.cash,r.methods.pix],[2000,3000]);
      assert.equal(r.grams,500,'peso contado uma vez');assert.deepEqual([r.manual.count],[1]);
    }
  }finally{await t.clean();}
});

test('PT03 the history lists a sale paid in parts once, as "mixed", and its detail has the parts',async()=>{
  const t=await till();try{
    const {s}=t;await sales(s);
    const h=await s.salesHistory({});assert.equal(h.sales.length,4);assert.deepEqual([...new Set(h.sales.map(x=>x.method))].sort(),['credit','mixed']);
    const mixed=h.sales.find(x=>x.method==='mixed'&&x.status==='done'&&x.total_cents===5000);
    const detail=await s.saleDetail(mixed.id);assert.deepEqual(detail.payments.map(p=>[p.method,p.amountCents]),[['cash',2000],['pix',3000]]);
    const found=await s.salesHistory({q:String(mixed.id)});assert.equal(found.sales.length,1);
  }finally{await t.clean();}
});
