'use strict';
// The "Supabase" of the tests: PGlite (PostgreSQL inside the test process) behind the same connect() the PDV uses,
// so no server or internet is needed. It can be switched off (down), left without answers (hang) or made to fail in
// the middle of a statement (failOn). Also builds an installation of the old cloud mode, where the till sold
// straight on the cloud database, to check its move to the local database.
const assert=require('node:assert/strict');const test=require('node:test');const {randomUUID}=require('node:crypto');
const {PostgresAdapter,PARSERS}=require('../src/database/adapters/PostgresAdapter');const {PdvStore}=require('../src/store');
const {validateMigration}=require('../src/database/migration-tools/ValidateMigration');const {exportLocalData}=require('../src/database/migration-tools/ExportLocalData');
const {importToPostgres}=require('../src/database/migration-tools/ImportToPostgres');const {buildUrl}=require('../src/database/DatabaseMigrationService');
const {describeUrl}=require('../src/database/DatabaseManager');
const {until,wait,TEST_DB_PASSWORD}=require('./helpers');
const {boot,newHome,ok,setupAdmin,openShift,sell,closeShift,TEST_ADMIN_PASSWORD}=require('./app-helpers');
const URL_SUPABASE='postgresql://postgres.abcdefghijklmnop@aws-0-sa-east-1.pooler.supabase.com:5432/postgres';
const confirm={password:TEST_ADMIN_PASSWORD};
// Short waits, so a test sees in milliseconds what takes seconds in the store.
const FAST={tick:20,backoff:[40],firstCheck:60*60*1000,check:60*60*1000,saveEvery:0};
const clouds=[];
test.after(async()=>{for(const c of clouds)await c.db.close();});
async function fakeCloud(){
  const {PGlite}=require('@electric-sql/pglite');const db=new PGlite({parsers:PARSERS});await db.waitReady;
  const cloud={db,down:false,hang:0,failOn:null,connections:0};clouds.push(cloud);
  const open=async()=>{const a=await PostgresAdapter.pglite(db);a.close=async()=>{};return a;};
  // hang: every query waits that many milliseconds and then fails, as pg's query_timeout does with no answer.
  const slow=fn=>async(...args)=>{if(cloud.hang){await wait(cloud.hang);throw Error('Query read timeout');}return fn(...args);};
  cloud.connect=async({connectionString})=>{
    if(cloud.down)throw Object.assign(Error('connect ECONNREFUSED 10.0.0.1:5432'),{code:'ECONNREFUSED'});
    const u=new URL(connectionString);
    if(/inexistente/.test(u.hostname))throw Object.assign(Error(`getaddrinfo ENOTFOUND ${u.hostname}`),{code:'ENOTFOUND'});
    if(decodeURIComponent(u.password)!==TEST_DB_PASSWORD)throw Error(`password authentication failed for user "${decodeURIComponent(u.username)}"`);
    const a=await open();cloud.connections++;
    a.onQuery=sql=>{if(cloud.down)throw Error('Connection terminated unexpectedly');if(cloud.failOn?.test(sql))throw Error('Connection terminated unexpectedly');};
    for(const k of ['query','exec','transaction'])a.driver[k]=slow(a.driver[k]);
    return a;
  };
  cloud.adapter=open;
  cloud.count=async table=>Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  return cloud;
}
const connectTest=t=>t.post('/api/admin/database/test',{url:URL_SUPABASE,password:TEST_DB_PASSWORD});
const syncOf=t=>t.app.system.sync.status();
const outbox=async t=>Number((await t.app.db.adapter.get('SELECT COUNT(*) AS n FROM sync_outbox'))?.n??0);
// Everything written here has reached the cloud.
async function settled(t,ms=8000){
  await until(async()=>{const s=syncOf(t);return s.enabled&&s.state==='em-dia'&&!s.full&&(await outbox(t))===0;},ms);
}
// The cloud holds exactly the local data: every row of every table and the business totals.
async function sameAsCloud(t,cloud){
  const r=await validateMigration(t.app.db.adapter,await cloud.adapter());
  assert.equal(r.ok,true,JSON.stringify([...r.tables.filter(x=>!x.ok),...r.totals.filter(x=>!x.ok)]));
}
// An installation with the cloud copy on and already in step.
async function withCopy(cloud,{home=newHome(),timing=FAST}={}){
  const t=await boot(home,{connect:cloud.connect,syncTiming:timing});await setupAdmin(t);
  ok(await connectTest(t));ok(await t.post('/api/admin/database/prepare',confirm));ok(await t.post('/api/admin/database/sync/enable',confirm));
  await settled(t);return t;
}
// What the old "Migrar" and "Ativar" left behind: the local rows copied into the cloud, the cloud saved as the
// database to sell on, and later sales made only there (here, one sale in a shift still open).
async function oldCloudMode(cloud){
  const home=newHome();const t=await boot(home,{connect:cloud.connect});
  try{
    await setupAdmin(t);await openShift(t);await sell(t,'10,00');await closeShift(t);
    await importToPostgres(await cloud.adapter(),await exportLocalData(t.app.db.adapter));
    const url=buildUrl({url:URL_SUPABASE,password:TEST_DB_PASSWORD});
    await t.app.vault.update({databaseUrl:url});
    await t.app.system.settings.saveDatabase({provider:'postgres',postgres:describeUrl(url),activatedAt:new Date().toISOString()});
  }finally{await t.stop();}
  const s=await PdvStore.open(await cloud.adapter());
  const op=(await s.saveEmployee({name:'Bia'})).id;await s.openShift('20,00',op);
  const id=await s.activeSaleId();await s.addManualValue(id,'7,00');
  await s.checkoutDraftSale(id,'pix',randomUUID(),null,(await s.getDraftSale(id)).revision);
  return home;
}
module.exports={URL_SUPABASE,confirm,FAST,fakeCloud,connectTest,syncOf,outbox,settled,sameAsCloud,withCopy,oldCloudMode};
