'use strict';
// Blind cash close (src/auth/CashVisibilityPolicy.js, CashService.closeShift/moveCash): C01–C10 of the plan. Without
// "cash.view_expected" no expected balance, opening, cash total or difference leaves the server, and the close answers
// only Falta, Conferido or Sobra. Runs on SQLite and on PostgreSQL (C07 uses the whole installation).
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {tillServer}=require('./pos-helpers');const {DEFAULTS}=require('../src/auth/PermissionCatalog');const {DENIED}=require('../src/auth/AuthorizationService');
const app=require('./app-helpers');
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.result;};
const MONEY_KEYS=['expectedCents','cashSalesCents','suppliesCents','withdrawalsCents','methods','totalCents','openingCents','countedCents','differenceCents','opening_cents','expected_cents','difference_cents','counted_cents'];
// No amount of the balance anywhere in this answer (keys or numbers).
function noBalance(value,amounts=[]){
  const text=JSON.stringify(value);
  for(const k of MONEY_KEYS)assert.ok(!text.includes(`"${k}"`),`${k} em ${text}`);
  for(const n of amounts)assert.ok(!new RegExp(`(^|\\D)${n}(\\D|$)`).test(text),`${n} em ${text}`);
}
// R$ 200,00 opening and one sale of R$ 50,00 in cash: expected R$ 250,00.
async function shiftOf250(t,cookie){
  ok(await t.post('/api/shift/open',{opening:'200,00'},cookie));
  const st=(await t.get('/api/state',cookie)).body;
  ok(await t.post('/api/cart/manual-weight',{saleId:st.activeSaleId,weight:'0,500'},cookie));
  ok(await t.post('/api/checkout',{saleId:st.activeSaleId,method:'cash',uuid:randomUUID(),received:'50,00'},cookie));
  return (await t.db.shift()).id;
}
async function blindTill(){const t=await tillServer();await t.db.updateConfig({priceKg:'100,00'});return t;}

test('C01 the cash panel of an employee without "cash.view_expected" carries no balance',async()=>{
  const t=await blindTill();try{
    const c=await t.signIn('Carla',DEFAULTS);await shiftOf250(t,c);
    const st=(await t.get('/api/state',c)).body;
    assert.equal(st.cash.blind,true);assert.equal(st.cash.salesCount,1);assert.equal(st.cash.shift.opened_by_name,'Carla');
    assert.deepEqual(Object.keys(st.cash.shift).sort(),['active_draft_id','id','opened_at','opened_by','opened_by_name']);
    noBalance(st.cash,[25000,20000,5000]);
    // The state the store keeps for the next requests is not changed by the projection.
    assert.equal((await t.db.cashSummary()).expectedCents,25000);
  }finally{await t.close();}
});

for(const [code,counted,status] of [['C02','242,00','FALTA'],['C03','250,00','CONFERIDO'],['C04','260,00','SOBRA']]){
  test(`${code} counting R$ ${counted} with R$ 250,00 expected answers only ${status}`,async()=>{
    const t=await blindTill();try{
      const c=await t.signIn('Carla',DEFAULTS);const shiftId=await shiftOf250(t,c);
      const r=ok(await t.post('/api/shift/close',{counted,shiftId},c));
      assert.deepEqual(r,{shiftId,status,blind:true});noBalance(r,[25000,800,1000]);
      // Stored as always: the administrator sees the exact amounts.
      const closed=(await t.db.report({period:'day'})).shifts.find(s=>s.id===shiftId);
      assert.equal(closed.expected_cents,25000);assert.equal(closed.difference_cents,Number(counted.replace(',',''))-25000);
      assert.equal(t.pos.audits.find(a=>a.action==='caixa_fechado').detail.situacao,status);
    }finally{await t.close();}
  });
}

test('C05 the reports are refused to the employee; with "reports.view" they come without the balance',async()=>{
  const t=await blindTill();try{
    let c=await t.signIn('Carla',DEFAULTS);await shiftOf250(t,c);
    const r=await t.get('/api/report?period=day',c);assert.equal(r.status,403);assert.equal(r.body.error,DENIED);noBalance(r.body,[25000]);
    // Reports without the balance: no totals per payment method, no closings (they need "cash.view_history").
    c=await t.signIn('Carla',[...DEFAULTS,'reports.view']);
    const rep=(await t.get('/api/report?period=day',c)).body;assert.equal(rep.blind,true);assert.equal(rep.methods,undefined);assert.deepEqual(rep.shifts,[]);
    assert.equal(rep.totalCents,5000);
    // With the cash history, the closings show only whether the count matched.
    c=await t.signIn('Carla',[...DEFAULTS,'reports.view','cash.view_history']);ok(await t.post('/api/shift/close',{counted:'240,00'},c));
    const shifts=(await t.get('/api/report?period=day',c)).body.shifts;assert.equal(shifts.length,1);assert.equal(shifts[0].status,'FALTA');noBalance(shifts,[25000,24000,1000,20000]);
  }finally{await t.close();}
});

test('C06 an employee allowed to see the balance gets the amounts, and the exact close',async()=>{
  const t=await blindTill();try{
    const c=await t.signIn('Bruno',[...DEFAULTS,'cash.view_expected']);const shiftId=await shiftOf250(t,c);
    const st=(await t.get('/api/state',c)).body;assert.equal(st.cash.blind,false);assert.equal(st.cash.expectedCents,25000);assert.equal(st.cash.shift.opening_cents,20000);
    assert.equal(st.cash.cashSalesCents,5000);
    const r=ok(await t.post('/api/shift/close',{counted:'242,00',shiftId},c));
    assert.equal(r.expectedCents,25000);assert.equal(r.countedCents,24200);assert.equal(r.differenceCents,-800);assert.equal(r.status,'FALTA');assert.equal(r.blind,false);
  }finally{await t.close();}
});

test('C07 the administrator sees the exact difference of a blind close',async()=>{
  const t=await app.boot();try{
    await app.setupAdmin(t);await app.operator(t,'Ana',[...DEFAULTS,'sales.manual_value']);await app.signIn(t,'Ana');
    ok(await t.post('/api/shift/open',{opening:'200,00'}));await app.sell(t,'50,00','cash');
    const shiftId=(await t.get('/api/state')).body.cash.shift.id;
    assert.deepEqual(ok(await t.post('/api/shift/close',{counted:'242,00',shiftId})),{shiftId,status:'FALTA',blind:true});
    await app.atTill(t);
    const shift=(await t.get('/api/report?period=day')).body.shifts.find(s=>s.id===shiftId);
    assert.equal(shift.expected_cents,25000);assert.equal(shift.counted_cents,24200);assert.equal(shift.difference_cents,-800);assert.equal(shift.closed_by_name,'Ana');
    // In the administrative log: who closed, which shift, and the result (never the amounts).
    const log=(await t.app.adminStore.recentAudit(50)).find(a=>a.action==='caixa_fechado');
    assert.equal(log.username,'Ana');assert.deepEqual(log.detail,{turno:shiftId,situacao:'FALTA'});
  }finally{await t.stop();}
});

test('C08 a shift is closed once: a second close (double click, an old screen) is refused, never applied to the next one',async()=>{
  const t=await blindTill();try{
    const c=await t.signIn('Carla',DEFAULTS);const first=await shiftOf250(t,c);
    ok(await t.post('/api/shift/close',{counted:'250,00',shiftId:first},c));
    let r=await t.post('/api/shift/close',{counted:'250,00',shiftId:first},c);assert.notEqual(r.status,200);
    const second=await shiftOf250(t,c);
    r=await t.post('/api/shift/close',{counted:'250,00',shiftId:first},c);assert.equal(r.status,409);assert.equal(r.body.closed,true);noBalance(r.body,[25000]);
    assert.equal((await t.db.shift()).id,second,'o turno novo continua aberto');
    // There is no way to reopen a closed shift from the till.
    assert.ok(!Object.keys(require('../src/server').POST_ROUTES).some(p=>/reopen|reabrir/.test(p)));
  }finally{await t.close();}
});

test('C09 cash movements need "cash.move"; without the balance a withdrawal has a fixed limit',async()=>{
  const t=await blindTill();try{
    let c=await t.signIn('Carla',DEFAULTS);await shiftOf250(t,c);
    const r=await t.post('/api/shift/move',{kind:'withdrawal',amount:'10,00',note:'cofre'},c);assert.equal(r.status,403);
    assert.equal(r.body.error,DENIED);assert.equal((await t.db.cashSummary()).events.length,0);
    // Allowed to move cash, but not to see the balance: up to R$ 200,00 per withdrawal (the default), and the answer
    // is the blind panel.
    assert.equal(await t.db.blindWithdrawalLimit(),20000);
    c=await t.signIn('Carla',[...DEFAULTS,'cash.move']);
    const moved=ok(await t.post('/api/shift/move',{kind:'withdrawal',amount:'30,00',note:'cofre'},c));
    assert.equal(moved.blind,true);noBalance(moved,[22000,25000]);assert.equal(moved.events.length,1);
    ok(await t.post('/api/shift/move',{kind:'supply',amount:'5,00',note:'troco'},c));
    const over=await t.post('/api/shift/move',{kind:'withdrawal',amount:'200,01',note:'tudo'},c);
    assert.equal(over.status,400);assert.match(over.body.error,/limite permitido sem conferência/);
    const a=t.pos.audits.filter(x=>x.action==='sangria');assert.equal(a.length,1);assert.deepEqual(a[0].detail,{turno:moved.shift.id,valorCentavos:3000,descricao:'cofre'});
    // The administrator changes the limit.
    await t.db.setBlindWithdrawalLimit('50,00');assert.equal(await t.db.blindWithdrawalLimit(),5000);
    assert.equal((await t.post('/api/shift/move',{kind:'withdrawal',amount:'60,00',note:'x'},c)).status,400);
  }finally{await t.close();}
});

test('C10 errors never reveal the expected balance, and a withdrawal does not work as a balance oracle',async()=>{
  const t=await blindTill();try{
    const c=await t.signIn('Carla',[...DEFAULTS,'cash.move']);
    // An empty drawer: R$ 0,00 opening, no sales.
    ok(await t.post('/api/shift/open',{opening:'0,00'},c));
    // Within the limit the answer does not depend on the money in the drawer (it would tell the balance).
    const w=await t.post('/api/shift/move',{kind:'withdrawal',amount:'150,00',note:'teste'},c);assert.equal(w.status,200);noBalance(w.body,[-15000]);
    for(const [p,body] of [['/api/shift/close',{counted:'abc'}],['/api/shift/close',{counted:'-5,00'}],['/api/shift/move',{kind:'withdrawal',amount:'999,00'}],['/api/shift/move',{kind:'withdrawal',amount:'x'}]]){
      const r=await t.post(p,body,c);assert.notEqual(r.status,200,p);noBalance(r.body,[-15000,15000,0]);
      assert.ok(!/esperado|saldo|em caixa/i.test(r.body.error)||/limite/.test(r.body.error),r.body.error);
    }
    // For whoever sees the balance, the drawer limit applies as before.
    const b=await t.signIn('Bruno',[...DEFAULTS,'cash.move','cash.view_expected']);
    const r=await t.post('/api/shift/move',{kind:'withdrawal',amount:'1,00',note:'x'},b);assert.equal(r.status,400);assert.match(r.body.error,/maior que o dinheiro em caixa/);
  }finally{await t.close();}
});
