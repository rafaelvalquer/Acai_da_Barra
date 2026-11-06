'use strict';
// Makes backups: a consistent snapshot of the open database, taken with sales paused for the moment it needs (SQLite:
// online backup API; PostgreSQL/Supabase: an export of every row), checked, packed with its manifest into an encrypted .luminorbackup,
// written to a .partial file, read back and opened again, and only then renamed to its final name. A power cut or
// a full disk leaves at most a .partial file, which is never listed and is removed at the next start.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {SQLiteAdapter}=require('../database/adapters/SQLiteAdapter');const {summarize}=require('../database/summary');
const {exportLocalData}=require('../database/migration-tools/ExportLocalData');
const {Mutex}=require('../database/Mutex');const ChangeLog=require('../sync/ChangeLog');
const {encodeBackup,decodeBackup,BackupError,sha256,EXTENSION}=require('./BackupFormat');
const {stamp}=require('./clock');const {selectToKeep}=require('./retention');
// Kind of backup → folder under backups/.
const FOLDERS={automatico:'automaticos',fechamento:'automaticos',manual:'manuais',seguranca:'seguranca',atualizacao:'seguranca'};
const LABELS={automatico:'Automático',fechamento:'Fechamento de caixa',manual:'Manual',seguranca:'Segurança (antes de restaurar)',atualizacao:'Antes de atualizar'};
const KEEP={manuais:20,seguranca:10};
const NAME=/^luminor-pdv_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_([a-z]+)(?:-\d+)?\.luminorbackup$/;
function friendly(e){
  if(e instanceof BackupError)return e.message;
  if(e.code==='ENOSPC')return 'Disco cheio: não há espaço para gravar o backup. Libere espaço no computador.';
  if(e.code==='EACCES'||e.code==='EPERM')return 'Sem permissão para gravar na pasta de backups.';
  return e.message||String(e);
}
async function integrityOk(adapter){const r=await adapter.get('PRAGMA integrity_check');return Object.values(r||{})[0]==='ok';}
class BackupManager {
  constructor({config,store,keys,status,hardware=null,log=console,clock=()=>new Date(),hooks={}}){
    Object.assign(this,{config,store,keys,status,hardware,log,clock,hooks});this.lock=new Mutex();
    // Set by BackupService from the Admin settings.
    this.extraFolder=()=>'';this.retention=()=>config.backup.retention;
  }
  dir(kind){return path.join(this.config.paths.backups,FOLDERS[kind]);}
  get supported(){return !this.store.adapter.unavailable;}
  // SQLite: the database file itself (online backup API), checked for integrity.
  async snapshotSqlite(stage){
    const snap=path.join(stage,'snapshot.sqlite');
    // Sales wait only for the copy itself; checking, encrypting and writing happen after they resume.
    await this.store.exclusive(()=>this.store.adapter.backupTo(snap));
    const copy=SQLiteAdapter.open(snap,{journal:'DELETE'});
    try{
      // The cloud copy's change log stays out of backups: they keep exactly the PDV's tables (a restore then sends
      // everything to the cloud again).
      if(await ChangeLog.isInstalled(copy)){await ChangeLog.remove(copy);await copy.exec('VACUUM');}
      if(!(await integrityOk(copy)))throw new BackupError('corrompido','A cópia do banco não passou na verificação de integridade. O backup não foi gravado.');
      return {payload:'sqlite',schemaVersion:await copy.schemaVersion(),summary:await summarize(copy),data:null,file:snap};
    }finally{await copy.close();}
  }
  // PostgreSQL: every row of every table, read with sales paused so the export is one consistent moment.
  async snapshotPostgres(){
    const {exportedAt,summary,...data}=await this.store.exclusive(()=>exportLocalData(this.store.adapter));
    return {payload:'json',schemaVersion:data.schemaVersion,summary,data:Buffer.from(JSON.stringify(data),'utf8')};
  }
  // kind: automatico | fechamento | manual | seguranca | atualizacao. skipIfUnchanged: no new file when the data is
  // the same as in the last backup of the past day (used after closing the shift).
  create({kind='manual',actor=null,skipIfUnchanged=false}={}){
    if(!FOLDERS[kind])throw Error('Tipo de backup inválido');
    return this.lock.run(()=>this.make({kind,actor,skipIfUnchanged}));
  }
  async make({kind,actor,skipIfUnchanged}){
    const at=this.clock();let stage=null,partial=null;
    try{
      if(!this.supported)throw new BackupError('provider','O banco de dados está indisponível no momento. Tente de novo quando a conexão voltar.',503);
      fs.mkdirSync(this.config.paths.tmp,{recursive:true});stage=fs.mkdtempSync(path.join(this.config.paths.tmp,'backup-'));
      const provider=this.store.adapter.dialect;
      const snap=provider==='sqlite'?await this.snapshotSqlite(stage):await this.snapshotPostgres();
      const {schemaVersion,summary}=snap;
      const database=snap.data||await fsp.readFile(snap.file);const databaseSha256=sha256(database);
      const last=this.status.lastSuccess;
      if(skipIfUnchanged&&last?.databaseSha256===databaseSha256&&at-Date.parse(last.at)<86400000){
        this.status.skipped(kind,'sem alterações desde o último backup',at.toISOString());return {skipped:true,last};
      }
      const manifest={createdAt:at.toISOString(),kind,app:{name:'Luminor PDV',version:this.config.version},provider,payload:snap.payload,schemaVersion,summary,
        hardware:this.hardware?.read()||{},database:{bytes:database.length,sha256:databaseSha256}};
      const bytes=encodeBackup({manifest,database,key:this.keys.key()});
      const dir=this.dir(kind);fs.mkdirSync(dir,{recursive:true});
      let name=`luminor-pdv_${stamp(at)}_${kind}${EXTENSION}`;for(let i=2;fs.existsSync(path.join(dir,name));i++)name=`luminor-pdv_${stamp(at)}_${kind}-${i}${EXTENSION}`;
      const final=path.join(dir,name);partial=final+'.partial';
      await this.hooks.beforeWrite?.({kind,partial});
      const fh=await fsp.open(partial,'wx');
      try{await fh.writeFile(bytes);await this.hooks.afterWrite?.({kind,partial});await fh.sync();}finally{await fh.close();}
      // Read back from disk and open it, as a restore would.
      const back=decodeBackup(await fsp.readFile(partial),this.keys.key());
      if(back.manifest.database.sha256!==databaseSha256)throw new BackupError('corrompido','O backup gravado não confere com a cópia do banco.');
      await fsp.rename(partial,final);partial=null;
      const entry={at:manifest.createdAt,kind,name,file:final,bytes:bytes.length,databaseSha256,schemaVersion,actor:actor?{name:actor.username??actor.name}:null};
      this.status.success(entry);
      if(['automatico','fechamento','manual'].includes(kind))await this.copyToExtra(final,name);
      await this.prune(kind).catch(e=>this.log.warn?.(`Limpeza de backups antigos falhou: ${e.message}`));
      return {...entry,summary};
    }catch(e){
      if(partial)await fsp.rm(partial,{force:true}).catch(()=>{});
      const message=friendly(e);this.status.failure(kind,message,at.toISOString());
      this.log.error?.(`Backup ${kind} falhou: ${message}`);
      if(!e.status)e.status=e instanceof BackupError?e.status:500;e.message=message;throw e;
    }finally{if(stage)await fsp.rm(stage,{recursive:true,force:true}).catch(()=>{});}
  }
  // A second copy in the folder chosen in the Admin area (a pen drive, another disk). A failure there never undoes
  // the backup itself; it shows up as an alert.
  async copyToExtra(file,name){
    const dir=this.extraFolder();if(!dir)return;
    try{await fsp.mkdir(dir,{recursive:true});await fsp.copyFile(file,path.join(dir,name+'.partial'));await fsp.rename(path.join(dir,name+'.partial'),path.join(dir,name));this.status.copied({at:new Date().toISOString(),folder:dir,name});}
    catch(e){await fsp.rm(path.join(dir,name+'.partial'),{force:true}).catch(()=>{});this.status.copyFailed({at:new Date().toISOString(),folder:dir,error:friendly(e)});this.log.warn?.(`Cópia do backup para ${dir} falhou: ${friendly(e)}`);}
  }
  entries(folder){
    const dir=path.join(this.config.paths.backups,folder);let names=[];try{names=fs.readdirSync(dir);}catch(_){return [];}
    return names.map(name=>{const m=NAME.exec(name);if(!m)return null;let st;try{st=fs.statSync(path.join(dir,name));}catch(_){return null;}
      return {name,folder,kind:m[3],kindLabel:LABELS[m[3]]||m[3],day:m[1],time:m[2].replace(/-/g,':'),bytes:st.size,file:path.join(dir,name)};}).filter(Boolean)
      .sort((a,b)=>b.name.localeCompare(a.name));
  }
  // Every backup file in the backups folder, newest first.
  list(){return ['automaticos','manuais','seguranca'].flatMap(f=>this.entries(f)).sort((a,b)=>`${b.day}${b.time}`.localeCompare(`${a.day}${a.time}`));}
  find(name){
    if(!NAME.test(String(name||'')))throw new BackupError('formato','Nome de backup inválido',400);
    const hit=this.list().find(e=>e.name===name);if(!hit)throw new BackupError('formato','Backup não encontrado',404);return hit;
  }
  // Retention: automatic and closing backups by day, week and month; the others by count.
  async prune(kind){
    const folder=FOLDERS[kind];const list=this.entries(folder);
    const keep=folder==='automaticos'?selectToKeep(list,this.retention()):new Set(list.slice(0,KEEP[folder]).map(e=>e.name));
    for(const e of list)if(!keep.has(e.name)){await fsp.rm(e.file,{force:true});this.log.info?.(`Backup antigo removido: ${e.name}`);}
  }
  // At start: half-written backups and staging folders left by a power cut are removed.
  cleanup(){
    let removed=0;
    for(const folder of new Set(Object.values(FOLDERS))){
      const dir=path.join(this.config.paths.backups,folder);let names=[];try{names=fs.readdirSync(dir);}catch(_){continue;}
      for(const n of names)if(n.endsWith('.partial')){fs.rmSync(path.join(dir,n),{force:true});removed++;}
    }
    let staged=[];try{staged=fs.readdirSync(this.config.paths.tmp);}catch(_){}
    for(const n of staged)if(/^(backup|restore|importacao)-/.test(n)){fs.rmSync(path.join(this.config.paths.tmp,n),{recursive:true,force:true});removed++;}
    return removed;
  }
}
module.exports={BackupManager,FOLDERS,LABELS,friendly,integrityOk};
