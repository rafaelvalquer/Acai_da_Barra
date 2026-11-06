'use strict';
// Checks a backup file before anything is restored, in this order: file format, key, integrity (AES-GCM and
// SHA-256), version, and database structure. The database inside is written to a staging folder and inspected
// there; it is accepted only if it holds exactly the PDV's tables, with no triggers, views or other objects that
// could run SQL, passes SQLite's integrity and foreign-key checks, and can be brought to the current schema.
// Nothing from the file is ever executed: only the PDV's own migrations and queries run on the copy.
const fs=require('node:fs'),path=require('node:path');
const {SQLiteAdapter}=require('../database/adapters/SQLiteAdapter');const {migrateSqlite}=require('../database/migrations/sqlite');
const {SCHEMA_VERSION,TABLE_NAMES}=require('../database/schema');const {summarize}=require('../database/summary');
const {readHeader,decodeBackup,parseKey,keyId,BackupError}=require('./BackupFormat');const {replaceData}=require('../database/migration-tools/copyData');const {integrityOk}=require('./BackupManager');
const SQLITE_MAGIC=Buffer.from('SQLite format 3\0','latin1');
const INTERNAL=new Set(['sqlite_sequence','sqlite_stat1','sqlite_stat4']);
let reference=null;
// Columns of every table at the current schema, from an empty database built by the migrations.
async function referenceColumns(){
  if(reference)return reference;
  const {DatabaseSync}=require('node:sqlite');const a=new SQLiteAdapter(new DatabaseSync(':memory:'));
  try{await migrateSqlite(a);reference=await columnsOf(a);}finally{await a.close();}
  return reference;
}
async function columnsOf(a){
  const out={};for(const t of TABLE_NAMES){const cols=await a.all(`SELECT name,hidden FROM pragma_table_xinfo('${t}')`);if(cols.length)out[t]=cols;}
  return out;
}
const fail=(message,code='estrutura')=>{throw new BackupError(code,message);};
async function checkStructure(a,expectedVersion){
  const objects=await a.all('SELECT type,name,tbl_name,sql FROM sqlite_master');
  for(const o of objects){
    if(o.type==='trigger'||o.type==='view')fail(`O backup contém um objeto não permitido (${o.type} ${o.name}). Por segurança ele não será restaurado.`);
    if(o.type==='table'&&/^\s*CREATE\s+VIRTUAL/i.test(o.sql||''))fail(`O backup contém uma tabela não permitida (${o.name}).`);
    if(o.type==='table'&&!TABLE_NAMES.includes(o.name)&&!INTERNAL.has(o.name))fail(`O backup contém uma tabela desconhecida (${o.name}).`);
    if(o.type==='index'&&!TABLE_NAMES.includes(o.tbl_name))fail(`O backup contém um índice desconhecido (${o.name}).`);
  }
  const version=await a.schemaVersion();
  if(version!==expectedVersion)fail('A versão do banco no backup não confere com o manifesto.','incompativel');
  if(!(await integrityOk(a)))fail('O banco dentro do backup não passou na verificação de integridade.','corrompido');
  const fk=await a.all('PRAGMA foreign_key_check');if(fk.length)fail('O banco dentro do backup tem referências quebradas entre tabelas.','corrompido');
}
async function checkColumns(a){
  const expected=await referenceColumns();const actual=await columnsOf(a);
  for(const [t,cols] of Object.entries(expected)){
    if(!actual[t])fail(`O backup não tem a tabela ${t}.`,'incompativel');
    if(actual[t].some(c=>c.hidden))fail(`O backup tem colunas calculadas não permitidas em ${t}.`);
    const want=cols.map(c=>c.name).sort().join(','),got=actual[t].map(c=>c.name).sort().join(',');
    if(want!==got)fail(`A estrutura da tabela ${t} no backup é diferente da esperada.`,'incompativel');
  }
}
class BackupValidator {
  constructor({keys,maxBytes=512*1024*1024}){this.keys=keys;this.maxBytes=maxBytes;}
  // Step 1, needs no key: is this a PDV backup, and is the key it needs the one on this computer?
  inspect(buffer){
    if(buffer.length>this.maxBytes)throw new BackupError('tamanho','Arquivo grande demais para um backup do PDV.',413);
    const {header}=readHeader(buffer);
    return {createdAt:header.createdAt,formatVersion:header.formatVersion,needsRecoveryKey:header.keyId!==this.keys.id()};
  }
  // Step 2: opens it and stages the database in `stageDir`. Returns what the person reviews before confirming.
  async validate(buffer,{stageDir,recoveryKey=null}){
    const head=this.inspect(buffer);let key,keySource;
    if(!head.needsRecoveryKey){key=this.keys.key();keySource='local';}
    else{
      if(!recoveryKey)throw Object.assign(new BackupError('chave','Este backup foi feito com outra chave. Digite a chave de recuperação anotada pelo administrador.'),{needsRecoveryKey:true});
      key=parseKey(recoveryKey);keySource='recuperacao';
    }
    const {manifest,database}=decodeBackup(buffer,key);
    // sqlite: the database file; json: an export of every row (backups made while the cloud database was active).
    const payload=manifest.payload||'sqlite';
    if(!((manifest.provider==='sqlite'&&payload==='sqlite')||(manifest.provider==='postgres'&&payload==='json')))fail('Tipo de backup desconhecido.','incompativel');
    const version=manifest.schemaVersion;
    if(!Number.isInteger(version)||version<1)fail('Versão do banco desconhecida no backup.','incompativel');
    if(version>SCHEMA_VERSION)fail(`Este backup foi criado por uma versão mais nova do PDV (banco versão ${version}). Atualize o programa antes de restaurar.`,'incompativel');
    fs.mkdirSync(stageDir,{recursive:true});const staged=path.join(stageDir,'restaurar.sqlite');
    if(payload==='sqlite'){
      if(!database.subarray(0,16).equals(SQLITE_MAGIC))fail('O conteúdo do backup não é um banco SQLite.','corrompido');
      fs.writeFileSync(staged,database);
    }else{
      // The rows are written into a new local database by the PDV's own code, then checked like any other.
      let data;try{data=JSON.parse(database.toString('utf8'));}catch(_){fail('O conteúdo do backup está corrompido.','corrompido');}
      if(data.schemaVersion!==SCHEMA_VERSION)fail(`Este backup é de outra versão do banco (versão ${data.schemaVersion}).`,'incompativel');
      const b=SQLiteAdapter.open(staged,{journal:'DELETE'});
      try{await migrateSqlite(b);await replaceData(b,{format:'luminor-pdv-export',...data});}catch(e){fail(e.message,e.code||'estrutura');}finally{await b.close();}
    }
    const a=SQLiteAdapter.open(staged,{journal:'DELETE'});let summary;
    try{
      await checkStructure(a,version);
      const before=await summarize(a);
      for(const [t,n] of Object.entries(manifest.summary?.counts||{}))
        if(before.counts[t]!==n)fail(`A contagem de registros de ${t} não confere com o manifesto do backup.`,'corrompido');
      // Older backups are brought to the current schema here, on the copy, before anything is replaced.
      await migrateSqlite(a);await checkColumns(a);
      if(!(await integrityOk(a)))fail('O banco do backup não passou na verificação depois de atualizado.','corrompido');
      summary=await summarize(a);
    }finally{await a.close();}
    return {staged,keySource,keyIdOfBackup:keyId(key),
      review:{createdAt:manifest.createdAt,kind:manifest.kind,provider:manifest.provider,appVersion:manifest.app?.version||null,schemaVersion:version,currentSchemaVersion:SCHEMA_VERSION,
        bytes:buffer.length,summary,hardware:manifest.hardware||{},keySource}};
  }
}
module.exports={BackupValidator,referenceColumns};
