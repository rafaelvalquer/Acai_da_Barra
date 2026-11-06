'use strict';
// Writing exported data into a database (SQLite or PostgreSQL). Values always go in as query parameters, in the
// order of TABLES (every reference points to a table written before it); nothing from the data is run as SQL.
const {TABLES,SCHEMA_VERSION}=require('../schema');const {resetIdentities}=require('../migrations/postgres');
const BATCH=200;
// Rejects anything that is not exactly an export of the PDV's tables (unknown table or column, nested values).
function checkExport(data){
  const bad=msg=>{throw Object.assign(Error(`Exportação inválida: ${msg}`),{code:'estrutura',status:422});};
  if(!data||data.format!=='luminor-pdv-export')bad('formato desconhecido');
  if(data.schemaVersion!==SCHEMA_VERSION)bad(`versão ${data.schemaVersion} (esperada ${SCHEMA_VERSION})`);
  if(!data.tables||typeof data.tables!=='object')bad('sem tabelas');
  const known=new Map(TABLES.map(t=>[t.name,new Set(t.columns)]));
  for(const [name,rows] of Object.entries(data.tables)){
    const cols=known.get(name);if(!cols)bad(`tabela desconhecida ${name}`);if(!Array.isArray(rows))bad(`tabela ${name}`);
    for(const r of rows){if(!r||typeof r!=='object'||Array.isArray(r))bad(`linha em ${name}`);
      for(const [c,v] of Object.entries(r)){if(!cols.has(c))bad(`coluna desconhecida ${name}.${c}`);if(v!==null&&!['string','number','boolean'].includes(typeof v))bad(`valor em ${name}.${c}`);}}
  }
  return data;
}
async function insertRows(q,data){
  for(const t of TABLES){
    const rows=data.tables[t.name]||[];
    for(let i=0;i<rows.length;i+=BATCH){
      const params=[];const values=rows.slice(i,i+BATCH).map(r=>`(${t.columns.map(c=>{params.push(r[c]??null);return '?';}).join(',')})`).join(',');
      await q.run(`INSERT INTO ${t.name}(${t.columns.join(',')}) VALUES ${values}`,params);
    }
  }
}
// Replaces everything in the database with `data`, in one transaction: all of it or nothing.
async function replaceData(adapter,data){
  checkExport(data);
  await adapter.transaction(async q=>{
    for(const t of [...TABLES].reverse())await q.run(`DELETE FROM ${t.name}`);
    await insertRows(q,data);
    if(adapter.dialect==='postgres')await resetIdentities(q,TABLES);
  });
}
module.exports={checkExport,insertRows,replaceData};
