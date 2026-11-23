'use strict';
// Sales paid in parts travel with backups, restores, the export to PostgreSQL and the cloud copy; a backup made before the
// parts existed (schema v7) gets them rebuilt when restored. The file backups use the local SQLite database.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');const {randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {decodeBackup,encodeBackup,sha256}=require('../src/backup/BackupFormat');
const {isPostgres}=require('./helpers');
const {boot,ok,setupAdmin,openShift,active,sell,backup,backupFile,keyOf,recoveryKey,restore}=require('./app-helpers');
const {fakeCloud,syncOf,settled,sameAsCloud,withCopy}=require('./cloud-helpers');
const {exportLocalData}=require('../src/database/migration-tools/ExportLocalData');const {replaceData,checkExport}=require('../src/database/migration-tools/copyData');
const {tempStore}=require('./helpers');
const SKIP=isPostgres&&'backups em arquivo e cópia na nuvem existem só para o banco local (SQLite)';

// A sale of the given amount paid in parts through the API.
async function sellParts(t,amount,payments){
  const saleId=await active(t);ok(await t.post('/api/cart/manual-value',{saleId,amount}));
  return ok(await t.post('/api/checkout',{saleId,uuid:randomUUID(),payments})).sale;
}
const partsTable=async t=>(await t.app.db.adapter.all('SELECT sale_id,method,amount_cents,received_cents,change_cents,created_at FROM sale_payments ORDER BY sale_id,method'));
// A backup of t with its database changed and its manifest adjusted (a file made to look like an older version).
async function crafted(t,{mutate,manifest:fix}){
  const {manifest,database}=decodeBackup(backupFile(t,(await backup(t)).name),keyOf(t));const f=path.join(t.home,'tmp','craft.sqlite');
  fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,database);const d=new DatabaseSync(f);mutate(d);d.close();const db=fs.readFileSync(f);fs.rmSync(f);
  return encodeBackup({manifest:{...fix(manifest),database:{bytes:db.length,sha256:sha256(db)}},database:db,key:keyOf(t)});
}

test('PB01 a backup carries the parts of every sale and restores them exactly, and the databases compare equal',{skip:SKIP},async()=>{
  const {validateMigration}=require('../src/database/migration-tools/ValidateMigration');
  const a=await boot(),b=await boot();try{
    await setupAdmin(a);await openShift(a);
    await sellParts(a,'50,00',[{method:'cash',amount:'20,00',received:'50,00'},{method:'pix',amount:'30,00'}]);await sell(a,'22,30','credit');
    await sellParts(a,'40,00',[{method:'cash',amount:'10,00'},{method:'pix',amount:'10,00'},{method:'credit',amount:'10,00'},{method:'debit',amount:'10,00'}]);
    const before=await partsTable(a);assert.equal(before.length,7);
    const file=backupFile(a,(await backup(a)).name);const key=await recoveryKey(a);
    await setupAdmin(b);const r=await restore(b,file,{key});assert.equal(r.review.schemaVersion,9);ok(await r.confirm());
    assert.deepEqual(await partsTable(b),before);
    const report=await validateMigration(a.app.db.adapter,b.app.db.adapter);assert.equal(report.ok,true,JSON.stringify(report.tables.filter(x=>!x.ok)));
  }finally{await a.stop();await b.stop();}
});

test('PB02 a backup of schema v7 (sales without parts) is restored and every sale gets its part',{skip:SKIP},async()=>{
  const a=await boot(),b=await boot();try{
    await setupAdmin(a);await openShift(a);
    await sell(a,'10,00','cash');await sell(a,'22,30','credit');const x=await sell(a,'5,00','pix');
    ok(await a.post('/api/sales/cancel',{id:x.id,reason:'Cancelada antes do backup'}));
    const old=await crafted(a,{mutate:d=>{d.exec('DROP TABLE sale_payments');d.exec('PRAGMA user_version=7');},
      manifest:m=>{const counts={...m.summary.counts};delete counts.sale_payments;return {...m,schemaVersion:7,summary:{...m.summary,counts}};}});
    const key=await recoveryKey(a);await setupAdmin(b);
    const r=await restore(b,old,{key});assert.equal(r.review.schemaVersion,7);ok(await r.confirm());
    assert.equal(await b.app.db.schemaVersion(),9);
    const parts=await partsTable(b);assert.deepEqual(parts.map(p=>[p.method,p.amount_cents]),[['cash',1000],['credit',2230],['pix',500]],'inclusive a venda cancelada');
    const bad=await b.app.db.adapter.all("SELECT s.id FROM sales s WHERE s.status='done' AND s.total_cents<>(SELECT SUM(p.amount_cents) FROM sale_payments p WHERE p.sale_id=s.id)");assert.deepEqual(bad,[]);
  }finally{await a.stop();await b.stop();}
});

test('PB03 the export for PostgreSQL has the parts, passes the structure check, and loads back into another database',async()=>{
  const a=await tempStore('luminor-exp-a-'),b=await tempStore('luminor-exp-b-');try{
    const {till,draftOf,part,pay}=require('./split-helpers');void till;
    const s=a.s;const ana=(await s.saveEmployee({name:'Ana'})).id;await s.openShift('50,00',ana);
    const d=await draftOf(s,'50,00');await pay(s,d,[part('cash','20,00'),part('pix','30,00')]);
    const data=await exportLocalData(s.adapter);assert.equal(data.tables.sale_payments.length,2);assert.equal(data.summary.counts.sale_payments,2);checkExport(data);
    await replaceData(b.s.adapter,data);
    const copy=await b.s.adapter.all('SELECT sale_id,method,amount_cents FROM sale_payments ORDER BY id');assert.deepEqual(copy.map(p=>[p.method,Number(p.amount_cents)]),[['cash',2000],['pix',3000]]);
    assert.deepEqual((await exportLocalData(b.s.adapter)).tables.sale_payments.map(p=>p.uuid),data.tables.sale_payments.map(p=>p.uuid));
  }finally{await a.clean();await b.clean();}
});

test('PB04 without internet a sale in parts is saved and its parts reach the cloud copy, once, when it comes back',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud);try{
    await openShift(t);await sellParts(t,'30,00',[{method:'cash',amount:'10,00'},{method:'pix',amount:'20,00'}]);await settled(t);
    assert.equal(await cloud.count('sale_payments'),2);
    cloud.down=true;
    await sellParts(t,'40,00',[{method:'cash',amount:'10,00'},{method:'pix',amount:'10,00'},{method:'credit',amount:'10,00'},{method:'debit',amount:'10,00'}]);
    assert.equal(await cloud.count('sale_payments'),2,'nada chegou ainda');assert.equal((await t.app.db.adapter.get('SELECT COUNT(*) AS n FROM sale_payments')).n,6);
    cloud.down=false;await settled(t);await sameAsCloud(t,cloud);assert.equal(await cloud.count('sale_payments'),6);
    void syncOf;
  }finally{await t.stop();}
});
