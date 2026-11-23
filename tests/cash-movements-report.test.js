'use strict';
// The history of withdrawals and supplies in Reports: who did it, how much and when, only for who may see the cash history.
const test=require('node:test'),assert=require('node:assert/strict');
const {tillServer}=require('./pos-helpers');const {DEFAULTS}=require('../src/auth/PermissionCatalog');
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.result!==undefined?r.body.result:r.body;};

async function setup(){
  const t=await tillServer();
  const ana=await t.signIn('Ana',DEFAULTS);
  ok(await t.post('/api/shift/open',{opening:'100,00'},ana));
  ok(await t.post('/api/shift/move',{kind:'withdrawal',amount:'1.250,00',note:'cofre'},ana));
  ok(await t.post('/api/shift/move',{kind:'supply',amount:'40,00',note:'troco'},ana));
  const bia=await t.signIn('Bia',DEFAULTS);
  ok(await t.post('/api/shift/move',{kind:'withdrawal',amount:'20,00',note:'padaria'},bia));
  return {t,ana,bia};
}

test('the report lists the movements with who did them, the amount and the time, and the totals of the period',async()=>{
  const {t}=await setup();try{
    const boss=await t.signIn('Chefe',[...DEFAULTS,'reports.view','cash.view_history']);
    const r=(await t.get('/api/report?period=day',boss)).body;
    assert.equal(r.movements.length,3);
    assert.deepEqual(r.movements.map(e=>[e.operatorName,e.kind,e.amountCents,e.note]).sort(),[['Ana','supply',4000,'troco'],['Ana','withdrawal',125000,'cofre'],['Bia','withdrawal',2000,'padaria']].sort());
    assert.ok(r.movements.every(e=>e.createdAt&&e.shiftId));
    assert.deepEqual(r.movementTotals,{withdrawalsCents:127000,withdrawalsCount:2,suppliesCents:4000,suppliesCount:1});
    // An event of another day is outside the day and inside the week or the month.
    await t.db.adapter.run("UPDATE cash_events SET created_at=? WHERE note='padaria'",[new Date(Date.now()-3*86400000).toISOString()]);
    assert.equal((await t.get('/api/report?period=day',boss)).body.movements.length,2);
    assert.equal((await t.get('/api/report?period=month',boss)).body.movements.length,3);
  }finally{await t.close();}
});

test('without the cash history permission the report carries no movement at all',async()=>{
  const {t}=await setup();try{
    const viewer=await t.signIn('Dani',[...DEFAULTS,'reports.view']);
    const res=await t.get('/api/report?period=day',viewer);assert.equal(res.status,200);
    assert.deepEqual(res.body.movements,[]);assert.equal(res.body.movementTotals,undefined);
    const text=JSON.stringify(res.body);for(const n of ['125000','cofre','padaria','1.250'])assert.ok(!text.includes(n),n);
    // And without the report permission the report is refused.
    const nobody=await t.signIn('Edu',DEFAULTS);assert.equal((await t.get('/api/report?period=day',nobody)).status,403);
  }finally{await t.close();}
});

test('the administrator sees every movement and the report stays blind to the sales totals',async()=>{
  const {t}=await setup();try{
    const admin=await t.signInAdmin();
    const r=(await t.get('/api/report?period=day',admin)).body;assert.equal(r.movements.length,3);
    const boss=await t.signIn('Chefe',[...DEFAULTS,'reports.view','cash.view_history']);
    const blind=(await t.get('/api/report?period=day',boss)).body;assert.equal(blind.blind,true);assert.equal(blind.methods,undefined);assert.equal(blind.movements.length,3);
  }finally{await t.close();}
});
