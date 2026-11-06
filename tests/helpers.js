'use strict';
// Stores for the tests, on the database chosen by PDV_TEST_DB: "sqlite" (default, a temporary file) or "pglite"
// (PostgreSQL running inside the test process). `npm run test:postgres` runs the same business tests on PostgreSQL.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {after}=require('node:test');
const {SQLiteAdapter}=require('../src/database/adapters/SQLiteAdapter');const {PostgresAdapter,PARSERS}=require('../src/database/adapters/PostgresAdapter');
const {PdvStore}=require('../src/store');
const PROVIDER=process.env.PDV_TEST_DB||'sqlite';
const isPostgres=PROVIDER==='pglite';
let shared=null;
// Registered when the file loads, so it runs once after all of the file's tests (not after the first one).
if(isPostgres)after(async()=>{if(shared)await shared.close();});
// One PostgreSQL per test file; each store gets an empty schema.
async function pglite(){
  if(!shared){const {PGlite}=require('@electric-sql/pglite');shared=new PGlite({parsers:PARSERS});await shared.waitReady;}
  return shared;
}
async function openOn(handle){
  if(isPostgres){const adapter=await PostgresAdapter.pglite(handle.db);adapter.close=async()=>{};return PdvStore.open(adapter);}
  return PdvStore.open(SQLiteAdapter.open(handle.file));
}
// {s, reopen(), clean()}: s is the store; reopen() closes it and opens the same database again (a restart).
async function tempStore(prefix='luminor-test-'){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));const handle={file:path.join(dir,'pdv.sqlite'),dir};
  if(isPostgres){handle.db=await pglite();await handle.db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');}
  const box={dir,file:handle.file,s:await openOn(handle),
    async reopen(){await box.s.close();box.s=await openOn(handle);return box.s;},
    async clean(){await box.s.close();fs.rmSync(dir,{recursive:true,force:true});}};
  return box;
}
const count=async(s,table)=>(await s.adapter.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;
const sql=(s,query,params=[])=>s.adapter.run(query,params);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=3000){const start=Date.now();while(!(await check())){if(Date.now()-start>ms)throw Error('Tempo esgotado aguardando a condição');await wait(5);}}
// Test-only passwords for the administrator and manager accounts the tests create in throwaway databases, and for the
// fake cloud database (PGlite) of the migration tests.
const TEST_ADMIN_PASSWORD='Acai-Teste-Local-2026',TEST_MANAGER_PASSWORD='Gerente-Teste-Local-2026',TEST_DB_PASSWORD='banco-teste-d557a20f8919';
module.exports={PROVIDER,isPostgres,tempStore,count,sql,wait,until,TEST_ADMIN_PASSWORD,TEST_MANAGER_PASSWORD,TEST_DB_PASSWORD};
