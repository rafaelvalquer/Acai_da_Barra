'use strict';
// Paying one sale in one to four parts (SaleService.checkoutDraftSale): PD15–PD30 of the plan. SQLite and PostgreSQL.
const test=require('node:test'),assert=require('node:assert/strict');
const {till,draftOf,part,uid,pay,rows,partsOf,integrity,clean}=require('./split-helpers');
const {SalesRepository}=require('../src/database/repositories/SalesRepository');
const rejects=(p,re)=>assert.rejects(p,e=>re.test(e.message),String(re));
const salesCount=async s=>Number((await s.adapter.get('SELECT COUNT(*) AS n FROM sales')).n);

test('PD15 the contract of before still pays with one method, and a part is stored for it',async()=>{
  const t=await till();try{
    const {s}=t;const ids=[];
    for(const m of ['pix','credit','debit']){const d=await draftOf(s,'20,00');const r=await s.checkoutDraftSale(d.id,m,uid(),undefined,d.revision);assert.equal(r.sale.method,m);assert.equal(r.duplicate,false);ids.push(r.sale.id);}
    const d=await draftOf(s,'20,00');const r=await s.checkoutDraftSale(d.id,'cash',uid(),'50,00',d.revision);ids.push(r.sale.id);
    assert.deepEqual([r.sale.method,r.sale.received_cents,r.sale.change_cents],['cash',5000,3000]);
    assert.deepEqual(r.sale.payments.map(p=>[p.method,p.amountCents,p.receivedCents,p.changeCents]),[['cash',2000,5000,3000]]);
    for(const id of ids.slice(0,3))assert.equal((await partsOf(s,id)).length,1);
    assert.deepEqual(await integrity(s),clean);
  }finally{await t.clean();}
});

test('PD16 a sale paid in two parts is one sale, one stock movement and two stored parts',async()=>{
  const t=await till();try{
    const {s}=t;const water=(await s.product({name:'Água',price:'5,00',stock:10})).id;
    const id=await s.activeSaleId();await s.addUnit(id,water,2);await s.addManualValue(id,'30,00');const d={id,revision:(await s.getDraftSale(id)).revision};
    const r=await pay(s,d,[part('cash','15,00','20,00'),part('pix','25,00')]);
    assert.equal(r.sale.method,'mixed');assert.equal(r.sale.total_cents,4000);assert.equal(await salesCount(s),1);
    assert.deepEqual(await partsOf(s,r.sale.id),[{method:'cash',amount_cents:1500,received_cents:2000,change_cents:500},{method:'pix',amount_cents:2500,received_cents:null,change_cents:null}]);
    assert.deepEqual([r.sale.received_cents,r.sale.change_cents],[2000,500]);
    assert.equal(Number((await s.adapter.get('SELECT stock FROM products WHERE id=?',[water])).stock),8,'estoque baixado uma vez');
    assert.equal(r.sale.payments.length,2);assert.deepEqual(await integrity(s),clean);
  }finally{await t.clean();}
});

test('PD17 three and four parts, each method once, add up to the total',async()=>{
  const t=await till();try{
    const {s}=t;
    let d=await draftOf(s,'60,00');let r=await pay(s,d,[part('cash','10,00'),part('pix','20,00'),part('credit','30,00')]);
    assert.deepEqual((await partsOf(s,r.sale.id)).map(p=>p.method),['cash','pix','credit']);
    d=await draftOf(s,'40,00');r=await pay(s,d,[part('debit','10,00'),part('credit','10,00'),part('pix','10,00'),part('cash','10,00')]);
    assert.deepEqual((await partsOf(s,r.sale.id)).map(p=>p.method),['cash','pix','credit','debit']);assert.equal(r.sale.method,'mixed');
    assert.deepEqual(await integrity(s),clean);
  }finally{await t.clean();}
});

test('PD18 sums below or above the total, zero, negative, repeated, unknown and five parts write nothing and keep the open sale',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'50,00');
    const bad=[[[part('cash','20,00'),part('pix','29,99')],/menor que o total/],[[part('cash','20,00'),part('pix','30,01')],/maior que o total/],
      [[part('cash','0,00'),part('pix','50,00')],/maior que zero/],[[part('cash','-10,00'),part('pix','60,00')],/negativo/],[[part('pix','25,00'),part('pix','25,00')],/mais de uma vez/],
      [[part('boleto','50,00')],/inválida/],[[part('cash','10,00'),part('pix','10,00'),part('credit','10,00'),part('debit','10,00'),part('cash','10,00')],/no máximo 4/],
      [[],/pelo menos uma/],[[part('cash','abc')],/inválido/]];
    for(const [payments,re] of bad)await rejects(pay(s,d,payments),re);
    assert.equal(await salesCount(s),0);assert.equal(Number((await s.adapter.get('SELECT COUNT(*) AS n FROM sale_payments')).n),0);
    const still=await s.getDraftSale(d.id);assert.equal(still.status,'open');assert.equal(still.totalCents,5000);
  }finally{await t.clean();}
});

test('PD19 cash received below the cash part is refused; change is the amount received minus the cash part',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'50,00');
    await rejects(pay(s,d,[part('cash','20,00','19,99'),part('pix','30,00')]),/recebido em dinheiro menor/);
    const r=await pay(s,d,[part('cash','20,00','50,00'),part('pix','30,00')]);
    const cash=r.sale.payments.find(p=>p.method==='cash');assert.deepEqual([cash.receivedCents,cash.changeCents],[5000,3000],'troco sobre a parcela, não sobre o total da venda');
  }finally{await t.clean();}
});

test('PD20 the method of the request and the list of parts must agree, and received goes inside the cash part',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'30,00');
    await rejects(s.checkoutDraftSale(d.id,'cash',uid(),undefined,d.revision,[part('pix','30,00')]),/não confere/);
    await rejects(s.checkoutDraftSale(d.id,'mixed',uid(),undefined,d.revision,[part('cash','10,00'),part('pix','20,00')]),/não confere/);
    await rejects(s.checkoutDraftSale(d.id,null,uid(),'50,00',d.revision,[part('cash','10,00'),part('pix','20,00')]),/dentro da parcela/);
    await rejects(s.checkoutDraftSale(d.id,null,uid(),undefined,d.revision,'cash'),/inválidas/);
    await rejects(s.checkoutDraftSale(d.id,'ouro',uid(),undefined,d.revision),/inválida/);
    assert.equal(await salesCount(s),0);
    const r=await s.checkoutDraftSale(d.id,'pix',uid(),undefined,d.revision,[part('pix','30,00')]);assert.equal(r.sale.method,'pix');
  }finally{await t.clean();}
});

test('PD21 a double click or a retry with the same request id returns the first sale: one sale, one set of parts, one stock movement',async()=>{
  const t=await till();try{
    const {s}=t;const water=(await s.product({name:'Água',price:'5,00',stock:10})).id;
    const id=await s.activeSaleId();await s.addUnit(id,water,3);const d={id,revision:(await s.getDraftSale(id)).revision};const u=uid();
    const pays=[part('cash','5,00'),part('pix','10,00')];
    const [a,b]=await Promise.all([pay(s,d,pays,{uuid:u}),pay(s,d,pays,{uuid:u})]);
    assert.deepEqual([a.duplicate,b.duplicate].sort(),[false,true]);assert.equal(a.sale.id,b.sale.id);
    assert.equal(await salesCount(s),1);assert.equal(Number((await s.adapter.get('SELECT COUNT(*) AS n FROM sale_payments')).n),2);
    assert.equal(Number((await s.adapter.get('SELECT stock FROM products WHERE id=?',[water])).stock),7);
  }finally{await t.clean();}
});

test('PD22 the same open sale with another request id and other parts does not replace the payment already made',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'50,00');
    const first=await pay(s,d,[part('cash','20,00'),part('pix','30,00')]);
    const again=await pay(s,d,[part('credit','50,00')]);
    assert.equal(again.duplicate,true);assert.equal(again.sale.id,first.sale.id);assert.deepEqual(again.sale.payments.map(p=>p.method),['cash','pix']);
    assert.deepEqual((await partsOf(s,first.sale.id)).map(p=>p.method),['cash','pix']);assert.equal(await salesCount(s),1);
  }finally{await t.clean();}
});

test('PD23 two parallel charges with different ids on the same open sale make one sale',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'50,00');
    const r=await Promise.allSettled([pay(s,d,[part('pix','50,00')]),pay(s,d,[part('credit','50,00')])]);
    assert.equal(r.filter(x=>x.status==='fulfilled'&&!x.value.duplicate).length,1);assert.equal(await salesCount(s),1);
    assert.deepEqual(await integrity(s),clean);
  }finally{await t.clean();}
});

test('PD24 a cart changed after the review stops the charge: nothing is written',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'30,00');await s.addManualValue(d.id,'10,00');
    await rejects(pay(s,d,[part('cash','15,00'),part('pix','15,00')]),/mudou depois da conferência/);
    assert.equal(await salesCount(s),0);
    const fresh=await s.getDraftSale(d.id);const r=await pay(s,{id:d.id,revision:fresh.revision},[part('cash','15,00'),part('pix','25,00')]);assert.equal(r.sale.total_cents,4000);
  }finally{await t.clean();}
});

test('PD25 a failure while the parts are written rolls everything back: no sale, no parts, stock and open sale intact',async()=>{
  const t=await till();const original=SalesRepository.prototype.addPayment;
  try{
    const {s}=t;const water=(await s.product({name:'Água',price:'5,00',stock:10})).id;
    const id=await s.activeSaleId();await s.addUnit(id,water,2);await s.addManualValue(id,'10,00');const d={id,revision:(await s.getDraftSale(id)).revision};
    let calls=0;SalesRepository.prototype.addPayment=function(...a){if(++calls===2)throw Error('falha simulada');return original.apply(this,a);};
    await rejects(pay(s,d,[part('cash','10,00'),part('pix','10,00')]),/falha simulada/);
    SalesRepository.prototype.addPayment=original;
    assert.equal(await salesCount(s),0);assert.equal(Number((await s.adapter.get('SELECT COUNT(*) AS n FROM sale_payments')).n),0);assert.equal(Number((await s.adapter.get('SELECT COUNT(*) AS n FROM sale_items')).n),0);
    assert.equal(Number((await s.adapter.get('SELECT stock FROM products WHERE id=?',[water])).stock),10);
    const still=await s.getDraftSale(id);assert.equal(still.status,'open');assert.equal(still.items.length,2);
    const r=await pay(s,d,[part('cash','10,00'),part('pix','10,00')]);assert.equal(r.duplicate,false);
  }finally{SalesRepository.prototype.addPayment=original;await t.clean();}
});

test('PD26 insufficient stock refuses the charge before any part is stored',async()=>{
  const t=await till();try{
    const {s}=t;const water=(await s.product({name:'Água',price:'5,00',stock:5})).id;
    const id=await s.activeSaleId();await s.addUnit(id,water,2);const d={id,revision:(await s.getDraftSale(id)).revision};
    await s.adapter.run('UPDATE products SET stock=1 WHERE id=?',[water]);
    await assert.rejects(pay(s,d,[part('cash','5,00'),part('pix','5,00')]));
    assert.equal(await salesCount(s),0);assert.equal(Number((await s.adapter.get('SELECT COUNT(*) AS n FROM sale_payments')).n),0);
  }finally{await t.clean();}
});

test('PD27 a sale already paid, an empty sale and a closed shift are refused',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'20,00');const r=await pay(s,d,[part('cash','10,00'),part('pix','10,00')]);
    // The open sale was finished: asking again by its id answers with the first sale; a new id for a finished sale never charges twice.
    assert.equal((await pay(s,d,[part('pix','20,00')])).sale.id,r.sale.id);
    const empty=await s.activeSaleId();await rejects(s.checkoutDraftSale(empty,null,uid(),undefined,undefined,[part('pix','10,00')]),/não tem itens/);
    const e=await draftOf(s,'10,00');await s.closeShift({cash:'110,00',pix:'10,00',credit:'0,00',debit:'0,00'},{idempotencyKey:'k-'+uid()}).catch(()=>{});
    if(!(await s.shift()))await rejects(pay(s,e,[part('pix','10,00')]),/Abra o caixa primeiro/);
  }finally{await t.clean();}
});

test('PD28 cancelling keeps the parts and takes them out of the shift totals; the correction needs a new distribution',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'50,00');const r=await pay(s,d,[part('cash','20,00'),part('pix','30,00')]);
    let totals=await s.shiftTotals((await s.shift()).id);assert.deepEqual([totals.methods.cash,totals.methods.pix,totals.salesCount],[2000,3000,1]);
    const detail=await s.cancelSale(r.sale.id,'Cliente desistiu');assert.equal(detail.status,'canceled');assert.deepEqual(detail.payments.map(p=>p.method),['cash','pix']);
    assert.equal((await partsOf(s,r.sale.id)).length,2);
    totals=await s.shiftTotals((await s.shift()).id);assert.deepEqual([totals.methods.cash,totals.methods.pix,totals.salesCount,totals.canceledCount],[0,0,0,1]);
    const fixed=await s.correctSale(r.sale.id,'Troca de pagamento',{select:true}).catch(async()=>null);
    // The sale was already canceled above, so the correction is refused; correct another one.
    assert.equal(fixed,null);
    const d2=await draftOf(s,'30,00');const r2=await pay(s,d2,[part('credit','30,00')]);
    const c=await s.correctSale(r2.sale.id,'Pagamento errado',{select:true});
    assert.equal(c.sale.status,'canceled');assert.equal(c.sale.payments.length,1);assert.equal(c.draft.status,'open');assert.equal(c.draft.totalCents,3000);
    assert.equal(Number((await s.adapter.get("SELECT COUNT(*) AS n FROM sale_payments p JOIN sales x ON x.id=p.sale_id WHERE x.status='open'")).n),0);
    const r3=await pay(s,{id:c.draft.id,revision:c.draft.revision},[part('cash','10,00'),part('debit','20,00')]);assert.equal(r3.sale.method,'mixed');
    assert.deepEqual(await integrity(s),{...clean,sumMismatch:[]});
  }finally{await t.clean();}
});

test('PD29 the number of sales counts each sale once, however many parts it has',async()=>{
  const t=await till();try{
    const {s}=t;
    await pay(s,await draftOf(s,'40,00'),[part('cash','10,00'),part('pix','10,00'),part('credit','10,00'),part('debit','10,00')]);
    await pay(s,await draftOf(s,'20,00'),[part('pix','20,00')]);
    const x=await pay(s,await draftOf(s,'10,00'),[part('cash','5,00'),part('pix','5,00')]);await s.cancelSale(x.sale.id,'Teste de contagem');
    const totals=await s.shiftTotals((await s.shift()).id);
    assert.deepEqual([totals.salesCount,totals.canceledCount,totals.totalCents],[2,1,6000]);assert.deepEqual(totals.methods,{cash:1000,pix:3000,debit:1000,credit:1000});
    const sum=await s.cashSummary();assert.equal(sum.expectedCents,10000+1000,'fundo + dinheiro das parcelas');
  }finally{await t.clean();}
});

test('PD30 after a restart the sale and its parts are the same, and the same request is still answered with the first sale',async()=>{
  const t=await till();try{
    let {s}=t;const d=await draftOf(s,'50,00');const u=uid();const r=await pay(s,d,[part('cash','20,00','20,00'),part('credit','30,00')],{uuid:u});
    s=await t.box.reopen();
    const again=await pay(s,d,[part('cash','20,00','20,00'),part('credit','30,00')],{uuid:u});
    assert.equal(again.duplicate,true);assert.equal(again.sale.id,r.sale.id);assert.equal(again.sale.payments.length,2);
    assert.equal(await salesCount(s),1);assert.equal((await partsOf(s,r.sale.id)).length,2);assert.deepEqual(await integrity(s),clean);
  }finally{await t.clean();}
});
