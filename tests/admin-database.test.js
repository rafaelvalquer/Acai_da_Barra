'use strict';
// The Admin area's database assistant: connection test, preparation and the cloud copy turned on and off, plus the
// old cloud mode while it waits to move to the local database. The "Supabase" is PGlite (tests/cloud-helpers.js).
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {isEmpty}=require('../src/database/migration-tools/ImportToPostgres');
const {fingerprint}=require('../src/database/DatabaseMigrationService');const {decodeBackup}=require('../src/backup/BackupFormat');
const {isPostgres,until,TEST_DB_PASSWORD}=require('./helpers');
const {boot,newHome,ok,setupAdmin,login,openShift,sell,closeShift,backup,backupFile,keyOf,salesCount,adminAudit}=require('./app-helpers');
const {URL_SUPABASE,confirm,FAST,fakeCloud,connectTest,syncOf,settled,sameAsCloud,oldCloudMode}=require('./cloud-helpers');
const SKIP=isPostgres&&'o assistente usa o próprio PostgreSQL de teste';
const hasOutbox=async t=>!!(await t.app.db.adapter.get("SELECT name FROM sqlite_master WHERE name='sync_outbox'"));

test('the cloud copy is turned on in three steps, the till never stops, and its secrets never show',{skip:SKIP},async()=>{
  const home=newHome();const cloud=await fakeCloud();const t=await boot(home,{connect:cloud.connect,syncTiming:FAST});let t2;try{
    await setupAdmin(t);await openShift(t);await sell(t,'10,00');await sell(t,'5,50','cash');await closeShift(t);
    let info=(await t.get('/api/admin/database')).body;
    assert.equal(info.provider,'sqlite');assert.equal(info.sqlite.active,true);assert.ok(info.sqlite.bytes>0);assert.equal(info.schemaVersion,4);assert.equal(info.pending,null);
    assert.deepEqual([info.sync.enabled,info.sync.state],[false,'desligado']);
    assert.equal(ok(await t.post('/api/admin/database/integrity')).ok,true);
    // Nothing can be turned on before a successful test, nor before the cloud is prepared.
    let r=await t.post('/api/admin/database/sync/enable',confirm);assert.equal(r.status,409);assert.match(r.body.error,/Teste a conexão/);
    const tested=ok(await connectTest(t));
    assert.deepEqual([tested.ok,tested.empty,tested.prepared,tested.target.host],[true,true,false,'aws-0-sa-east-1.pooler.supabase.com']);
    info=(await t.get('/api/admin/database')).body;assert.equal(info.pending.host,'aws-0-sa-east-1.pooler.supabase.com');
    r=await t.post('/api/admin/database/sync/enable',confirm);assert.equal(r.status,409);assert.match(r.body.error,/Prepare o banco/);
    // Preparing and turning on ask for the administrator password again; the shift may stay open.
    assert.equal((await t.post('/api/admin/database/prepare',{password:'errada-errada'})).status,401);
    assert.equal(ok(await t.post('/api/admin/database/prepare',confirm)).prepared,true);
    await openShift(t,'Bia');
    assert.equal((await t.post('/api/admin/database/sync/enable',{password:'errada-errada'})).status,401);
    const on=ok(await t.post('/api/admin/database/sync/enable',confirm));assert.equal(on.enabled,true);
    await settled(t);await sameAsCloud(t,cloud);
    await sell(t,'3,00');await settled(t);await sameAsCloud(t,cloud);
    info=(await t.get('/api/admin/database')).body;
    assert.deepEqual([info.provider,info.sync.state,info.sync.target.host,info.pending],['sqlite','em-dia','aws-0-sa-east-1.pooler.supabase.com',null]);
    assert.ok(info.sync.lastSyncAt);
    // The cloud's address and password stay in the vault: never in the screens, the settings or the logs.
    const screens=JSON.stringify([(await t.get('/api/admin/database')).body,(await t.get('/api/admin/overview')).body,(await t.get('/api/admin/diagnostics')).body,(await t.get('/api/state')).body]);
    assert.equal(screens.includes(TEST_DB_PASSWORD),false);
    for(const f of [t.config.adminDbPath,t.config.vaultFile,path.join(home,'config','luminor-pdv.env'),...fs.readdirSync(t.config.paths.logs).map(f=>path.join(t.config.paths.logs,f))])
      if(fs.existsSync(f))assert.equal(fs.readFileSync(f).includes(Buffer.from(TEST_DB_PASSWORD)),false,f);
    // Backups are still the local database file.
    const b=await backup(t);const {manifest}=decodeBackup(backupFile(t,b.name),keyOf(t));assert.deepEqual([manifest.provider,manifest.payload],['sqlite','sqlite']);
    // "Sincronizar agora" and "Enviar tudo de novo" (this one with the password).
    assert.equal(ok(await t.post('/api/admin/database/sync/now')).state,'em-dia');
    assert.equal((await t.post('/api/admin/database/sync/resend',{password:'errada-errada'})).status,401);
    assert.equal(ok(await t.post('/api/admin/database/sync/resend',confirm)).full,true);await settled(t);await sameAsCloud(t,cloud);
    const audit=await adminAudit(t);for(const x of ['banco_teste','banco_preparado','nuvem_copia_ativada','nuvem_sincronizada','nuvem_reenvio_pedido','nuvem_envio_completo'])assert.ok(audit.includes(x),x);
    await closeShift(t);await settled(t);await t.stop();
    // After a restart the copy goes on.
    t2=await boot(home,{connect:cloud.connect,syncTiming:FAST});assert.equal(t2.app.db.adapter.dialect,'sqlite');assert.equal(syncOf(t2).enabled,true);assert.equal(await salesCount(t2),3);
    await openShift(t2,'Caio');await sell(t2,'1,00');await settled(t2);await sameAsCloud(t2,cloud);
    // Turned off: the change log and the address go away, the cloud keeps what it had and the till keeps selling.
    ok(await login(t2));assert.equal((await t2.post('/api/admin/database/sync/disable',{password:'errada-errada'})).status,401);
    assert.equal(ok(await t2.post('/api/admin/database/sync/disable',confirm)).enabled,false);
    assert.equal(await hasOutbox(t2),false);assert.equal(t2.app.vault.get('databaseUrl'),null);
    await sell(t2,'2,00');assert.equal(await salesCount(t2),5);assert.equal(await cloud.count('sales'),4);
    assert.equal((await t2.get('/api/state')).body.system.sync,null);
    assert.ok((await adminAudit(t2)).includes('nuvem_copia_desativada'));
  }finally{await t.stop();await t2?.stop();}
});

test('the old cloud mode with the cloud down: the Admin area works and the local file can take over',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const home=await oldCloudMode(cloud);cloud.down=true;let t=await boot(home,{connect:cloud.connect,syncTiming:FAST});
  try{
    // Sales answer "unavailable" until the cloud is back (then the move to the local database runs by itself).
    const health=(await t.get('/api/health')).body;assert.deepEqual([health.ok,health.database],[false,'indisponivel']);
    const st=await t.get('/api/state');assert.equal(st.status,503);assert.match(st.body.error,/indisponível/);
    // The Admin sign-in does not depend on the commercial database.
    ok(await login(t));const ov=(await t.get('/api/admin/overview')).body;assert.equal(ov.database.provider,'postgres');assert.equal(ov.database.postgres.connected,false);
    assert.ok((await t.get('/api/admin/diagnostics')).body.database.postgres.lastError.message);
    assert.equal((await t.post('/api/admin/database/convert',confirm)).status,409);
    assert.equal((await t.post('/api/admin/database/use-local',{...confirm,mode:'copiar'})).status,503);
    // In an emergency: the local file as it was (the sale made on the cloud afterwards is not in it).
    const r=ok(await t.post('/api/admin/database/use-local',{...confirm,mode:'manter'}));assert.equal(r.provider,'sqlite');
    assert.equal(await salesCount(t),1);assert.equal((await t.get('/api/health')).body.ok,true);
    await openShift(t,'Caio');await sell(t,'2,00');assert.equal(await salesCount(t),2);await closeShift(t);
  }finally{await t.stop();}
  // The choice is kept: the next start opens the local database even with the cloud reachable again.
  cloud.down=false;t=await boot(home,{connect:cloud.connect,syncTiming:FAST});try{
    assert.equal(await t.app.converting,false);assert.equal(t.app.db.adapter.dialect,'sqlite');assert.equal(await salesCount(t),2);
    // That cloud holds sales this computer does not have: using it for the copy needs the replacement confirmed.
    ok(await login(t));ok(await connectTest(t));
    const e=await t.post('/api/admin/database/sync/enable',confirm);assert.equal(e.status,409);assert.equal(e.body.needsReplace,true);
    assert.equal(await cloud.count('sales'),2);
  }finally{await t.stop();}
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

test('a first send interrupted halfway leaves the cloud empty and the local data untouched, and is completed later',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await boot(undefined,{connect:cloud.connect,syncTiming:FAST});try{
    await setupAdmin(t);await openShift(t);await sell(t,'8,00');await sell(t,'4,00');await closeShift(t);
    ok(await connectTest(t));ok(await t.post('/api/admin/database/prepare',confirm));
    const before=await fingerprint(t.app.db.adapter);
    cloud.failOn=/INSERT INTO sale_items\b/;// the connection drops in the middle of the copy
    ok(await t.post('/api/admin/database/sync/enable',confirm));await until(()=>syncOf(t).state==='sem-conexao');
    assert.equal((await isEmpty(await cloud.adapter())).empty,true);assert.equal(await fingerprint(t.app.db.adapter),before);
    assert.equal((await t.get('/api/health')).body.ok,true);
    await openShift(t,'Bia');await sell(t,'1,00');await closeShift(t);assert.equal(await salesCount(t),3);
    // When the connection is back the send simply runs again.
    cloud.failOn=null;await settled(t);await sameAsCloud(t,cloud);assert.equal(await cloud.count('sales'),3);
  }finally{await t.stop();}
});

test('a cloud database with someone else’s tables is never prepared or written to',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();await cloud.db.exec('CREATE TABLE clientes(id int); INSERT INTO clientes VALUES (1);');
  const t=await boot(undefined,{connect:cloud.connect});try{
    await setupAdmin(t);const tested=ok(await connectTest(t));assert.equal(tested.schema,'outras tabelas');
    let r=await t.post('/api/admin/database/prepare',confirm);assert.equal(r.status,409);assert.match(r.body.error,/outras tabelas/);
    r=await t.post('/api/admin/database/sync/enable',confirm);assert.equal(r.status,409);assert.match(r.body.error,/Prepare o banco/);
    assert.deepEqual((await cloud.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(x=>x.table_name),['clientes']);
  }finally{await t.stop();}
});
