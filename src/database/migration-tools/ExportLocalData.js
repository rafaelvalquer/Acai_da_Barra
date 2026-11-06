'use strict';
// Step 1 of the move to PostgreSQL (Supabase): every row of every PDV table, read through the adapter, plus the
// schema version and the business summary used later to reconcile. Works on any adapter, so the same export
// compares a database before and after a copy.
const fs=require('node:fs'),path=require('node:path');
const {TABLES,SCHEMA_VERSION}=require('../schema');const {summarize}=require('../summary');
const {SQLiteAdapter}=require('../adapters/SQLiteAdapter');const {migrateSqlite}=require('../migrations/sqlite');
const isTime=c=>c.endsWith('_at');
// One value in the same form whichever database it came from: timestamps as ISO UTC, numbers as numbers.
function canonical(column,v){
  if(v===null||v===undefined)return null;
  if(isTime(column)){const t=Date.parse(v);return Number.isNaN(t)?String(v):new Date(t).toISOString();}
  if(typeof v==='bigint')return Number(v);
  return v;
}
const compareKeys=(a,b)=>typeof a==='number'&&typeof b==='number'?a-b:String(a)<String(b)?-1:String(a)>String(b)?1:0;
async function readTable(q,table){
  const rows=await q.all(`SELECT ${table.columns.join(',')} FROM ${table.name}`);
  return rows.map(r=>Object.fromEntries(table.columns.map(c=>[c,canonical(c,r[c])]))).sort((a,b)=>compareKeys(a[table.key],b[table.key]));
}
async function exportLocalData(q){
  const version=await q.schemaVersion();
  if(version!==SCHEMA_VERSION)throw Error(`O banco está na versão ${version}; a exportação precisa da versão ${SCHEMA_VERSION}. Abra o PDV atualizado uma vez antes de migrar.`);
  const tables={};for(const t of TABLES)tables[t.name]=await readTable(q,t);
  return {format:'luminor-pdv-export',formatVersion:1,exportedAt:new Date().toISOString(),schemaVersion:version,provider:q.provider||q.dialect,tables,summary:await summarize(q)};
}
// Opens a copy of a SQLite file (the original is only read), brought to the current schema.
async function openSqliteCopy(source,tmpDir){
  if(!fs.existsSync(source))throw Error(`Banco não encontrado: ${source}`);
  fs.mkdirSync(tmpDir,{recursive:true});const dir=fs.mkdtempSync(path.join(tmpDir,'migracao-'));const copy=path.join(dir,'origem.sqlite');
  fs.copyFileSync(source,copy);if(fs.existsSync(source+'-wal'))fs.copyFileSync(source+'-wal',copy+'-wal');
  const adapter=SQLiteAdapter.open(copy,{journal:'DELETE'});await migrateSqlite(adapter);
  const close=adapter.close.bind(adapter);adapter.close=async()=>{await close();fs.rmSync(dir,{recursive:true,force:true});};
  return adapter;
}
module.exports={exportLocalData,readTable,canonical,openSqliteCopy};
