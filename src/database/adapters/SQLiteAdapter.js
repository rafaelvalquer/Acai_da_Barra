'use strict';
// Persistence over SQLite (node:sqlite in the store, sql.js in the online demo). Same contract as PostgresAdapter:
// all/get/run/exec with "?" placeholders, transaction(fn) and close(), every call asynchronous.
const bind=params=>params.map(v=>v===undefined?null:typeof v==='boolean'?(v?1:0):v);

class SQLiteAdapter {
  // db: an open DatabaseSync (or the demo's stand-in). filename is kept for backups and restores.
  constructor(db,{filename=null}={}){
    this.db=db;this.filename=filename;this.dialect='sqlite';this.provider='sqlite';
    this.inTransaction=false;this.onQuery=null;
  }
  // journal: WAL for the live database; DELETE for snapshots and staged copies, so the file is self-contained.
  static open(filename,{readOnly=false,journal='WAL'}={}){
    const fs=require('node:fs'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');
    if(!readOnly)fs.mkdirSync(path.dirname(filename),{recursive:true});
    const db=new DatabaseSync(filename,{readOnly});
    if(!readOnly)db.exec(`PRAGMA journal_mode=${journal==='DELETE'?'DELETE':'WAL'}; PRAGMA synchronous=FULL;`);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
    return new SQLiteAdapter(db,{filename});
  }
  // Test hook: lets a test fail one statement (disk full, locked database) to check that nothing is half written.
  hook(sql){if(this.onQuery)this.onQuery(sql);}
  raw(kind,sql,params,fromTx=false){
    if(this.inTransaction&&!fromTx)throw Error('Consulta fora da transação em andamento');
    this.hook(sql);const st=this.db.prepare(sql);return st[kind](...bind(params));
  }
  async all(sql,params=[]){return this.raw('all',sql,params);}
  async get(sql,params=[]){return this.raw('get',sql,params)||null;}
  async run(sql,params=[]){const r=this.raw('run',sql,params);return {changes:Number(r.changes)};}
  async exec(sql){if(this.inTransaction)throw Error('Consulta fora da transação em andamento');this.hook(sql);this.db.exec(sql);}
  // Everything fn writes is kept, or nothing is. fn receives the executor to use inside the transaction.
  async transaction(fn){
    if(this.inTransaction)throw Error('Transação já em andamento');
    this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;
    const tx={dialect:'sqlite',
      all:async(sql,p=[])=>this.raw('all',sql,p,true),
      get:async(sql,p=[])=>this.raw('get',sql,p,true)||null,
      run:async(sql,p=[])=>({changes:Number(this.raw('run',sql,p,true).changes)}),
      exec:async sql=>{this.hook(sql);this.db.exec(sql);}};
    try{const result=await fn(tx);this.inTransaction=false;this.db.exec('COMMIT');return result;}
    catch(e){this.inTransaction=false;try{this.db.exec('ROLLBACK');}catch(_){}throw e;}
  }
  async schemaVersion(){return this.db.prepare('PRAGMA user_version').get().user_version;}
  async tableNames(){return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name);}
  // Consistent copy of the open database (SQLite online backup API, Node 22.16+), never a raw file copy.
  async backupTo(destination){const {backup}=require('node:sqlite');await backup(this.db,destination);}
  async checkpoint(){try{this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch(_){}}
  async close(){try{this.db.close();}catch(_){}}
}
module.exports={SQLiteAdapter};
