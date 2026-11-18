'use strict';
// Updating from schema v6 to v7 (F27, F28): shifts closed before keep their one-value close, nothing is rewritten, and the
// new close works right after. Runs on SQLite and on PostgreSQL.
const test=require('node:test'),assert=require('node:assert/strict');
const {tempStore,count,isPostgres}=require('./helpers');const {SCHEMA_VERSION}=require('../src/database/schema');

async function backToV6(s){
  const drop='DROP TABLE shift_reconciliation_items; DROP TABLE shift_reconciliations;';
  if(isPostgres)await s.adapter.exec(drop+' DELETE FROM schema_migrations WHERE version>=7;');
  else await s.adapter.exec(drop+' PRAGMA user_version=6;');
}

test('F27 F28 v6 → v7 keeps a shift closed the old way as legacy, rewrites nothing, and the next close uses the new tables',async()=>{
  const box=await tempStore('luminor-v7-');try{
    let s=box.s;assert.equal(SCHEMA_VERSION,7);
    const ana=(await s.saveEmployee({name:'Ana'})).id;await s.openShift('100,00',ana);
    const shift=(await s.shift()).id;await s.closeShift('100,00');
    const before=await s.adapter.get('SELECT id,opened_at,closed_at,counted_cents,expected_cents,difference_cents FROM shifts WHERE id=?',[shift]);
    await backToV6(s);assert.equal(await s.schemaVersion(),6);
    s=await box.reopen();
    assert.equal(await s.schemaVersion(),7);assert.equal(await count(s,'shift_reconciliations'),0);assert.equal(await count(s,'shift_reconciliation_items'),0);
    assert.deepEqual(await s.adapter.get('SELECT id,opened_at,closed_at,counted_cents,expected_cents,difference_cents FROM shifts WHERE id=?',[shift]),before);
    // A second update of the same database is a no-op (the migration is idempotent).
    s=await box.reopen();assert.equal(await s.schemaVersion(),7);
    await s.openShift('50,00',ana);const next=(await s.shift()).id;
    await s.closeShift({cash:'50,00',pix:'0,00',credit:'0,00',debit:'0,00'},{shiftId:next,idempotencyKey:'k-'+'x'.repeat(12)});
    assert.equal(await count(s,'shift_reconciliations'),1);assert.equal(await count(s,'shift_reconciliation_items'),4);
  }finally{await box.close?.();}
});
