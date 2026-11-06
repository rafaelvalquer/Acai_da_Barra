'use strict';
// Step 2: writes an export into an empty PostgreSQL database, in one transaction: all rows or none. Ids are kept
// (sales keep their numbers), and the identity sequences continue after the highest id.
const {TABLES}=require('../schema');const {migratePostgres,resetIdentities}=require('../migrations/postgres');
const {checkExport,insertRows}=require('./copyData');
async function isEmpty(pg){
  for(const t of TABLES){const r=await pg.get(`SELECT COUNT(*) AS n FROM ${t.name}`);if(r.n>0)return {empty:false,table:t.name};}
  return {empty:true};
}
async function importToPostgres(pg,data,{onProgress=()=>{}}={}){
  if(pg.dialect!=='postgres')throw Error('O destino da importação precisa ser PostgreSQL.');
  checkExport(data);
  await migratePostgres(pg);
  const e=await isEmpty(pg);if(!e.empty)throw Object.assign(Error(`O banco na nuvem já tem dados (tabela ${e.table}). A migração só é feita para um banco vazio.`),{status:409});
  await pg.transaction(async q=>{await insertRows(q,data);await resetIdentities(q,TABLES);});
  for(const t of TABLES)onProgress({table:t.name,rows:(data.tables[t.name]||[]).length});
  return {tables:Object.fromEntries(TABLES.map(t=>[t.name,(data.tables[t.name]||[]).length]))};
}
module.exports={importToPostgres,isEmpty};
