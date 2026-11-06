'use strict';
// The Admin area's database assistant (plan 2.1): connection test, preparation, migration with reconciliation,
// activation, the cloud being down, and going back to the local database. The "Supabase" here is PGlite (PostgreSQL
// inside the test process) behind the same connect() the PDV uses, so no server or internet is needed.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');const {PostgresAdapter,PARSERS}=require('../src/database/adapters/PostgresAdapter');
const {isEmpty}=require('../src/database/migration-tools/ImportToPostgres');const {validateMigration}=require('../src/database/migration-tools/ValidateMigration');
const {fingerprint}=require('../src/database/DatabaseMigrationService');const {decodeBackup}=require('../src/backup/BackupFormat');
const {isPostgres,TEST_DB_PASSWORD}=require('./helpers');
const {boot,newHome,ok,setupAdmin,login,openShift,sell,closeShift,backup,backupFile,keyOf,recoveryKey,restore,salesCount,adminAudit,TEST_ADMIN_PASSWORD}=require('./app-helpers');
const SKIP=isPostgres&&'o assistente usa o próprio PostgreSQL de teste';
const URL_SUPABASE='postgresql://postgres.abcdefghijklmnop@aws-0-sa-east-1.pooler.supabase.com:5432/postgres';
const clouds=[];
test.after(async()=>{for(const c of clouds)await c.db.close();});
// A cloud database the tests can switch off, or make fail in the middle of a statement.
async function fakeCloud(){
  const {PGlite}=require('@electric-sql/pglite');const db=new PGlite({parsers:PARSERS});await db.waitReady;
  const cloud={db,down:false,failOn:null};clouds.push(cloud);
  const open=async()=>{const a=await PostgresAdapter.pglite(db);a.close=async()=>{};return a;};
  cloud.connect=async({connectionString})=>{
    if(cloud.down)throw Object.assign(Error('connect ECONNREFUSED 10.0.0.1:5432'),{code:'ECONNREFUSED'});
    const u=new URL(connectionString);
    if(/inexistente/.test(u.hostname))throw Object.assign(Error(`getaddrinfo ENOTFOUND ${u.hostname}`),{code:'ENOTFOUND'});
    if(decodeURIComponent(u.password)!==TEST_DB_PASSWORD)throw Error(`password authentication failed for user "${decodeURIComponent(u.username)}"`);
    const a=await open();a.onQuery=sql=>{if(cloud.failOn?.test(sql))throw Error('Connection terminated unexpectedly');};return a;
  };
  cloud.adapter=open;
  return cloud;
}
const confirm={password:TEST_ADMIN_PASSWORD};
const connectTest=t=>t.post('/api/admin/database/test',{url:URL_SUPABASE,password:TEST_DB_PASSWORD});
// An installation with two sales, migrated and switched to the cloud.
async function onTheCloud(home,cloud){
  const t=await boot(home,{connect:cloud.connect});
  await setupAdmin(t);await openShift(t);await sell(t,'10,00');await sell(t,'5,50','cash');await closeShift(t);
  ok(await connectTest(t));ok(await t.post('/api/admin/database/prepare',confirm));
  ok(await t.post('/api/admin/database/migrate',confirm));ok(await t.post('/api/admin/database/activate',confirm));
  return t;
}
const localSales=file=>{const d=new DatabaseSync(file,{readOnly:true});try{return d.prepare('SELECT COUNT(*) AS n FROM sales').get().n;}finally{d.close();}};

test('a completed migration is reconciled before activation, and the PDV then sells on the cloud database',{skip:SKIP},async()=>{
  const home=newHome();const cloud=await fakeCloud();const t=await boot(home,{connect:cloud.connect});let t2,c;try{
    await setupAdmin(t);await openShift(t);await sell(t,'10,00');await sell(t,'5,50','cash');await closeShift(t);
    let info=(await t.get('/api/admin/database')).body;
    assert.equal(info.provider,'sqlite');assert.equal(info.sqlite.active,true);assert.ok(info.sqlite.bytes>0);assert.equal(info.schemaVersion,4);assert.equal(info.pending,null);
    const integrity=ok(await t.post('/api/admin/database/integrity'));assert.equal(integrity.ok,true);
    // Nothing can be activated or migrated before a successful test.
    assert.equal((await t.post('/api/admin/database/activate',confirm)).status,409);assert.equal((await t.post('/api/admin/database/migrate',confirm)).status,409);
    const tested=ok(await connectTest(t));
    assert.deepEqual([tested.ok,tested.empty,tested.prepared,tested.target.host],[true,true,false,'aws-0-sa-east-1.pooler.supabase.com']);
    info=(await t.get('/api/admin/database')).body;assert.equal(info.provider,'sqlite');assert.equal(info.pending.host,'aws-0-sa-east-1.pooler.supabase.com');
    // Preparing and migrating ask for the administrator password again.
    assert.equal((await t.post('/api/admin/database/prepare',{password:'errada-errada'})).status,401);
    assert.equal(ok(await t.post('/api/admin/database/prepare',confirm)).prepared,true);
    assert.equal((await t.post('/api/admin/database/activate',confirm)).status,409);
    // Only with the shift closed.
    await openShift(t,'Bia');let r=await t.post('/api/admin/database/migrate',confirm);assert.equal(r.status,409);assert.match(r.body.error,/Feche o caixa/);
    await closeShift(t);
    const m=ok(await t.post('/api/admin/database/migrate',confirm));
    assert.equal(m.ok,true);assert.ok(m.tables.length>=10&&m.tables.every(x=>x.ok));assert.equal(m.tables.find(x=>x.table==='sales').target,2);
    assert.match(m.safetyBackup,/_seguranca\.luminorbackup$/);
    assert.equal(t.app.db.adapter.dialect,'sqlite');
    const a=ok(await t.post('/api/admin/database/activate',confirm));
    assert.equal(a.provider,'postgres');assert.equal(t.app.db.adapter.dialect,'postgres');
    // Sales now go to the cloud; the local file stays as it was at the migration.
    await openShift(t,'Caio');await sell(t,'3,00');await closeShift(t);
    assert.equal(await salesCount(t),3);assert.equal(localSales(t.config.sqlitePath),2);
    // The cloud's address and password stay in the vault: never in the screens, the settings or the logs.
    const screens=JSON.stringify([(await t.get('/api/admin/database')).body,(await t.get('/api/admin/overview')).body,(await t.get('/api/admin/diagnostics')).body,(await t.get('/api/state')).body]);
    assert.equal(screens.includes(TEST_DB_PASSWORD),false);
    for(const f of [t.config.adminDbPath,t.config.vaultFile,path.join(home,'config','luminor-pdv.env'),...fs.readdirSync(t.config.paths.logs).map(f=>path.join(t.config.paths.logs,f))])
      if(fs.existsSync(f))assert.equal(fs.readFileSync(f).includes(Buffer.from(TEST_DB_PASSWORD)),false,f);
    const audit=await adminAudit(t);for(const x of ['banco_teste','banco_preparado','banco_migrado','banco_ativado'])assert.ok(audit.includes(x),x);
    // With the cloud active, backups are an export of the PostgreSQL rows in the same encrypted file.
    const b=await backup(t);const {manifest}=decodeBackup(backupFile(t,b.name),keyOf(t));
    assert.deepEqual([manifest.provider,manifest.payload,manifest.summary.sales.done],['postgres','json',3]);
    const key=await recoveryKey(t);await t.stop();
    // After a restart the cloud database is still the active one.
    t2=await boot(home,{connect:cloud.connect});assert.equal(t2.app.db.adapter.dialect,'postgres');assert.equal(await salesCount(t2),3);
    // Export and import: the cloud backup restored into a new local installation has every record.
    c=await boot();await setupAdmin(c);const rr=await restore(c,backupFile(t2,b.name),{key});ok(await rr.confirm());
    const report=await validateMigration(t2.app.db.adapter,c.app.db.adapter);assert.equal(report.ok,true,JSON.stringify(report.tables.filter(x=>!x.ok)));
    // And back to the local database, copying the cloud data (reconciled the same way).
    ok(await login(t2));const back=ok(await t2.post('/api/admin/database/use-local',{...confirm,mode:'copiar'}));
    assert.equal(back.provider,'sqlite');assert.equal(t2.app.db.adapter.dialect,'sqlite');assert.equal(await salesCount(t2),3);
    assert.ok(fs.readdirSync(t2.config.paths.data).some(f=>f.includes('antes-da-volta')));
  }finally{await t.stop();await t2?.stop();await c?.stop();}
});

test('with the cloud database down the Admin area still works, and the local database can take over',{skip:SKIP},async()=>{
  const home=newHome();const cloud=await fakeCloud();let t=await onTheCloud(home,cloud);
  try{await openShift(t,'Bia');await sell(t,'1,00');await closeShift(t);}finally{await t.stop();}
  cloud.down=true;t=await boot(home,{connect:cloud.connect});try{
    // Sales answer "unavailable"; nothing is lost.
    const health=(await t.get('/api/health')).body;assert.deepEqual([health.ok,health.database],[false,'indisponivel']);
    const st=await t.get('/api/state');assert.equal(st.status,503);assert.match(st.body.error,/indisponível/);
    // The Admin sign-in does not depend on the commercial database.
    ok(await login(t));const ov=(await t.get('/api/admin/overview')).body;assert.equal(ov.database.provider,'postgres');assert.equal(ov.database.postgres.connected,false);
    assert.ok((await t.get('/api/admin/diagnostics')).body.database.postgres.lastError.message);
    assert.equal((await t.post('/api/admin/database/use-local',{...confirm,mode:'copiar'})).status,503);
    // Back to the local file as it was at the migration (the cloud sale made afterwards is not in it).
    const r=ok(await t.post('/api/admin/database/use-local',{...confirm,mode:'manter'}));assert.equal(r.provider,'sqlite');
    assert.equal(await salesCount(t),2);assert.equal((await t.get('/api/health')).body.ok,true);
    await openShift(t,'Caio');await sell(t,'2,00');assert.equal(await salesCount(t),3);await closeShift(t);
  }finally{await t.stop();}
  // The choice is kept: the next start opens the local database even with the cloud reachable again.
  cloud.down=false;t=await boot(home,{connect:cloud.connect});try{assert.equal(t.app.db.adapter.dialect,'sqlite');assert.equal(await salesCount(t),3);}finally{await t.stop();}
});

test('an invalid connection test leaves the local database untouched',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await boot(undefined,{connect:cloud.connect});try{
    await setupAdmin(t);await openShift(t);await sell(t);
    const before=await fingerprint(t.app.db.adapter);
    const tries=[[{url:'mysql://x@y/z',password:'x'},400,/postgresql:\/\//],[{url:'não é endereço'},400,/inválido/],
      [{url:'postgresql://postgres@db.exemplo.com/postgres'},400,/senha/],[{url:URL_SUPABASE,password:'senha-errada-do-banco'},502,/senha do banco incorretos/],
      [{url:'postgresql://postgres@inexistente.supabase.com:5432/postgres',password:TEST_DB_PASSWORD},502,/Servidor não encontrado/],
      [{url:URL_SUPABASE,password:TEST_DB_PASSWORD,ca:'isto não é um certificado'},400,/PEM/]];
    for(const [body,status,msg] of tries){const r=await t.post('/api/admin/database/test',body);assert.equal(r.status,status,JSON.stringify(r.body));assert.match(r.body.error,msg);}
    assert.equal(t.app.db.adapter.dialect,'sqlite');assert.equal(await fingerprint(t.app.db.adapter),before);
    assert.equal(t.app.vault.get('pendingDatabaseUrl')??null,null);assert.equal(t.app.vault.get('databaseUrl')??null,null);
    assert.equal((await t.post('/api/admin/database/prepare',confirm)).status,409);
    await sell(t);assert.equal(await salesCount(t),2);
    assert.ok((await t.app.adminStore.recentAudit(20)).some(a=>a.action==='banco_teste'&&!a.ok));
  }finally{await t.stop();}
});

test('a migration interrupted halfway leaves SQLite intact and active, and the cloud empty',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await boot(undefined,{connect:cloud.connect});try{
    await setupAdmin(t);await openShift(t);await sell(t,'8,00');await sell(t,'4,00');await closeShift(t);
    ok(await connectTest(t));ok(await t.post('/api/admin/database/prepare',confirm));
    const before=await fingerprint(t.app.db.adapter);
    cloud.failOn=/INSERT INTO sale_items\b/;// the connection drops in the middle of the copy
    const r=await t.post('/api/admin/database/migrate',confirm);
    assert.equal(r.status,500);assert.match(r.body.error,/Migração não concluída; o banco local continua ativo/);
    assert.equal(t.app.db.adapter.dialect,'sqlite');assert.equal(await fingerprint(t.app.db.adapter),before);
    assert.equal((await isEmpty(await cloud.adapter())).empty,true);
    assert.equal((await t.get('/api/health')).body.ok,true);
    assert.equal((await t.post('/api/admin/database/activate',confirm)).status,409);
    await openShift(t,'Bia');await sell(t,'1,00');await closeShift(t);assert.equal(await salesCount(t),3);
    // When the connection is back the migration simply runs again.
    cloud.failOn=null;const m=ok(await t.post('/api/admin/database/migrate',confirm));assert.equal(m.ok,true);
    ok(await t.post('/api/admin/database/activate',confirm));assert.equal(await salesCount(t),3);
  }finally{await t.stop();}
});

test('a change in the local data after the migration blocks the activation',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await boot(undefined,{connect:cloud.connect});try{
    await setupAdmin(t);await openShift(t);await sell(t);await closeShift(t);
    ok(await connectTest(t));ok(await t.post('/api/admin/database/prepare',confirm));ok(await t.post('/api/admin/database/migrate',confirm));
    await openShift(t,'Bia');await sell(t,'2,00');await closeShift(t);
    const r=await t.post('/api/admin/database/activate',confirm);assert.equal(r.status,409);assert.match(r.body.error,/depois da migração/);
    assert.equal(t.app.db.adapter.dialect,'sqlite');assert.equal(await salesCount(t),2);
  }finally{await t.stop();}
});

test('a cloud database with someone else’s tables is never prepared or written to',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();await cloud.db.exec('CREATE TABLE clientes(id int); INSERT INTO clientes VALUES (1);');
  const t=await boot(undefined,{connect:cloud.connect});try{
    await setupAdmin(t);const tested=ok(await connectTest(t));assert.equal(tested.schema,'outras tabelas');
    let r=await t.post('/api/admin/database/prepare',confirm);assert.equal(r.status,409);assert.match(r.body.error,/outras tabelas/);
    r=await t.post('/api/admin/database/migrate',confirm);assert.equal(r.status,409);assert.match(r.body.error,/Prepare o banco/);
    assert.deepEqual((await cloud.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(x=>x.table_name),['clientes']);
  }finally{await t.stop();}
});
