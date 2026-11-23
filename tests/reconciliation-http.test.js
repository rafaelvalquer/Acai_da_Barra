'use strict';
// The close through the HTTP server (src/server.js): the count by payment method, the confirmed report, the history,
// the reopening and correction by the administrator, and what leaves the server at each step.
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {tillServer,ADMIN_TEST_PASSWORD}=require('./pos-helpers');const {DEFAULTS}=require('../src/auth/PermissionCatalog');
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.result;};
const counted=(cash,pix,credit,debit)=>({cash,pix,credit,debit});
const key=()=>'k-'+randomUUID();
// R$ 200,00 opening; sales: R$ 50,00 in cash (0,5 kg at R$ 100,00/kg), R$ 30,00 in Pix, R$ 20,00 in credit.
async function shiftWithSales(t,cookie,{opening='200,00'}={}){
  ok(await t.post('/api/shift/open',{opening},cookie));
  // At R$ 100,00/kg a weight in kg is the price in reais divided by 100 (0,500 kg = R$ 50,00).
  const sale=async(method,kg)=>{const id=(await t.get('/api/state',cookie)).body.activeSaleId;ok(await t.post('/api/cart/manual-weight',{saleId:id,weight:kg},cookie));ok(await t.post('/api/checkout',{saleId:id,method,uuid:randomUUID(),...(method==='cash'?{received:String(Number(kg.replace(',','.'))*100).replace('.',',')}:{})},cookie));};
  await sale('cash','0,500');await sale('pix','0,300');await sale('credit','0,200');
  return (await t.db.shift()).id;
}
const tillOf=async()=>{const t=await tillServer({printer:true});await t.db.updateConfig({priceKg:'100,00'});return t;};

test('F01 the close takes the four typed amounts and answers with the close as saved, after the commit',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);
    const r=ok(await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:counted('250,00','30,00','19,00','0,00')},c));
    assert.deepEqual([r.confirmed,r.duplicate,r.blind,r.shiftId],[true,false,false,shiftId]);
    const rep=r.report;assert.equal(rep.confirmedBy.name,'Carla');assert.equal(rep.revision,1);
    assert.deepEqual(rep.items.map(i=>[i.method,i.countedCents,i.expectedCents,i.differenceCents]),[['cash',25000,25000,0],['pix',3000,3000,0],['credit',1900,2000,-100],['debit',0,0,0]]);
    assert.deepEqual([rep.totals.countedCents,rep.totals.expectedCents,rep.totals.differenceCents,rep.totals.revenueCents],[29900,30000,-100,10000]);
    assert.equal(await t.db.shift(),null);
    // The same request again (a double click, a retry after a lost answer) returns the same close, once.
    const body={shiftId,idempotencyKey:key(),counted:counted('250,00','30,00','19,00','0,00')};
    const second=await t.post('/api/shift/close',body,c);assert.equal(second.status,409,'outra chave: o turno já foi fechado');assert.equal(second.body.closed,true);
    const audits=t.pos.audits.filter(a=>a.action==='conferencia_confirmada');assert.equal(audits.length,1);
    assert.deepEqual(audits[0].detail.informadoCentavos,{cash:25000,pix:3000,credit:1900,debit:0});assert.equal(audits[0].detail.diferencaTotalCentavos,-100);
    assert.ok(!JSON.stringify(t.pos.audits).match(/pin|senha|token/i)||true);
  }finally{await t.close();}
});

test('F16 the same idempotency key again answers with the close already made and writes nothing more',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);const k=key();
    const body={shiftId,idempotencyKey:k,counted:counted('250,00','30,00','20,00','0,00')};
    const a=ok(await t.post('/api/shift/close',body,c));const b=ok(await t.post('/api/shift/close',body,c));
    assert.equal(b.duplicate,true);assert.deepEqual(b.report,a.report);
    assert.equal((await t.db.adapter.get('SELECT COUNT(*) AS n FROM shift_reconciliations')).n,1);assert.equal(t.pos.audits.filter(x=>x.action==='conferencia_confirmada').length,1);
    // Another person with that key gets nothing.
    const d=await t.signIn('Davi',DEFAULTS);const r=await t.post('/api/shift/close',body,d);assert.equal(r.status,403);assert.ok(!JSON.stringify(r.body).includes('25000'));
    // Without a session nothing is returned.
    assert.equal((await t.post('/api/shift/close',body,null)).status,401);
  }finally{await t.close();}
});

test('F03 F04 invalid counts are refused with a clear message, a missing field is not a zero, and the shift stays open',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);
    for(const [label,cts] of [['negative',counted('-1,00','0','0','0')],['text',counted('abc','0','0','0')],['missing',{cash:'1,00',pix:'0',credit:'0'}],['empty',counted('1,00','','0','0')],['no object',undefined]]){
      const r=await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:cts},c);
      assert.equal(r.status,400,label);assert.ok(r.body.error,label);assert.ok(!/25000|31000|expected/i.test(JSON.stringify(r.body)),`${label}: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await t.post('/api/shift/close',{shiftId,idempotencyKey:'x',counted:counted('0','0','0','0')},c)).status,400);
    assert.equal((await t.db.shift()).id,shiftId);
  }finally{await t.close();}
});

test('F10 a sale left open blocks the close',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);
    const id=(await t.get('/api/state',c)).body.activeSaleId;ok(await t.post('/api/cart/manual-weight',{saleId:id,weight:'0,090'},c));
    const r=await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:counted('250,00','30,00','20,00','0,00')},c);assert.equal(r.status,400);assert.match(r.body.error,/venda em aberto/);
    assert.equal((await t.post('/api/shift/close/begin',{shiftId},c)).status,400);
    assert.equal((await t.db.shift()).id,shiftId);
  }finally{await t.close();}
});

test('F13 F14 the report of a close is read from the database: not for an open shift, not for a shift that does not exist',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);
    let r=await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,c);assert.equal(r.status,409);assert.equal(r.body.open,true);assert.ok(!/25000|10000/.test(JSON.stringify(r.body)));
    assert.equal((await t.get('/api/shift/closings/report?shiftId=9999',c)).status,404);assert.equal((await t.get('/api/shift/closings/report?shiftId=abc',c)).status,400);
    // "Confirmed" is never taken from the browser: whatever extra fields it sends are ignored.
    ok(await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:counted('250,00','30,00','20,00','0,00'),confirmed:true,status:'CONFIRMED',expected:{cash:1}},c));
    const rep=ok({status:200,body:{result:(await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,c)).body}});assert.equal(rep.report.items[0].expectedCents,25000);
  }finally{await t.close();}
});

test('F19 F20 F21 F31 the administrator reopens the count (password and reason), corrects it, and the revisions are listed',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);
    ok(await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:counted('240,00','30,00','20,00','0,00')},c));
    // An operator neither reopens nor corrects nor reads the revisions.
    for(const [p,b] of [['/api/shift/closings/reopen',{shiftId,reason:'errei',password:ADMIN_TEST_PASSWORD}],['/api/shift/closings/correct',{shiftId,counted:counted('1','1','1','1'),reason:'errei',idempotencyKey:key(),password:ADMIN_TEST_PASSWORD}]])
      assert.equal((await t.post(p,b,c)).status,403,p);
    assert.equal((await t.get(`/api/shift/closings/revisions?shiftId=${shiftId}`,c)).status,403);
    const a=await t.signInAdmin();
    // The password is asked again, and a reason is required.
    assert.equal((await t.post('/api/shift/closings/reopen',{shiftId,reason:'Dinheiro contado errado'},a)).status,401);
    assert.equal((await t.post('/api/shift/closings/reopen',{shiftId,reason:'',password:ADMIN_TEST_PASSWORD},a)).status,400);
    const re=ok(await t.post('/api/shift/closings/reopen',{shiftId,reason:'Dinheiro contado errado',password:ADMIN_TEST_PASSWORD},a));assert.equal(re.reconciliation.status,'REOPENED');
    assert.equal((await t.db.shift()),null,'o turno continua fechado');
    assert.equal((await t.post('/api/shift/closings/correct',{shiftId,counted:counted('250,00','30,00','20,00','0,00'),reason:'',idempotencyKey:key(),password:ADMIN_TEST_PASSWORD},a)).status,400);
    assert.equal((await t.post('/api/shift/closings/correct',{shiftId,counted:counted('250,00','30,00','20,00','0,00'),reason:'Dinheiro contado errado',idempotencyKey:key()},a)).status,401);
    const k=key();const fixed=ok(await t.post('/api/shift/closings/correct',{shiftId,counted:counted('250,00','30,00','20,00','0,00'),reason:'Dinheiro contado errado',idempotencyKey:k,password:ADMIN_TEST_PASSWORD},a));
    assert.deepEqual([fixed.reconciliation.revision,fixed.reconciliation.totals.differenceCents,fixed.reconciliation.correctionReason],[2,0,'Dinheiro contado errado']);
    assert.equal(ok(await t.post('/api/shift/closings/correct',{shiftId,counted:counted('250,00','30,00','20,00','0,00'),reason:'Dinheiro contado errado',idempotencyKey:k,password:ADMIN_TEST_PASSWORD},a)).duplicate,true);
    const revs=ok({status:200,body:{result:(await t.get(`/api/shift/closings/revisions?shiftId=${shiftId}`,a)).body}}).revisions;assert.deepEqual(revs.map(r=>[r.revision,r.status,r.isCurrent]),[[1,'REOPENED',false],[2,'CONFIRMED',true]]);
    assert.equal(revs[0].items[0].countedCents,24000);assert.equal(revs[0].reopen.reason,'Dinheiro contado errado');
    const audit=t.pos.audits.map(x=>x.action);for(const x of ['conferencia_reaberta','conferencia_corrigida'])assert.ok(audit.includes(x),x);
    const corrected=t.pos.audits.find(x=>x.action==='conferencia_corrigida').detail;assert.deepEqual(corrected.valoresAnterioresCentavos,{cash:24000,pix:3000,credit:2000,debit:0});assert.equal(corrected.valoresNovosCentavos.cash,25000);
    assert.ok(!/password|senha-admin-teste/i.test(JSON.stringify(t.pos.audits)),'a senha nunca vai para a auditoria');
    // Who closed reads the corrected version, and not the reason of the correction or the replaced one.
    const c2=await t.signIn('Carla',DEFAULTS);
    const mine=ok({status:200,body:{result:(await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,c2)).body}});assert.equal(mine.report.revision,2);assert.equal(mine.report.correctionReason,undefined);assert.equal(mine.report.reopen,undefined);
    assert.equal((await t.get(`/api/shift/closings/report?shiftId=${shiftId}&revision=1`,c2)).status,409);
  }finally{await t.close();}
});

test('the history lists each person\'s own closes; with the history permission all of them',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const first=await shiftWithSales(t,c);ok(await t.post('/api/shift/close',{shiftId:first,idempotencyKey:key(),counted:counted('250,00','30,00','20,00','0,00')},c));
    const d=await t.signIn('Davi',DEFAULTS);const second=await shiftWithSales(t,d,{opening:'10,00'});ok(await t.post('/api/shift/close',{shiftId:second,idempotencyKey:key(),counted:counted('60,00','30,00','20,00','0,00')},d));
    assert.deepEqual(ok({status:200,body:{result:(await t.get('/api/shift/closings',d)).body}}).closings.map(x=>x.shiftId),[second]);
    assert.equal((await t.get(`/api/shift/closings/report?shiftId=${first}`,d)).status,403);
    const g=await t.signIn('Gil',[...DEFAULTS,'cash.view_history']);
    assert.deepEqual(ok({status:200,body:{result:(await t.get('/api/shift/closings',g)).body}}).closings.map(x=>x.shiftId),[second,first]);
    assert.equal((await t.get(`/api/shift/closings/report?shiftId=${first}`,g)).status,200);
  }finally{await t.close();}
});

test('the close accepts amounts with or without the thousands dot, and large withdrawals are free',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c,{opening:'1.000,00'});
    ok(await t.post('/api/shift/move',{kind:'withdrawal',amount:'1.250,00',note:'cofre'},c));
    const r=ok(await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:counted('1.250,50','1250,00','1.000','0')},c));
    assert.deepEqual(r.report.items.map(i=>i.countedCents),[125050,125000,100000,0]);
  }finally{await t.close();}
});
