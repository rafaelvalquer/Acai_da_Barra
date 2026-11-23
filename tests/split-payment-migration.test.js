'use strict';
// Updating from schema v7 to v8: every sale made before gets its one payment part, nothing else changes, and the
// migration can run twice. SQLite and PostgreSQL.
const test=require('node:test'),assert=require('node:assert/strict');
const {tempStore,isPostgres}=require('./helpers');const {SCHEMA_VERSION,TABLES}=require('../src/database/schema');
const {till,draftOf,part,uid,pay,rows,partsOf,integrity,clean}=require('./split-helpers');
const {migrate}=require('../src/store');

// The database as the previous version left it: sales without parts, schema at 7.
async function backToV7(s){
  if(isPostgres)await s.adapter.exec('DROP TABLE sale_payments; DELETE FROM schema_migrations WHERE version>=8;');
  else await s.adapter.exec('DROP TABLE sale_payments; PRAGMA user_version=7;');
}
const snapshot=async s=>{
  const out={};for(const t of TABLES.filter(x=>x.name!=='sale_payments'))out[t.name]=JSON.stringify(await s.adapter.all(`SELECT ${t.columns.join(',')} FROM ${t.name} ORDER BY ${t.key}`));return out;
};

test('PM01 v7 → v8 gives every sale (canceled ones too) one part with its method and total, keeps received and change of cash, and touches nothing else',async()=>{
  const t=await till();try{
    let {s}=t;const water=(await s.product({name:'Água',price:'5,00',stock:10})).id;
    const sale=async(method,value,received)=>{const d=await draftOf(s,value);return (await s.checkoutDraftSale(d.id,method,uid(),received,d.revision)).sale;};
    const a=await sale('cash','20,00','50,00'),b=await sale('cash','15,00'),c=await sale('pix','10,00'),d=await sale('credit','30,00'),e=await sale('debit','12,34');
    const id=await s.activeSaleId();await s.addUnit(id,water,2);const f=(await s.checkoutDraftSale(id,'pix',uid(),undefined,(await s.getDraftSale(id)).revision)).sale;
    await s.cancelSale(c.id,'Cancelada antes da atualização');
    await s.closeShift({cash:'130,00',pix:'10,00',credit:'30,00',debit:'12,34'},{idempotencyKey:'k-'+uid()});
    await backToV7(s);assert.equal(await s.schemaVersion(),7);const before=await snapshot(s);
    s=await t.box.reopen();
    assert.equal(await s.schemaVersion(),SCHEMA_VERSION);
    assert.deepEqual(await snapshot(s),before,'nada além de sale_payments mudou');
    assert.deepEqual(await partsOf(s,a.id),[{method:'cash',amount_cents:2000,received_cents:5000,change_cents:3000}]);
    assert.deepEqual(await partsOf(s,b.id),[{method:'cash',amount_cents:1500,received_cents:null,change_cents:null}]);
    assert.deepEqual(await partsOf(s,c.id),[{method:'pix',amount_cents:1000,received_cents:null,change_cents:null}],'a venda cancelada também');
    assert.deepEqual(await partsOf(s,d.id),[{method:'credit',amount_cents:3000,received_cents:null,change_cents:null}]);
    assert.deepEqual(await partsOf(s,e.id),[{method:'debit',amount_cents:1234,received_cents:null,change_cents:null}]);
    assert.equal((await partsOf(s,f.id))[0].amount_cents,1000);
    assert.deepEqual(await integrity(s),clean);
    assert.equal(Number((await s.adapter.get('SELECT stock FROM products WHERE id=?',[water])).stock),8,'estoque intacto');
    const uuids=await rows(s,'SELECT uuid FROM sale_payments');assert.equal(new Set(uuids.map(r=>r.uuid)).size,uuids.length);
  }finally{await t.clean();}
});

test('PM02 running the migration again, or with some parts already there, creates no duplicate',async()=>{
  const t=await till();try{
    let {s}=t;const d1=await draftOf(s,'20,00');const one=(await pay(s,d1,[part('cash','10,00'),part('pix','10,00')])).sale;
    const d2=await draftOf(s,'30,00');const two=(await s.checkoutDraftSale(d2.id,'credit',uid(),undefined,d2.revision)).sale;
    // Only the second sale loses its part (an interrupted update): the first keeps its two parts untouched.
    await s.adapter.run('DELETE FROM sale_payments WHERE sale_id=?',[two.id]);
    if(isPostgres)await s.adapter.exec('DELETE FROM schema_migrations WHERE version>=8;');else await s.adapter.exec('PRAGMA user_version=7;');
    s=await t.box.reopen();
    assert.equal((await partsOf(s,one.id)).length,2);assert.equal((await partsOf(s,two.id)).length,1);
    await migrate(s.adapter);s=await t.box.reopen();
    assert.equal(Number((await s.adapter.get('SELECT COUNT(*) AS n FROM sale_payments')).n),3);assert.deepEqual(await integrity(s),clean);
  }finally{await t.clean();}
});

test('PM03 after the update every finished sale is paid exactly by its parts: no sum mismatch, no orphan part, no invalid method',async()=>{
  const t=await till();try{
    let {s}=t;const d=await draftOf(s,'20,00');await s.checkoutDraftSale(d.id,'pix',uid(),undefined,d.revision);
    await backToV7(s);
    s=await t.box.reopen();assert.equal(await s.schemaVersion(),SCHEMA_VERSION);
    assert.deepEqual(await integrity(s),clean);
  }finally{await t.clean();}
});

test('PM04 the table has the constraints of the plan: one part per method and sale, positive amount, cash-only received, change = received - part',async()=>{
  const t=await till();try{
    const {s}=t;const d=await draftOf(s,'20,00');const sale=(await pay(s,d,[part('cash','10,00'),part('pix','10,00')])).sale;
    const ins=(m,amount,rec,ch)=>s.adapter.run('INSERT INTO sale_payments(uuid,sale_id,method,amount_cents,received_cents,change_cents,created_at) VALUES(?,?,?,?,?,?,?)',[uid(),sale.id,m,amount,rec,ch,new Date().toISOString()]);
    await assert.rejects(ins('cash',500,null,null),'duplicada');
    await assert.rejects(ins('credit',0,null,null),'zero');await assert.rejects(ins('credit',-1,null,null),'negativo');
    await assert.rejects(ins('boleto',100,null,null),'método');await assert.rejects(ins('credit',100,200,100),'recebido só em dinheiro');
    await assert.rejects(s.adapter.run('UPDATE sale_payments SET change_cents=1 WHERE method=?',['cash']),'troco incoerente');
    await assert.rejects(s.adapter.run('DELETE FROM sales WHERE id=?',[sale.id]),'a venda não some com parcelas');
  }finally{await t.clean();}
});
