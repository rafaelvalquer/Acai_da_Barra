'use strict';
// Backups, restores and the installation's data folder (plan tests D01–D16), on a real server with a throwaway
// PDV_HOME, through the Admin area's routes (/api/admin). SQLite only: file backups and restores exist for the
// local database; the cloud database's backups are in tests/admin-database.test.js.
const {SCHEMA_VERSION}=require('../src/database/schema');
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {decodeBackup,encodeBackup,sha256,formatKey,newKey,keyId}=require('../src/backup/BackupFormat');
const {selectToKeep}=require('../src/backup/retention');const {lastScheduled,instantOf}=require('../src/backup/clock');
const {JOURNAL}=require('../src/backup/RestoreService');
const {isPostgres,until}=require('./helpers');
const {boot,newHome,ok,setupAdmin,login,openShift,active,sell,closeShift,backup,backupFile,keyOf,recoveryKey,restore,salesCount,adminAudit,TEST_ADMIN_PASSWORD}=require('./app-helpers');
const SKIP=isPostgres&&'backups em arquivo existem só para o banco local (SQLite)';
// A backup of t whose database or manifest was changed, encrypted with t's key (a file made to look valid).
async function crafted(t,{mutate,manifest:patch={}}={}){
  const {manifest,database}=decodeBackup(backupFile(t,(await backup(t)).name),keyOf(t));let db=database;
  if(mutate){const f=path.join(t.home,'tmp','craft.sqlite');fs.writeFileSync(f,database);const d=new DatabaseSync(f);mutate(d);d.close();db=fs.readFileSync(f);fs.rmSync(f);}
  return encodeBackup({manifest:{...manifest,...patch,database:{bytes:db.length,sha256:sha256(db)}},database:db,key:keyOf(t)});
}
const overview=async t=>(await t.get('/api/admin/backup')).body;

test('D01 a backup with the shift open is consistent, includes the open shift and does not stop sales',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);await openShift(t);await sell(t,'12,50');await sell(t,'20,00','cash');
    const saleId=await active(t);ok(await t.post('/api/cart/manual-value',{saleId,amount:'7,00'}));
    // A sale and a backup at the same moment: both complete, neither waits for the other to finish writing files.
    const [b]=await Promise.all([backup(t),sell(t,'3,00')]);
    assert.match(b.name,/^luminor-pdv_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_manual\.luminorbackup$/);
    const {manifest,header}=decodeBackup(backupFile(t,b.name),keyOf(t));
    assert.equal(header.format,'luminor-pdv-backup');assert.equal(manifest.schemaVersion,SCHEMA_VERSION);assert.equal(manifest.app.version,t.config.version);
    assert.equal(manifest.summary.shifts.open,1);assert.ok([2,3].includes(manifest.summary.sales.done));
    assert.ok(manifest.summary.counts.sales===manifest.summary.sales.done);
    // The Admin credentials are not part of a commercial backup.
    assert.equal(Object.keys(manifest.summary.counts).some(k=>/admin|audit/.test(k)),false);
    const ov=await overview(t);
    assert.equal(ov.lastSuccess.name,b.name);assert.ok(ov.files.some(f=>f.name===b.name&&f.kind==='manual'));
    assert.ok(ov.history.some(h=>h.name===b.name&&h.ok!==false));
    assert.equal(await salesCount(t),3);
  }finally{await t.stop();}
});

test('D02 open sales in several tabs come back exactly after a restore',{skip:SKIP},async()=>{
  const a=await boot(),b=await boot();try{
    await setupAdmin(a);await openShift(a);
    for(const [label,amount] of [['Mesa 1','8,00'],['Família Souza','15,40'],['Balcão','3,10']]){
      const id=await active(a);ok(await a.post('/api/open-sales/rename',{saleId:id,label}));ok(await a.post('/api/cart/manual-value',{saleId:id,amount}));ok(await a.post('/api/open-sales/create'));
    }
    const before=(await a.get('/api/open-sales')).body;const file=backupFile(a,(await backup(a)).name);const key=await recoveryKey(a);
    await setupAdmin(b);
    const r=await restore(b,file,{key});assert.equal(r.review.summary.openSales.sales,4);assert.equal(r.review.summary.shifts.open,1);
    ok(await r.confirm());
    const after=(await b.get('/api/open-sales')).body;
    assert.equal(after.activeSaleId,before.activeSaleId);
    assert.deepEqual(after.sales.map(s=>[s.id,s.label,s.total_cents??s.totalCents,s.items??s.item_count]),before.sales.map(s=>[s.id,s.label,s.total_cents??s.totalCents,s.items??s.item_count]));
    for(const s of before.sales)assert.deepEqual(await b.app.db.getDraftSale(s.id),await a.app.db.getDraftSale(s.id));
  }finally{await a.stop();await b.stop();}
});

test('D03 restoring into an empty installation needs the recovery key and the administrator password',{skip:SKIP},async()=>{
  const a=await boot(),b=await boot();try{
    await setupAdmin(a);await openShift(a);await sell(a,'10,00');await sell(a,'5,00');await closeShift(a);
    const file=backupFile(a,(await backup(a)).name);const key=await recoveryKey(a);
    assert.match(key,/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    await setupAdmin(b);
    const up=ok(await b.upload(file));assert.equal(up.needsRecoveryKey,true);
    let r=await b.post('/api/admin/backup/restore/validate',{uploadId:up.uploadId});assert.equal(r.status,422);assert.equal(r.body.needsRecoveryKey,true);
    r=await b.post('/api/admin/backup/restore/validate',{uploadId:up.uploadId,recoveryKey:formatKey(newKey())});assert.equal(r.status,422);assert.match(r.body.error,/não corresponde/);
    r=await b.post('/api/admin/backup/restore/validate',{uploadId:up.uploadId,recoveryKey:'ABC'});assert.equal(r.status,400);
    // Typed in lower case, without dashes, with O for 0: still accepted.
    const review=ok(await b.post('/api/admin/backup/restore/validate',{uploadId:up.uploadId,recoveryKey:key.toLowerCase().replace(/-/g,'').replace(/0/g,'o')}));
    assert.equal(review.summary.sales.done,2);assert.equal(review.summary.sales.doneCents,1500);assert.equal(review.keySource,'recuperacao');
    r=await b.post('/api/admin/backup/restore',{uploadId:up.uploadId,password:'senha-errada-123'});assert.equal(r.status,401);
    assert.equal(await salesCount(b),0);
    const done=ok(await b.post('/api/admin/backup/restore',{uploadId:up.uploadId,password:TEST_ADMIN_PASSWORD}));
    assert.equal(done.restored,true);assert.match(done.safetyBackup,/_seguranca\.luminorbackup$/);
    assert.equal(await salesCount(b),2);
    const audit=fs.readFileSync(path.join(b.home,'logs','auditoria.log'),'utf8');assert.match(audit,/"backup_restaurado"/);
    const rows=await b.app.adminStore.recentAudit(20);assert.ok(rows.some(x=>x.action==='backup_restaurado'&&x.detail.keySource==='recuperacao'&&x.username==='admin'));
    assert.equal(fs.existsSync(path.join(b.home,'data',JOURNAL)),false);
    assert.deepEqual(fs.readdirSync(path.join(b.home,'data')).filter(f=>f.includes('antes-da-restauracao')),[]);
    // The PDV keeps working on the restored data, and the Admin session is still the same.
    assert.equal((await b.get('/api/admin/overview')).status,200);
    await openShift(b,'Bia');await sell(b,'1,00');assert.equal(await salesCount(b),3);
  }finally{await a.stop();await b.stop();}
});

test('D04 a corrupted or truncated backup is rejected and nothing changes',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);await openShift(t);await sell(t);await closeShift(t);
    const file=backupFile(t,(await backup(t)).name);
    const flipped=Buffer.from(file);flipped[Math.floor(flipped.length*0.6)]^=0x40;
    let up=ok(await t.upload(flipped));let r=await t.post('/api/admin/backup/restore/validate',{uploadId:up.uploadId});
    assert.equal(r.status,422);assert.match(r.body.error,/corrompido|alterado/);
    r=await t.upload(file.subarray(0,40));assert.equal(r.status,422);
    r=await t.upload(file.subarray(0,Math.floor(file.length/2)));
    if(r.status===200){r=await t.post('/api/admin/backup/restore/validate',{uploadId:r.body.result.uploadId});}assert.equal(r.status,422);
    assert.equal(await salesCount(t),1);
    assert.ok((await adminAudit(t)).includes('restauracao_recusada'));
  }finally{await t.stop();}
});

test('D05 incompatible backups are rejected: not a backup, newer version, triggers, unknown tables',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);
    let r=await t.upload(Buffer.from('PK\u0003\u0004 isto é um zip, não um backup'));assert.equal(r.status,422);assert.match(r.body.error,/não é um backup/);
    const check=async(bytes,pattern)=>{const up=ok(await t.upload(bytes));const v=await t.post('/api/admin/backup/restore/validate',{uploadId:up.uploadId});assert.equal(v.status,422,JSON.stringify(v.body));assert.match(v.body.error,pattern);};
    await check(await crafted(t,{manifest:{schemaVersion:99}}),/versão mais nova/);
    await check(await crafted(t,{mutate:d=>d.exec("CREATE TRIGGER x AFTER INSERT ON sales BEGIN DELETE FROM sales; END;")}),/não permitido/);
    await check(await crafted(t,{mutate:d=>d.exec('CREATE VIEW v AS SELECT 1')}),/não permitido/);
    await check(await crafted(t,{mutate:d=>d.exec('CREATE TABLE intrusa(x)')}),/desconhecida/);
    // An old-style table with logins inside a commercial backup is refused: it can never bring a password back.
    await check(await crafted(t,{mutate:d=>d.exec('CREATE TABLE admin_users(id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)')}),/desconhecida/);
    await check(await crafted(t,{mutate:d=>d.exec('ALTER TABLE sales DROP COLUMN change_cents')}),/estrutura|diferente/);
    await check(await crafted(t,{manifest:{provider:'mysql'}}),/não é compatível|desconhecido|SQLite|PostgreSQL/);
    // The manifest's counts must match what is inside.
    await check(await crafted(t,{mutate:d=>d.exec("INSERT INTO settings(k,v) VALUES('extra','1')")}),/contagem/);
  }finally{await t.stop();}
});

test('D06 a restore is refused while the shift is open or there is weight on the scale',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);const file=backupFile(t,(await backup(t)).name);
    await openShift(t);await sell(t);
    const r=await restore(t,file);let c=await r.confirm();assert.equal(c.status,409);assert.match(c.body.error,/Feche o caixa/);
    assert.equal(await salesCount(t),1);
    await closeShift(t);ok(await t.post('/api/scale/demo'));ok(await t.post('/api/scale/demo-weight',{grams:300}));
    // With weight on the scale the file is not even received.
    const up=await t.upload(file);assert.equal(up.status,409);assert.match(up.body.error,/balança/);
    assert.equal(await salesCount(t),1);
  }finally{await t.stop();}
});

test('D07 a power cut during a backup leaves no usable-looking file, and the next start cleans up',{skip:SKIP},async()=>{
  const home=newHome();let crash=true;
  const t=await boot(home,{hooks:{afterWrite:async()=>{if(crash)throw Object.assign(Error('energia cortada'),{code:'EIO'});}}});
  let lastGood;try{
    await setupAdmin(t);const r=await t.post('/api/admin/backup/export');assert.equal(r.status,500);
    assert.deepEqual(fs.readdirSync(path.join(home,'backups','manuais')),[]);
    crash=false;lastGood=await backup(t);
  }finally{await t.stop();}
  // What a real power cut leaves: a .partial file and a staging folder.
  fs.writeFileSync(path.join(home,'backups','manuais','luminor-pdv_2026-11-06_10-00-00_manual.luminorbackup.partial'),'meio arquivo');
  fs.mkdirSync(path.join(home,'tmp','backup-abc123'),{recursive:true});fs.writeFileSync(path.join(home,'tmp','backup-abc123','snapshot.sqlite'),'x');
  const t2=await boot(home);try{
    assert.deepEqual(fs.readdirSync(path.join(home,'backups','manuais')),[lastGood.name]);
    assert.equal(fs.existsSync(path.join(home,'tmp','backup-abc123')),false);
    assert.ok(t2.log.lines.some(l=>/incompleto/.test(l)));
    ok(await login(t2));
    const ov=await overview(t2);assert.equal(ov.lastSuccess.name,lastGood.name);assert.equal(ov.files.length,1);
  }finally{await t2.stop();}
});

test('D08 a restore that fails halfway puts the previous database back',{skip:SKIP},async()=>{
  let fail=true;const t=await boot(undefined,{hooks:{afterSwap:async()=>{if(fail)throw Error('falha simulada depois da troca');}}});try{
    await setupAdmin(t);const empty=backupFile(t,(await backup(t)).name);
    await openShift(t);await sell(t,'9,99');await closeShift(t);
    const r=await restore(t,empty);const c=await r.confirm();
    assert.equal(c.status,500);assert.match(c.body.error,/dados anteriores foram mantidos/);
    assert.equal(await salesCount(t),1);
    assert.equal(fs.existsSync(path.join(t.home,'data',JOURNAL)),false);
    assert.deepEqual(fs.readdirSync(path.join(t.home,'data')).filter(f=>f.includes('antes-da-restauracao')),[]);
    // Still selling, and the failure is in the audit.
    assert.equal((await t.get('/api/health')).body.ok,true);
    await openShift(t,'Bia');await sell(t,'1,00');assert.equal(await salesCount(t),2);
    assert.ok((await adminAudit(t)).includes('restauracao_falhou'));
    assert.match(fs.readFileSync(path.join(t.home,'logs','auditoria.log'),'utf8'),/restauracao_falhou/);
  }finally{await t.stop();}
});

test('D08 a power cut in the middle of a restore is undone at the next start',{skip:SKIP},async()=>{
  const home=newHome();const t=await boot(home);
  try{await setupAdmin(t);await openShift(t);await sell(t,'4,00');await closeShift(t);}finally{await t.stop();}
  // The state a restore leaves when the power goes out right after moving the files.
  const data=path.join(home,'data');const target=path.join(data,'luminor-pdv.sqlite');const previous=path.join(data,'luminor-pdv.antes-da-restauracao-2026-11-06_10-00-00.sqlite');
  fs.renameSync(target,previous);fs.writeFileSync(target,'banco pela metade');
  fs.writeFileSync(path.join(data,JOURNAL),JSON.stringify({state:'trocando',target,previous,startedAt:new Date().toISOString()}));
  const t2=await boot(home);try{
    assert.equal(await salesCount(t2),1);assert.equal(fs.existsSync(previous),false);assert.equal(fs.existsSync(path.join(data,JOURNAL)),false);
    assert.ok(t2.log.lines.some(l=>/Restauração interrompida/.test(l)));
    ok(await login(t2));
  }finally{await t2.stop();}
});

test('D09 a restart (Windows reboot) keeps sales, backup settings and status, the scale port and the key',{skip:SKIP},async()=>{
  const home=newHome();const t=await boot(home);let state;
  try{
    await setupAdmin(t);await openShift(t);await sell(t,'6,00');const b=await backup(t);
    ok(await t.post('/api/admin/backup/settings',{enabled:true,time:'03:30',retentionDays:10}));
    t.app.system.rememberScale('COM9',2400);
    state={backup:b.name,keyId:t.app.system.backups.keys.id(),open:(await t.get('/api/open-sales')).body};
  }finally{await t.stop();}
  const t2=await boot(home);try{
    ok(await login(t2));
    const ov=await overview(t2);
    assert.equal(ov.lastSuccess.name,state.backup);assert.deepEqual([ov.settings.enabled,ov.settings.time,ov.settings.retentionDays],[true,'03:30',10]);
    assert.equal(ov.recoveryKey.id,state.keyId);assert.deepEqual(ov.hardware,{configured:true,path:'COM9',found:false,...(ov.hardware.error?{error:ov.hardware.error}:{})});
    assert.deepEqual((await t2.get('/api/open-sales')).body,state.open);assert.equal(await salesCount(t2),1);
    assert.ok(t2.log.lines.some(l=>/COM9/.test(l)));
  }finally{await t2.stop();}
});

test('D10 an update keeps the data: the old program folder database is copied once and migrated, never changed',{skip:SKIP},async()=>{
  const legacyDir=newHome();const legacy=path.join(legacyDir,'luminor-pdv.sqlite');
  const old=new DatabaseSync(legacy);
  old.exec(`CREATE TABLE settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
   CREATE TABLE products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,price_cents INTEGER NOT NULL,stock INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE shifts(id INTEGER PRIMARY KEY AUTOINCREMENT,opened_at TEXT NOT NULL,opening_cents INTEGER NOT NULL,closed_at TEXT, counted_cents INTEGER,expected_cents INTEGER, difference_cents INTEGER);
   CREATE TABLE cash_events(id INTEGER PRIMARY KEY AUTOINCREMENT,shift_id INTEGER NOT NULL,kind TEXT NOT NULL,amount_cents INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
   CREATE TABLE sales(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE NOT NULL,shift_id INTEGER NOT NULL,created_at TEXT NOT NULL,method TEXT NOT NULL,total_cents INTEGER NOT NULL);
   CREATE TABLE sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL,product_id INTEGER,kind TEXT NOT NULL,label TEXT NOT NULL,grams INTEGER,quantity INTEGER,unit_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL);
   INSERT INTO settings VALUES('price_kg_cents','5990');`);
  const at=new Date().toISOString();old.prepare('INSERT INTO shifts(opened_at,opening_cents,closed_at,counted_cents,expected_cents,difference_cents) VALUES(?,0,?,1234,1234,0)').run(at,at);
  old.prepare("INSERT INTO sales(uuid,shift_id,created_at,method,total_cents) VALUES('legacy-sale-0001',1,?,'cash',1234)").run(at);
  old.prepare("INSERT INTO sale_items(sale_id,kind,label,grams,unit_cents,total_cents) VALUES(1,'weight','Açaí por peso',206,5990,1234)").run();old.close();
  const hash=sha256(fs.readFileSync(legacy));
  const home=newHome();const t=await boot(home,{env:{PDV_LEGACY_SQLITE:legacy}});try{
    assert.equal(await salesCount(t),1);assert.equal(await t.app.db.schemaVersion(),SCHEMA_VERSION);assert.equal((await t.app.db.getConfig()).priceKgCents,5990);
    assert.equal(sha256(fs.readFileSync(legacy)),hash);assert.ok(t.log.lines.some(l=>/não foi alterado/.test(l)));
    await setupAdmin(t);await openShift(t);await sell(t);
  }finally{await t.stop();}
  // Updating again (same folder): the import happens only once; the data added since stays.
  const t2=await boot(home,{env:{PDV_LEGACY_SQLITE:legacy}});try{assert.equal(await salesCount(t2),2);}finally{await t2.stop();}
  assert.equal(sha256(fs.readFileSync(legacy)),hash);
});

test('D11 computer off at backup time: the missed daily backup runs at the next start, once',{skip:SKIP},async()=>{
  const home=newHome();let now=new Date('2026-11-06T12:00:00Z');// 09:00 in São Paulo
  fs.mkdirSync(path.join(home,'backups'),{recursive:true});
  fs.writeFileSync(path.join(home,'backups','estado.json'),JSON.stringify({lastAutomatic:{at:'2026-11-04T05:00:10.000Z',kind:'automatico',name:'antigo'},lastSuccess:{at:'2026-11-04T05:00:10.000Z',kind:'automatico'},history:[]}));
  const t=await boot(home,{env:{PDV_BACKUP_ENABLED:'true'},clock:()=>now});try{
    const status=t.app.system.backups.status;const scheduler=t.app.system.backups.scheduler;
    await until(()=>status.lastAutomatic?.at==='2026-11-06T12:00:00.000Z'&&!scheduler.running,5000);
    assert.deepEqual(fs.readdirSync(path.join(home,'backups','automaticos')),['luminor-pdv_2026-11-06_09-00-00_automatico.luminorbackup']);
    assert.equal(await scheduler.tick(),null);assert.equal(scheduler.next(),'2026-11-07T05:00:00.000Z');
    // Left on through the night: the next one runs at 02:00, not before.
    now=new Date('2026-11-07T04:59:00Z');assert.equal(await scheduler.tick(),null);
    now=new Date('2026-11-07T05:00:30Z');const r=await scheduler.tick();assert.equal(r.kind,'automatico');
    assert.equal(fs.readdirSync(path.join(home,'backups','automaticos')).length,2);
  }finally{await t.stop();}
});

test('D12 disk full: the backup fails with an alert, nothing half-written stays and sales go on',{skip:SKIP},async()=>{
  let full=true;const t=await boot(undefined,{hooks:{beforeWrite:async()=>{if(full)throw Object.assign(Error('ENOSPC: no space left on device'),{code:'ENOSPC'});}}});try{
    await setupAdmin(t);await openShift(t);
    const r=await t.post('/api/admin/backup/export');assert.equal(r.status,500);assert.match(r.body.error,/Disco cheio/);
    await sell(t);assert.equal(await salesCount(t),1);
    let ov=await overview(t);assert.ok(ov.alerts.some(a=>a.level==='erro'&&/Disco cheio/.test(a.text)));
    assert.equal((await t.get('/api/state')).body.system.alert,'erro');
    assert.deepEqual(fs.readdirSync(path.join(t.home,'backups','manuais')),[]);
    full=false;await backup(t);
    ov=await overview(t);assert.equal(ov.alerts.some(a=>a.level==='erro'),false);
  }finally{await t.stop();}
});

test('D13 only an administrator session backs up, downloads and restores; other sites cannot trigger anything',{skip:SKIP},async()=>{
  const t=await boot();try{
    // Nobody signed in (the operator at the counter): every Admin route is refused.
    for(const p of ['/api/admin/overview','/api/admin/backup','/api/admin/database','/api/admin/diagnostics','/api/admin/access-log'])assert.equal((await t.get(p,null)).status,401,p);
    assert.equal((await t.post('/api/admin/backup/export',{},null)).status,401);assert.equal((await t.upload(Buffer.from('x'),null)).status,401);
    assert.equal((await t.post('/api/admin/backup/restore',{uploadId:'x',password:'x'},null)).status,401);
    // admin/admin opens only the screen for the new password.
    ok(await t.post('/api/admin/login',{username:'admin',password:'admin'}));
    assert.equal((await t.get('/api/admin/backup')).status,403);assert.equal((await t.post('/api/admin/backup/export')).status,403);
    ok(await t.post('/api/admin/change-password',{current:'admin',next:TEST_ADMIN_PASSWORD}));
    const b=await backup(t);
    const dl=await fetch(t.base+'/api/admin/backup/download',{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':t.token,Origin:t.base,Cookie:t.cookie},body:JSON.stringify({name:b.name})});
    assert.equal(dl.status,200);assert.match(dl.headers.get('content-disposition'),/attachment; filename="luminor-pdv_.*\.luminorbackup"/);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(backupFile(t,b.name)));
    assert.equal((await t.post('/api/admin/backup/download',{name:'../data/luminor-pdv.sqlite'})).status,400);
    assert.equal((await t.post('/api/admin/backup/download',{name:'..\\config\\admin.sqlite'})).status,400);
    // The recovery key needs the password again.
    assert.equal((await t.post('/api/admin/backup/recovery-key',{password:'errada-errada-1'})).status,401);
    // Without the page's session token, or from another site, nothing happens even with an administrator session.
    let r=await fetch(t.base+'/api/admin/backup/export',{method:'POST',headers:{'Content-Type':'application/json',Origin:t.base,Cookie:t.cookie},body:'{}'});assert.equal(r.status,403);
    r=await fetch(t.base+'/api/admin/backup/export',{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':t.token,Origin:'http://site-malicioso.example',Cookie:t.cookie},body:'{}'});assert.equal(r.status,403);
    // Uploads above the limit are refused before anything is read.
    t.app.system.backups.restorer.maxBytes=1000;assert.equal((await t.upload(Buffer.alloc(5000,1))).status,413);
    const audit=await adminAudit(t);
    for(const a of ['admin_criado','login','senha_alterada','backup_exportado','backup_baixado'])assert.ok(audit.includes(a),a);
  }finally{await t.stop();}
});

test('D14 backups can also be saved to another folder (a pen drive), and a failed copy only warns',{skip:SKIP},async()=>{
  const t=await boot();const extra=path.join(newHome(),'Pendrive','Backups PDV');try{
    await setupAdmin(t);
    let r=await t.post('/api/admin/backup/settings',{extraFolder:'relativa\\pasta'});assert.equal(r.status,400);
    ok(await t.post('/api/admin/backup/settings',{extraFolder:extra}));
    const b=await backup(t);
    assert.ok(fs.readFileSync(path.join(extra,b.name)).equals(backupFile(t,b.name)));
    // The pen drive was removed: the backup is still made on the computer, with a warning.
    fs.rmSync(path.dirname(extra),{recursive:true,force:true});fs.writeFileSync(path.dirname(extra),'não é uma pasta');
    const b2=await backup(t);assert.ok(backupFile(t,b2.name).length>0);
    assert.ok((await overview(t)).alerts.some(a=>a.level==='aviso'&&/cópia/i.test(a.text)));
  }finally{await t.stop();}
});

test('D16 round trip: back up, restore into another installation and compare every table',{skip:SKIP},async()=>{
  const {validateMigration}=require('../src/database/migration-tools/ValidateMigration');
  const a=await boot(),b=await boot();try{
    await setupAdmin(a);await openShift(a);await sell(a,'10,00','cash');const s=await sell(a,'22,30','credit');
    ok(await a.post('/api/sales/cancel',{id:s.id,reason:'Cliente desistiu'}));ok(await a.post('/api/shift/move',{kind:'withdrawal',amount:'5,00',note:'Troco'}));
    const id=await active(a);ok(await a.post('/api/cart/manual-value',{saleId:id,amount:'3,00'}));
    ok(await a.post('/api/products/save',{name:'Água',price:'4,00',stock:12}));
    const file=backupFile(a,(await backup(a)).name);const key=await recoveryKey(a);
    await setupAdmin(b);const r=await restore(b,file,{key});ok(await r.confirm());
    const report=await validateMigration(a.app.db.adapter,b.app.db.adapter);
    assert.equal(report.ok,true,JSON.stringify(report.tables.filter(x=>!x.ok)));
  }finally{await a.stop();await b.stop();}
});

test('retention keeps the newest backup of each of the last 7 days, 4 weeks and 3 months',()=>{
  const entries=[];for(let i=0;i<120;i++){const day=new Date(Date.UTC(2026,10,6)-i*86400000).toISOString().slice(0,10);entries.push({name:`luminor-pdv_${day}_02-00-00_automatico.luminorbackup`,day});
    if(i<3)entries.push({name:`luminor-pdv_${day}_22-10-00_fechamento.luminorbackup`,day});}
  const keep=[...selectToKeep(entries,{daily:7,weekly:4,monthly:3})].sort();
  const days=keep.map(n=>n.slice(12,22));
  // 7 days (newest file of each), plus the newest of 2 earlier weeks and of 1 earlier month (November and October
  // are already among the 7 days).
  assert.deepEqual(days,['2026-09-30','2026-10-18','2026-10-25','2026-10-31','2026-11-01','2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06']);
  assert.ok(keep.includes('luminor-pdv_2026-11-06_22-10-00_fechamento.luminorbackup'));assert.ok(!keep.includes('luminor-pdv_2026-11-06_02-00-00_automatico.luminorbackup'));
});

test('the daily schedule follows the store clock (São Paulo), whatever the computer time zone',()=>{
  assert.equal(instantOf('2026-11-06','02:00'),Date.parse('2026-11-06T05:00:00Z'));
  assert.equal(lastScheduled(new Date('2026-11-06T04:59:00Z'),'02:00').toISOString(),'2026-11-05T05:00:00.000Z');
  assert.equal(lastScheduled(new Date('2026-11-06T05:00:00Z'),'02:00').toISOString(),'2026-11-06T05:00:00.000Z');
  assert.equal(lastScheduled(new Date('2026-11-06T02:30:00Z'),'23:30').toISOString(),'2026-11-06T02:30:00.000Z');
});

test('the backup file is authenticated: a wrong key and a changed byte are both refused',()=>{
  const key=newKey();const db=Buffer.concat([Buffer.from('SQLite format 3\0','latin1'),Buffer.alloc(3000,7)]);
  const file=encodeBackup({manifest:{createdAt:new Date().toISOString(),database:{bytes:db.length,sha256:sha256(db)}},database:db,key});
  assert.ok(decodeBackup(file,key).database.equals(db));
  assert.throws(()=>decodeBackup(file,newKey()),/não corresponde/);
  for(const i of [30,file.length-60,file.length-1]){const bad=Buffer.from(file);bad[i]^=1;assert.throws(()=>decodeBackup(bad,key),/corrompido|alterado|backup/);}
  assert.equal(keyId(key),decodeBackup(file,key).header.keyId);
  assert.ok(!file.includes(Buffer.from('SQLite format 3')),'conteúdo legível no arquivo');
});

// Products of a backup made before categories existed: they get the category of their name, the channel of the
// "(delivery)" suffix and no favorite, and the rest comes back as it was.
const productsOf=async t=>(await t.app.db.adapter.all('SELECT name,price_cents,stock,category,channel,is_favorite FROM products ORDER BY id')).map(p=>[p.name,p.price_cents,p.stock,p.category,p.channel,p.is_favorite]);
const OLD_PRODUCTS=[['Açaí 500 ml (delivery)','24,00',4],['Coca-Cola 350 ml','7,00',0],['Turbo Fitness - Pré-Treino','22,00',9]];
const RESTORED=[['Açaí 500 ml (delivery)',2400,4,'Açaís','delivery',0],['Coca-Cola 350 ml',700,0,'Bebidas','loja',0],['Turbo Fitness - Pré-Treino',2200,9,'Outros','loja',0]];
test('P15 um backup da versão anterior do banco é restaurado e os produtos ganham categoria, canal e favorito',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);for(const [name,price,stock] of OLD_PRODUCTS)ok(await t.post('/api/products/save',{name,price,stock,favorite:true}));
    const old=await crafted(t,{manifest:{schemaVersion:4},mutate:d=>{for(const c of ['category','channel','is_favorite'])d.exec(`ALTER TABLE products DROP COLUMN ${c}`);d.exec('PRAGMA user_version=4');}});
    ok(await t.post('/api/products/save',{name:'Cadastrado depois do backup',price:'1,00',stock:1}));
    const r=await restore(t,old);assert.equal(r.review.schemaVersion,4);ok(await r.confirm());
    assert.deepEqual(await productsOf(t),RESTORED);assert.equal(await t.app.db.schemaVersion(),SCHEMA_VERSION);
  }finally{await t.stop();}
});

test('P15 um backup antigo feito com a nuvem como banco principal (versão 4, em JSON) também ganha os novos campos',{skip:SKIP},async()=>{
  const {exportLocalData}=require('../src/database/migration-tools/ExportLocalData');
  const t=await boot();try{
    await setupAdmin(t);for(const [name,price,stock] of OLD_PRODUCTS)ok(await t.post('/api/products/save',{name,price,stock,favorite:true}));
    const {manifest}=decodeBackup(backupFile(t,(await backup(t)).name),keyOf(t));
    const data=await exportLocalData(t.app.db.adapter);data.schemaVersion=4;data.tables.products=data.tables.products.map(({category,channel,is_favorite,...p})=>p);
    const db=Buffer.from(JSON.stringify(data));
    const file=encodeBackup({manifest:{...manifest,provider:'postgres',payload:'json',schemaVersion:4,database:{bytes:db.length,sha256:sha256(db)}},database:db,key:keyOf(t)});
    ok(await t.post('/api/products/favorite',{id:1,favorite:false}));
    const r=await restore(t,file);assert.equal(r.review.schemaVersion,4);ok(await r.confirm());
    assert.deepEqual(await productsOf(t),RESTORED);
  }finally{await t.stop();}
});
