'use strict';
// The full count of the close (src/services/ReconciliationService.js): F01–F10, F15–F17, F19–F21, F31, F32, F36 of the
// plan, on the store, on SQLite and on PostgreSQL. HTTP, permissions, printing and backup have their own files.
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {tempStore,count}=require('./helpers');
const COUNTED=(cash,pix,credit,debit)=>({cash,pix,credit,debit});
const key=()=>'k-'+randomUUID();
async function fixture({opening='100,00'}={}){
  const box=await tempStore('luminor-rec-');const s=box.s;const ana=(await s.saveEmployee({name:'Ana'})).id;const bia=(await s.saveEmployee({name:'Bia'})).id;
  const as=id=>s.as({kind:'operador',employeeId:id,name:id===ana?'Ana':'Bia'});const admin=s.as({kind:'admin',employeeId:null,name:'Administrador (admin)'});
  const f={box,s,ana,bia,as,admin,ana$:as(ana),clean:()=>box.clean(),
    async openShift(){await f.ana$.openShift(opening);return (await s.shift()).id;},
    async sell(method,value){const a=f.ana$;const id=await s.activeSaleId();await a.addManualValue(id,value);return (await a.checkoutDraftSale(id,method,randomUUID(),method==='cash'?value:undefined)).sale;}};
  return f;
}
const methodsOf=r=>Object.fromEntries(r.items.map(i=>[i.method,i]));

test('F01 F05 F06 the four payment methods are counted, each with its own difference and a total that is not the revenue',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();await f.sell('cash','50,00');await f.sell('pix','30,00');await f.sell('credit','20,00');await f.sell('debit','10,00');
    const r=(await f.ana$.closeShift(COUNTED('140,00','30,00','18,00','10,00'),{shiftId,idempotencyKey:key()})).reconciliation;
    assert.deepEqual(r.items.map(i=>i.method),['cash','pix','credit','debit']);const m=methodsOf(r);
    // Drawer: 100,00 opening + 50,00 in cash = 150,00 expected; 140,00 counted: 10,00 missing.
    assert.deepEqual([m.cash.countedCents,m.cash.expectedCents,m.cash.differenceCents,m.cash.status],[14000,15000,-1000,'FALTA']);
    assert.deepEqual([m.pix.countedCents,m.pix.expectedCents,m.pix.differenceCents,m.pix.status],[3000,3000,0,'CONFERIDO']);
    assert.deepEqual([m.credit.countedCents,m.credit.expectedCents,m.credit.differenceCents],[1800,2000,-200]);
    assert.deepEqual([m.debit.countedCents,m.debit.expectedCents,m.debit.differenceCents],[1000,1000,0]);
    // The total is the sum of the counts, not the revenue: the opening is in the drawer and not a sale.
    assert.deepEqual(r.totals,{countedCents:14000+3000+1800+1000,expectedCents:15000+3000+2000+1000,differenceCents:-1200,status:'FALTA',revenueCents:11000,salesCount:4,canceledCount:0});
    assert.equal(r.status,'CONFIRMED');assert.equal(r.revision,1);assert.equal(r.isCurrent,true);
  }finally{await f.clean();}
});

test('F02 zero is a valid count of any method',async()=>{
  const f=await fixture({opening:'0,00'});try{
    const shiftId=await f.openShift();
    const r=(await f.ana$.closeShift(COUNTED('0','0,00',0,'0'),{shiftId,idempotencyKey:key()})).reconciliation;
    assert.deepEqual(r.items.map(i=>[i.countedCents,i.expectedCents,i.differenceCents]),[[0,0,0],[0,0,0],[0,0,0],[0,0,0]]);assert.equal(r.totals.status,'CONFERIDO');
  }finally{await f.clean();}
});

test('F03 F04 a negative or invalid amount, or a missing one, is refused and the shift stays open',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();
    const bad=[['negative',COUNTED('-1,00','0','0','0'),/negativo/],['negative number',COUNTED(5,-3,0,0),/inválido/],['text',COUNTED('abc','0','0','0'),/inválido/],['missing pix',{cash:'1,00',credit:'0',debit:'0'},/pix/],
      ['empty debit',COUNTED('1,00','0','0','  '),/débito/],['null',COUNTED('1,00',null,'0','0'),/pix/],['three decimals',COUNTED('1,005','0','0','0'),/inválido/],['array',[1,2,3,4],/Informe/],['too big',COUNTED('9999999,00','0','0','0'),/inválido|limite/],
      ['NaN',COUNTED(NaN,'0','0','0'),/inválido/],['object value',COUNTED({},'0','0','0'),/inválido/]];
    for(const [label,counted,message] of bad)await assert.rejects(()=>f.ana$.closeShift(counted,{shiftId,idempotencyKey:key()}),message,label);
    await assert.rejects(()=>f.ana$.closeShift(COUNTED('0','0','0','0'),{shiftId,idempotencyKey:'curta'}),/Identificador/);
    await assert.rejects(()=>f.ana$.closeShift(COUNTED('0','0','0','0'),{shiftId}),/Identificador/);
    assert.equal((await f.s.shift()).id,shiftId,'o turno continua aberto');assert.equal(await count(f.s,'shift_reconciliations'),0);
  }finally{await f.clean();}
});

test('F07 F08 the drawer count includes the opening, the supplies and the withdrawals',async()=>{
  const f=await fixture({opening:'200,00'});try{
    const shiftId=await f.openShift();await f.sell('cash','40,00');await f.sell('pix','60,00');
    await f.ana$.moveCash('supply','25,00','troco');await f.ana$.moveCash('withdrawal','70,00','cofre');
    // 200 + 40 + 25 - 70 = 195,00 in the drawer; the Pix sale is not cash.
    const r=(await f.ana$.closeShift(COUNTED('195,00','60,00','0','0'),{shiftId,idempotencyKey:key()})).reconciliation;
    assert.deepEqual(r.cash,{openingCents:20000,cashSalesCents:4000,suppliesCents:2500,withdrawalsCents:7000,expectedCents:19500});
    assert.equal(methodsOf(r).cash.differenceCents,0);assert.equal(r.totals.differenceCents,0);
    // The shift row keeps the cash figures as before.
    const sh=await f.s.adapter.get('SELECT counted_cents,expected_cents,difference_cents,closed_by FROM shifts WHERE id=?',[shiftId]);
    assert.deepEqual([sh.counted_cents,sh.expected_cents,sh.difference_cents,sh.closed_by],[19500,19500,0,f.ana]);
  }finally{await f.clean();}
});

test('F09 canceled sales are not in the expected values',async()=>{
  const f=await fixture({opening:'0,00'});try{
    const shiftId=await f.openShift();const keep=await f.sell('pix','30,00');const gone=await f.sell('pix','45,00');await f.sell('credit','10,00');
    await f.admin.cancelSale(gone.id,'cliente desistiu');void keep;
    const r=(await f.ana$.closeShift(COUNTED('0','30,00','10,00','0'),{shiftId,idempotencyKey:key()})).reconciliation;
    assert.equal(methodsOf(r).pix.expectedCents,3000);assert.equal(r.totals.differenceCents,0);assert.equal(r.totals.salesCount,2);assert.equal(r.totals.canceledCount,1);assert.equal(r.totals.revenueCents,4000);
  }finally{await f.clean();}
});

test('F10 a sale still open with items blocks the close; an empty tab does not',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();await f.ana$.addManualValue(await f.s.activeSaleId(),'12,00');
    await assert.rejects(()=>f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:key()}),/Existe 1 venda em aberto/);
    await assert.rejects(()=>f.ana$.beginClose({shiftId}),/Existe 1 venda em aberto/);
    assert.equal((await f.s.shift()).id,shiftId);assert.equal(await count(f.s,'shift_reconciliations'),0);
    await f.ana$.discardDraftSale(await f.s.activeSaleId());
    assert.equal((await f.ana$.beginClose({shiftId})).ready,true);
    assert.equal((await f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:key()})).reconciliation.totals.status,'CONFERIDO');
  }finally{await f.clean();}
});

test('F15 F16 a shift closes once; the same key answers with the close already made, another key is refused',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();const k=key();
    const a=await f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:k});assert.equal(a.duplicate,false);
    const b=await f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:k});assert.equal(b.duplicate,true);assert.equal(b.reconciliation.id,a.reconciliation.id);
    // The same key with other amounts is a repetition, not a second close: the saved one is returned unchanged.
    const c=await f.ana$.closeShift(COUNTED('1,00','1,00','1,00','1,00'),{shiftId,idempotencyKey:k});assert.equal(c.duplicate,true);assert.equal(c.reconciliation.totals.countedCents,10000);
    await assert.rejects(()=>f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:key()}),e=>e.status===409&&e.expose?.closed===true&&/já foi fechado/.test(e.message));
    // Another person cannot take the answer of someone's close with the same key.
    await assert.rejects(()=>f.as(f.bia).closeShift(COUNTED('1,00','1,00','1,00','1,00'),{shiftId,idempotencyKey:k}),e=>e.status===403);
    // A new shift is not closed by an old screen.
    const second=await f.openShift();
    await assert.rejects(()=>f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:key()}),e=>e.status===409);
    await assert.rejects(()=>f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId:second,idempotencyKey:k}),/outro fechamento/);
    assert.equal((await f.s.shift()).id,second);assert.equal(await count(f.s,'shift_reconciliations'),1);assert.equal(await count(f.s,'shift_reconciliation_items'),4);
  }finally{await f.clean();}
});

test('two close requests at the same time make one close (double click, two screens)',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();const k=key();
    const same=await Promise.allSettled([f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:k}),f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:k})]);
    assert.deepEqual(same.map(x=>x.status),['fulfilled','fulfilled']);assert.deepEqual(same.map(x=>x.value.duplicate).sort(),[false,true]);
    assert.equal(await count(f.s,'shift_reconciliations'),1);
    const second=await f.openShift();
    const other=await Promise.allSettled([f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId:second,idempotencyKey:key()}),f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId:second,idempotencyKey:key()})]);
    assert.deepEqual(other.map(x=>x.status).sort(),['fulfilled','rejected']);assert.equal(await count(f.s,'shift_reconciliations'),2);
  }finally{await f.clean();}
});

test('F17 the close keeps who confirmed it and when; the administrator is recorded as the administrator',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();const before=Date.now();
    const r=(await f.as(f.ana).closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:key()})).reconciliation;
    assert.deepEqual([r.confirmedBy.name,r.confirmedBy.kind,r.confirmedBy.employeeId,r.closedByEmployeeId],['Ana','operador',f.ana,f.ana]);
    assert.ok(Date.parse(r.confirmedAt)>=before-1000&&Date.parse(r.confirmedAt)<=Date.now()+1000);assert.equal(r.closedAt,r.confirmedAt);
    const row=await f.s.adapter.get('SELECT confirmed_by_uuid FROM shift_reconciliations WHERE shift_id=?',[shiftId]);assert.equal(row.confirmed_by_uuid,(await f.s.adapter.get('SELECT uuid FROM employees WHERE id=?',[f.ana])).uuid);
    await f.ana$.openShift('0,00');const second=(await f.s.shift()).id;
    const adminClose=(await f.admin.closeShift(COUNTED('0','0','0','0'),{shiftId:second,idempotencyKey:key()})).reconciliation;
    assert.deepEqual([adminClose.confirmedBy.kind,adminClose.confirmedBy.employeeId],['admin',null]);
  }finally{await f.clean();}
});

test('F36 large amounts stay exact (whole cents) up to the limit and are refused beyond it',async()=>{
  const f=await fixture({opening:'0,00'});try{
    const shiftId=await f.openShift();
    const r=(await f.ana$.closeShift(COUNTED('999999,99','999999,99','999999,99','999999,99'),{shiftId,idempotencyKey:key()})).reconciliation;
    assert.equal(r.totals.countedCents,399999996);assert.equal(r.totals.differenceCents,399999996);assert.ok(r.items.every(i=>i.countedCents===99999999&&Number.isInteger(i.differenceCents)));
    await f.ana$.openShift('0,00');
    await assert.rejects(()=>f.ana$.closeShift(COUNTED('1000000,00','0','0','0'),{shiftId:(null),idempotencyKey:key()}),/inválido/);
  }finally{await f.clean();}
});

// A failure between the writes undoes all of them: the shift is never closed without its count, nor the count saved on an open shift.
for(const [label,pattern] of [['the header','INSERT INTO shift_reconciliations('],['an item','INSERT INTO shift_reconciliation_items'],['the shift','UPDATE shifts SET closed_at']]){
  test(`a failure while saving ${label} undoes the whole close`,async()=>{
    const f=await fixture();try{
      const shiftId=await f.openShift();await f.sell('pix','10,00');let armed=true;
      f.s.adapter.onQuery=sql=>{if(armed&&sql.includes(pattern)){armed=false;throw Error('disco cheio (simulado)');}};
      await assert.rejects(()=>f.ana$.closeShift(COUNTED('100,00','10,00','0','0'),{shiftId,idempotencyKey:key()}),/disco cheio/);
      f.s.adapter.onQuery=null;
      assert.equal((await f.s.shift())?.id,shiftId,'o turno continua aberto');assert.equal(await count(f.s,'shift_reconciliations'),0);assert.equal(await count(f.s,'shift_reconciliation_items'),0);
      const ok=await f.ana$.closeShift(COUNTED('100,00','10,00','0','0'),{shiftId,idempotencyKey:key()});assert.equal(ok.duplicate,false);assert.equal(await count(f.s,'shift_reconciliations'),1);
    }finally{await f.clean();}
  });
}

test('the database refuses invalid states: unknown method, negative count, two current revisions, a wrong difference',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();const r=(await f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:key()})).reconciliation;
    const db=f.s.adapter;const uuid=randomUUID;
    await assert.rejects(()=>db.run("INSERT INTO shift_reconciliation_items(uuid,reconciliation_id,method,counted_cents,expected_cents,difference_cents) VALUES(?,?,?,?,?,?)",[uuid(),r.id,'boleto',0,0,0]));
    await assert.rejects(()=>db.run("INSERT INTO shift_reconciliation_items(uuid,reconciliation_id,method,counted_cents,expected_cents,difference_cents) VALUES(?,?,?,?,?,?)",[uuid(),r.id,'cash',0,0,0]),'a method only once per count');
    await assert.rejects(()=>db.run("UPDATE shift_reconciliation_items SET counted_cents=-1,difference_cents=-101 WHERE reconciliation_id=? AND method='pix'",[r.id]));
    await assert.rejects(()=>db.run("UPDATE shift_reconciliation_items SET difference_cents=5 WHERE reconciliation_id=? AND method='pix'",[r.id]));
    await assert.rejects(()=>db.run("UPDATE shift_reconciliations SET status='QUALQUER' WHERE id=?",[r.id]));
    await assert.rejects(()=>db.run("INSERT INTO shift_reconciliations(uuid,shift_id,revision,status,is_current,idempotency_key,created_at,confirmed_at,confirmed_by_name,total_counted_cents,total_expected_cents,total_difference_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      [uuid(),shiftId,2,'CONFIRMED',1,'k-outra-chave',new Date().toISOString(),new Date().toISOString(),'x',0,0,0]),'a revision above 1 needs the one it corrects; one current per shift');
    await assert.rejects(()=>db.run("INSERT INTO shift_reconciliations(uuid,shift_id,revision,status,is_current,idempotency_key,created_at,total_counted_cents,total_expected_cents,total_difference_cents) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [uuid(),shiftId,1,'OPEN',0,'k-x',new Date().toISOString(),0,0,0]),'one revision number per shift');
    await assert.rejects(()=>db.run("INSERT INTO shift_reconciliations(uuid,shift_id,revision,status,is_current,idempotency_key,created_at,total_counted_cents,total_expected_cents,total_difference_cents) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [uuid(),shiftId,3,'CONFIRMED',0,'k-y',new Date().toISOString(),0,0,0]),'confirmed without a confirmation time');
    await assert.rejects(()=>db.run("INSERT INTO shift_reconciliations(uuid,shift_id,revision,status,is_current,idempotency_key,created_at,total_counted_cents,total_expected_cents,total_difference_cents) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [uuid(),99999,1,'OPEN',0,'k-z',new Date().toISOString(),0,0,0]),'a close needs its shift');
  }finally{await f.clean();}
});

test('F19 F20 F21 F31 the administrator reopens the count and corrects it: a new revision, the first kept, the sales untouched',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();const sale=await f.sell('pix','30,00');await f.sell('cash','20,00');
    const first=(await f.ana$.closeShift(COUNTED('110,00','25,00','0','0'),{shiftId,idempotencyKey:key()})).reconciliation;
    const salesBefore=await f.s.adapter.all('SELECT id,method,total_cents,status,shift_id FROM sales ORDER BY id');
    // Operators neither reopen nor correct (also in the service, whatever the screen shows).
    await assert.rejects(()=>f.ana$.requestReopen({shiftId,reason:'errei o valor'}),/administrador/);
    await assert.rejects(()=>f.ana$.confirmCorrection({shiftId,idempotencyKey:key(),counted:COUNTED('1','1','1','1'),reason:'xxxxxx'}),/administrador/);
    // A reason is required, and a correction needs the reopening first.
    await assert.rejects(()=>f.admin.requestReopen({shiftId,reason:''}),/justificativa/);await assert.rejects(()=>f.admin.requestReopen({shiftId,reason:'abc'}),/justificativa/);
    await assert.rejects(()=>f.admin.confirmCorrection({shiftId,idempotencyKey:key(),counted:COUNTED('120,00','30,00','0','0'),reason:'contagem refeita'}),/Reabra a conferência/);
    const reopened=(await f.admin.requestReopen({shiftId,reason:'Pix digitado errado'})).reconciliation;
    assert.equal(reopened.status,'REOPENED');assert.equal(reopened.isCurrent,true);assert.deepEqual([reopened.reopen.by,reopened.reopen.reason],['Administrador (admin)','Pix digitado errado']);
    await assert.rejects(()=>f.admin.requestReopen({shiftId,reason:'de novo por favor'}),/já está reaberta/);
    assert.equal((await f.s.shift()),null,'reabrir a conferência não reabre o turno');
    await assert.rejects(()=>f.admin.confirmCorrection({shiftId,idempotencyKey:key(),counted:COUNTED('120,00','30,00','0','0'),reason:''}),/justificativa/);
    const k=key();const fixed=await f.admin.confirmCorrection({shiftId,idempotencyKey:k,counted:COUNTED('120,00','30,00','0','0'),reason:'Pix digitado errado'});
    const second=fixed.reconciliation;assert.deepEqual([second.revision,second.status,second.isCurrent,second.correctedFromId,second.confirmedBy.kind],[2,'CONFIRMED',true,first.id,'admin']);
    assert.deepEqual(fixed.previousCounted,{cash:11000,pix:2500,credit:0,debit:0});
    // Same system base as the original close; the difference is recomputed from what is informed now.
    const m=methodsOf(second);assert.deepEqual([m.cash.expectedCents,m.cash.countedCents,m.cash.differenceCents,m.pix.expectedCents,m.pix.countedCents,m.pix.differenceCents],[12000,12000,0,3000,3000,0]);
    assert.equal(second.totals.differenceCents,0);assert.equal(second.cash.openingCents,first.cash.openingCents);
    // The same key again is the same correction, not a third revision.
    assert.equal((await f.admin.confirmCorrection({shiftId,idempotencyKey:k,counted:COUNTED('120,00','30,00','0','0'),reason:'Pix digitado errado'})).duplicate,true);
    const revs=(await f.admin.getRevisions({shiftId})).revisions;assert.equal(revs.length,2);
    assert.deepEqual(revs.map(r=>[r.revision,r.isCurrent,r.superseded,r.status]),[[1,false,true,'REOPENED'],[2,true,false,'CONFIRMED']]);
    // The first revision is exactly as it was confirmed (values, who, when), now marked as replaced.
    assert.deepEqual(revs[0].items,first.items);assert.equal(revs[0].confirmedAt,first.confirmedAt);assert.deepEqual(revs[0].confirmedBy,first.confirmedBy);assert.equal(revs[0].supersededByRevision,2);
    assert.deepEqual(await f.s.adapter.all('SELECT id,method,total_cents,status,shift_id FROM sales ORDER BY id'),salesBefore,'as vendas não mudam');void sale;
    assert.equal((await f.admin.getConfirmedReport({shiftId})).revision,2);assert.equal((await f.admin.getConfirmedReport({shiftId,revision:1})).superseded,true);
    // Reopening the corrected one and correcting again keeps all three.
    await f.admin.requestReopen({shiftId,reason:'segunda conferência'});
    await f.admin.confirmCorrection({shiftId,idempotencyKey:key(),counted:COUNTED('119,00','30,00','0','0'),reason:'segunda conferência'});
    assert.deepEqual((await f.admin.getRevisions({shiftId})).revisions.map(r=>r.revision),[1,2,3]);
    const one=await f.s.adapter.get('SELECT COUNT(*) AS n FROM shift_reconciliations WHERE shift_id=? AND is_current=1',[shiftId]);assert.equal(Number(one.n),1);
  }finally{await f.clean();}
});

test('F13 F14 the confirmed report exists only for a shift that was closed; the history lists the current close of each shift',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();
    await assert.rejects(()=>f.ana$.getConfirmedReport({shiftId}),e=>e.status===409&&e.expose?.open===true);
    await assert.rejects(()=>f.ana$.getConfirmedReport({shiftId:99999}),e=>e.status===404);
    await f.ana$.closeShift(COUNTED('100,00','0','0','0'),{shiftId,idempotencyKey:key()});
    assert.equal((await f.ana$.getConfirmedReport({shiftId})).totals.status,'CONFERIDO');
    const second=await f.openShift();await f.as(f.bia).closeShift(COUNTED('90,00','0','0','0'),{shiftId:second,idempotencyKey:key()});
    const all=await f.s.listClosings();assert.deepEqual(all.map(x=>[x.shiftId,x.confirmedBy,x.totals.status]),[[second,'Bia','FALTA'],[shiftId,'Ana','CONFERIDO']]);
    assert.deepEqual((await f.s.listClosings({employeeId:f.ana})).map(x=>x.shiftId),[shiftId]);
  }finally{await f.clean();}
});

test('F32 after a restart the close is exactly as it was; a shift closed before the full count is listed as such',async()=>{
  const f=await fixture();try{
    const shiftId=await f.openShift();await f.sell('credit','33,33');
    const r=(await f.ana$.closeShift(COUNTED('100,00','0','33,00','0'),{shiftId,idempotencyKey:key()})).reconciliation;
    const s=await f.box.reopen();f.s=s;
    assert.deepEqual(await s.getConfirmedReport({shiftId}),r);
    // A close from before (no count rows): the old one-value close is still listed, flagged.
    const a=s.as({kind:'operador',employeeId:f.ana,name:'Ana'});await a.openShift('0,00');const old=(await s.shift()).id;
    await s.adapter.run('UPDATE shifts SET closed_at=?,counted_cents=0,expected_cents=0,difference_cents=0,closed_by=? WHERE id=?',[new Date().toISOString(),f.ana,old]);
    const list=await s.listClosings();assert.equal(list.find(x=>x.shiftId===old).legacy,true);assert.equal(list.find(x=>x.shiftId===shiftId).legacy,false);
    await assert.rejects(()=>s.getConfirmedReport({shiftId:old}),/antes da conferência/);
  }finally{await f.clean();}
});

test('the one-value close of before still works: the other methods are taken as matched and the answer keeps its shape',async()=>{
  const f=await fixture();try{
    await f.openShift();await f.sell('cash','50,00');await f.sell('pix','30,00');
    const r=await f.ana$.closeShift('140,00');
    assert.deepEqual([r.expectedCents,r.countedCents,r.differenceCents,r.status,r.totalCents],[15000,14000,-1000,'FALTA',8000]);assert.deepEqual(r.methods,{cash:5000,pix:3000,debit:0,credit:0});
    assert.equal(r.reconciliation.totals.differenceCents,-1000);assert.equal(methodsOf(r.reconciliation).pix.differenceCents,0);
  }finally{await f.clean();}
});
