'use strict';
// Who may do what around the close, and what leaves the server before the count is confirmed (F11, F12, F14, F18, F26, F33
// and the interaction with the old "cash.view_expected"). Authorization is on the server: none of this depends on the screen.
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {tillServer,ADMIN_TEST_PASSWORD}=require('./pos-helpers');const {DEFAULTS,CATALOG,IMPLIED_BY_CLOSE}=require('../src/auth/PermissionCatalog');const {DENIED}=require('../src/auth/AuthorizationService');
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.status===200&&r.body.result!==undefined?r.body.result:r.body;};
const counted=(cash,pix,credit,debit)=>({cash,pix,credit,debit});const key=()=>'k-'+randomUUID();
async function tillOf(){const t=await tillServer({printer:true});await t.db.updateConfig({priceKg:'100,00'});return t;}
async function shiftWithSales(t,cookie){
  ok(await t.post('/api/shift/open',{opening:'200,00'},cookie));
  const sale=async(method,kg,received)=>{const id=(await t.get('/api/state',cookie)).body.activeSaleId;ok(await t.post('/api/cart/manual-weight',{saleId:id,weight:kg},cookie));ok(await t.post('/api/checkout',{saleId:id,method,uuid:randomUUID(),...(received?{received}:{})},cookie));};
  await sale('cash','0,500','50,00');await sale('pix','0,300');await sale('credit','0,200');return (await t.db.shift()).id;
}
// Amounts that would reveal the shift's totals: the expected drawer (250,00), the revenue (100,00) and the sum of the four expected values (310,00).
const SECRET=[25000,10000,31000];
function noTotals(value,label){
  const text=JSON.stringify(value);
  for(const k of ['expectedCents','methods','totalCents','revenueCents','cashSalesCents','openingCents','opening_cents','expected_cents','counted_cents','difference_cents','differenceCents','cashSales','suppliesCents'])assert.ok(!text.includes(`"${k}"`),`${label}: ${k} em ${text}`);
  for(const n of SECRET)assert.ok(!new RegExp(`(^|\\D)${n}(\\D|$)`).test(text),`${label}: ${n} em ${text}`);
}

test('F12 before the count is confirmed an employee receives no total, no expected value, no difference and no preview, on any route',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);
    const st=await t.get('/api/state',c);assert.equal(st.body.cash.blind,true);noTotals(st.body.cash,'state.cash');
    assert.equal(st.body.cash.salesCount,3,'só a contagem de vendas');
    const sales=(await t.get('/api/sales',c)).body;assert.equal(sales.shiftOnly,true);assert.equal(sales.sales.length,3);assert.ok(sales.sales.every(s=>s.method===null&&s.received_cents===null&&s.change_cents===null),'sem a forma de pagamento: somar por forma daria os totais');
    const detail=(await t.get(`/api/sales/detail?id=${sales.sales[0].id}`,c)).body;assert.equal(detail.method,null);
    for(const p of ['/api/report?period=day','/api/shift/closings/revisions?shiftId='+shiftId])assert.equal((await t.get(p,c)).status,403,p);
    // The report, the history and the print status of an open shift: nothing.
    for(const p of [`/api/shift/closings/report?shiftId=${shiftId}`,`/api/shift/closings/report?shiftId=${shiftId}&revision=1`,`/api/shift/closings/print-status?shiftId=${shiftId}`]){const r=await t.get(p,c);assert.equal(r.status,409,p);noTotals(r.body,p);}
    assert.deepEqual((await t.get('/api/shift/closings',c)).body.closings,[]);
    assert.equal((await t.post('/api/shift/closings/print',{shiftId},c)).status,409);assert.equal(t.printing.spooler.sent.length,0);
    const begin=ok(await t.post('/api/shift/close/begin',{shiftId},c));noTotals(begin,'begin');
    // Errors never tell what was expected, and a withdrawal is not a balance oracle.
    for(const body of [{shiftId,idempotencyKey:key(),counted:counted('-1,00','0','0','0')},{shiftId,idempotencyKey:key(),counted:counted('1','x','0','0')},{shiftId:shiftId+1,idempotencyKey:key(),counted:counted('0','0','0','0')},{shiftId,idempotencyKey:'x',counted:counted('0','0','0','0')}]){
      const r=await t.post('/api/shift/close',body,c);assert.ok(r.status>=400);noTotals(r.body,'erro de fechamento');
    }
    const w=await t.post('/api/shift/move',{kind:'withdrawal',amount:'900,00',note:'x'},c);assert.ok([400,403].includes(w.status));noTotals(w.body,'sangria');assert.ok(!/em caixa|saldo|esperad/i.test(w.body.error));
    // Counting wrong and counting right look the same until the close is confirmed: no "almost" feedback.
    assert.equal((await t.db.shift()).id,shiftId);
  }finally{await t.close();}
});

test('F13 only after the commit does the person who closed receive the figures of that close, and only that close',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);
    const r=ok(await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:counted('240,00','30,00','20,00','0,00')},c));
    assert.deepEqual(r.report.items.map(i=>[i.method,i.countedCents,i.expectedCents,i.differenceCents]),[['cash',24000,25000,-1000],['pix',3000,3000,0],['credit',2000,2000,0],['debit',0,0,0]]);
    assert.equal(r.report.totals.revenueCents,10000,'o faturamento é separado do total esperado');assert.equal(r.report.totals.expectedCents,30000);
    const again=ok(await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,c));assert.deepEqual(again.report,r.report);
    // The next shift is open again: its totals stay hidden, the old close stays readable.
    ok(await t.post('/api/shift/open',{opening:'10,00'},c));const st=(await t.get('/api/state',c)).body;assert.equal(st.cash.blind,true);noTotals(st.cash,'novo turno');
    assert.equal((await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,c)).status,200);
  }finally{await t.close();}
});

test('F11 without "cash.close" (or without confirming the count) nothing is closed, by any form of the request',async()=>{
  const t=await tillOf();try{
    const a=await t.signIn('Ana',DEFAULTS);const shiftId=await shiftWithSales(t,a);
    const noClose=await t.signIn('Bia',DEFAULTS.filter(p=>p!=='cash.close'));
    for(const body of [{shiftId,idempotencyKey:key(),counted:counted('250,00','30,00','20,00','0,00')},{counted:'250,00',shiftId}]){const r=await t.post('/api/shift/close',body,noClose);assert.equal(r.status,403);assert.equal(r.body.error,DENIED);}
    assert.equal((await t.post('/api/shift/close/begin',{shiftId},noClose)).status,403);
    // "cash.close" without the permission to confirm the count: refused too (the one-value form included).
    const noConfirm=await t.signIn('Caio',DEFAULTS.filter(p=>p!=='cash.reconciliation.confirm'));
    for(const body of [{shiftId,idempotencyKey:key(),counted:counted('250,00','30,00','20,00','0,00')},{counted:'250,00',shiftId}]){const r=await t.post('/api/shift/close',body,noConfirm);assert.equal(r.status,403,JSON.stringify(body));}
    void noConfirm;assert.equal((await t.db.shift()).id,shiftId,'o turno continua aberto');
  }finally{await t.close();}
});

test('F18 F26 F33 an employee reads only her own close; another one needs the history permission; a change of user changes what is readable',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftWithSales(t,c);
    ok(await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:counted('250,00','30,00','20,00','0,00')},c));
    const d=await t.signIn('Davi',DEFAULTS);
    // Carla's session ended when Davi signed in (one person at the till).
    assert.equal((await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,c)).status,401);
    let r=await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,d);assert.equal(r.status,403);assert.equal(r.body.error,DENIED);noTotals(r.body,'403');
    assert.equal((await t.post('/api/shift/closings/print',{shiftId},d)).status,403);assert.equal((await t.post('/api/shift/closings/print',{shiftId,reprint:true},d)).status,403);
    assert.ok(t.pos.audits.some(a=>a.action==='acesso_negado'&&a.username==='Davi'),'o acesso negado fica registrado');
    // Without the report permission nothing of a close is readable, even her own.
    const e=await t.signIn('Eva',DEFAULTS.filter(p=>!p.startsWith('cash.reconciliation.view')));
    assert.equal((await t.get('/api/shift/closings',e)).status,403);
    // The history permission alone is not enough (the report permission is separate), both together are.
    const g=await t.signIn('Gil',[...DEFAULTS.filter(p=>p!=='cash.reconciliation.view_confirmed'),'cash.view_history']);assert.equal((await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,g)).status,403);
    const hugo=await t.pos.signIn('Hugo',[...DEFAULTS,'cash.view_history']);const h=hugo.cookie;assert.equal((await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,h)).status,200);
    // The administrator takes the permission away: it counts at the next request, in the session already open.
    await t.pos.auth.operators.setPermissions(hugo.id,Object.fromEntries(CATALOG.map(p=>[p.id,DEFAULTS.includes(p.id)])),{by:'teste'});assert.ok([401,403].includes((await t.get(`/api/shift/closings/report?shiftId=${shiftId}`,h)).status),"sem a permissão o relatório não abre");
    // Operators never reopen, correct or read the revisions, even when everything else is granted.
    const all=await t.signIn('Iris',CATALOG.map(p=>p.id));const adminOnly=[['/api/shift/closings/reopen',{shiftId,reason:'qualquer motivo',password:ADMIN_TEST_PASSWORD}],['/api/shift/closings/correct',{shiftId,idempotencyKey:key(),counted:counted('1','1','1','1'),reason:'qualquer motivo',password:ADMIN_TEST_PASSWORD}]];
    for(const [p,b] of adminOnly){const x=await t.post(p,b,all);assert.equal(x.status,403,p);assert.match(x.body.error,/administrador/);}
    assert.equal((await t.db.adapter.get('SELECT COUNT(*) AS n FROM shift_reconciliations')).n,1);
  }finally{await t.close();}
});

test('the default operator may confirm, see and print her own close; reopening, correcting and the revisions are denied',async()=>{
  const ops=CATALOG.filter(p=>p.default).map(p=>p.id);
  for(const p of ['cash.reconciliation.confirm','cash.reconciliation.view_confirmed','cash.reconciliation.print','cash.reconciliation.reprint'])assert.ok(ops.includes(p),p);
  for(const p of ['cash.reconciliation.reopen','cash.reconciliation.correct','cash.reconciliation.view_revisions','cash.view_expected'])assert.ok(!ops.includes(p),p);
  assert.deepEqual(IMPLIED_BY_CLOSE.sort(),['cash.reconciliation.confirm','cash.reconciliation.print','cash.reconciliation.reprint','cash.reconciliation.view_confirmed']);
});

test('an employee who could close before keeps confirming and seeing her own close, unless the administrator decided otherwise',async()=>{
  const t=await tillOf();try{
    // As the permissions were before this version: "cash.close" and no row at all for the new permissions.
    const old=DEFAULTS.filter(p=>!p.startsWith('cash.reconciliation'));
    let c=await t.signIn('Lia',old);await t.db.adapter.run("DELETE FROM employee_permissions WHERE permission LIKE 'cash.reconciliation.%'");
    c=await t.signIn('Lia',old);await t.db.adapter.run("DELETE FROM employee_permissions WHERE permission LIKE 'cash.reconciliation.%'");
    const s=await t.get('/api/auth/session',c);assert.ok(s.body.permissions.includes('cash.reconciliation.confirm'));assert.ok(s.body.permissions.includes('cash.reconciliation.view_confirmed'));assert.ok(!s.body.permissions.includes('cash.reconciliation.reopen'));
    const shiftId=await shiftWithSales(t,c);
    const r=ok(await t.post('/api/shift/close',{shiftId,idempotencyKey:key(),counted:counted('250,00','30,00','20,00','0,00')},c));assert.equal(r.blind,false);
    // A permission refused on purpose (a stored "refused") stays refused.
    await t.pos.provision('Lia',DEFAULTS.filter(p=>p!=='cash.reconciliation.print'));
    const c2=(await t.pos.signIn('Lia',DEFAULTS.filter(p=>p!=='cash.reconciliation.print'))).cookie;
    const refused=await t.get('/api/auth/session',c2);assert.ok(!refused.body.permissions.includes('cash.reconciliation.print'));
  }finally{await t.close();}
});

test('strict blind: "cash.view_expected" given before does not open the totals of the shift in progress; the administrator may turn the strictness off',async()=>{
  const t=await tillOf();try{
    const c=await t.signIn('Bruno',[...DEFAULTS,'cash.view_expected','cash.view_history','reports.view']);const shiftId=await shiftWithSales(t,c);
    const st=(await t.get('/api/state',c)).body;assert.equal(st.cash.blind,true);noTotals(st.cash,'state');
    const rep=(await t.get('/api/report?period=day',c)).body;assert.equal(rep.blind,true);assert.equal(rep.methods,undefined);
    const sales=(await t.get('/api/sales',c)).body;assert.ok(sales.sales.every(s=>s.method!==undefined));
    const w=await t.post('/api/shift/move',{kind:'withdrawal',amount:'1,00',note:'x'},c);void w;
    // The administrator, always, and the employee after the close (her own figures).
    const a=await t.signInAdmin();assert.equal((await t.get('/api/state',a)).body.cash.expectedCents,25000);
    // With the strictness off the old permission works again.
    await t.db.setStrictBlind(false);const b=await t.signIn('Bruno',[...DEFAULTS,'cash.view_expected']);assert.equal((await t.get('/api/state',b)).body.cash.expectedCents,25000);
    await t.db.setStrictBlind(true);assert.equal((await t.get('/api/state',b)).body.cash.blind,true);
    void shiftId;
  }finally{await t.close();}
});
