'use strict';
// A confirmed close travels with the backup: restore into another installation brings the same reconciliations (F29, F30).
const test=require('node:test'),assert=require('node:assert/strict');
const {isPostgres}=require('./helpers');
const {boot,ok,setupAdmin,openShift,sell,closeShift,backup,backupFile,recoveryKey,restore}=require('./app-helpers');
const SKIP=isPostgres&&'backups em arquivo existem só para o banco local (SQLite)';

test('F29 F30 backup and restore carry the confirmed close, its four items and its revision flag',{skip:SKIP},async()=>{
  const {validateMigration}=require('../src/database/migration-tools/ValidateMigration');
  const a=await boot(),b=await boot();try{
    await setupAdmin(a);await openShift(a);await sell(a,'10,00','cash');await sell(a,'22,30','credit');
    await closeShift(a);
    const heads=await a.app.db.adapter.all('SELECT shift_id,revision,status,is_current FROM shift_reconciliations');
    assert.equal(heads.length,1);assert.equal(heads[0].is_current,1);
    const file=backupFile(a,(await backup(a)).name);const key=await recoveryKey(a);
    await setupAdmin(b);const r=await restore(b,file,{key});ok(await r.confirm());
    const after=await b.app.db.adapter.all('SELECT shift_id,revision,status,is_current FROM shift_reconciliations');assert.deepEqual(after,heads);
    assert.equal((await b.app.db.adapter.get('SELECT COUNT(*) AS n FROM shift_reconciliation_items')).n,4);
    const report=await validateMigration(a.app.db.adapter,b.app.db.adapter);assert.equal(report.ok,true,JSON.stringify(report.tables.filter(x=>!x.ok)));
  }finally{await a.stop();await b.stop();}
});
