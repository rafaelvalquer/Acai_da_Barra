'use strict';
// Restores a backup: select the file → validate → review → confirm → restore → reopen. Only the commercial data
// (sales, shifts, products, employees, settings) is replaced: the Admin accounts, the vault and this computer's
// scale port are not in backups and stay as they are.
//
// The swap runs with every other operation paused and the scale ignored. Before it, a safety backup of the current
// database is made (backups/seguranca). Then the current file is closed (its WAL folded in) and moved aside, the
// staged, already validated and migrated copy is moved into its place and opened. If anything fails, the copy is
// discarded and the previous file goes back. A journal next to the database records each step, so a power cut in
// the middle is undone at the next start (recoverInterruptedRestore) and the PDV comes back with the previous data.
// With the cloud database (PostgreSQL) active, the rows are replaced inside one transaction instead: all or nothing.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');const {randomUUID}=require('node:crypto');
const {SQLiteAdapter}=require('../database/adapters/SQLiteAdapter');
const {exportLocalData}=require('../database/migration-tools/ExportLocalData');const {replaceData}=require('../database/migration-tools/copyData');
const {summarize}=require('../database/summary');
const {BackupError}=require('./BackupFormat');const {integrityOk}=require('./BackupManager');const {stamp}=require('./clock');
const {writeAtomic}=require('../hardware');
const JOURNAL='restauracao-em-andamento.json';
const UPLOAD_TTL_MS=30*60*1000;
const httpError=(status,message,code)=>Object.assign(Error(message),{status,code});
const SIDE=['-wal','-shm','-journal'];
function moveDatabase(from,to){fs.renameSync(from,to);for(const s of SIDE)if(fs.existsSync(from+s))fs.renameSync(from+s,to+s);}
function removeDatabase(file){for(const s of ['',...SIDE])fs.rmSync(file+s,{force:true});}
function moveFile(from,to){try{fs.renameSync(from,to);}catch(e){if(e.code!=='EXDEV')throw e;fs.copyFileSync(from,to);fs.rmSync(from,{force:true});}}
function journalPath(config){return path.join(path.dirname(config.sqlitePath),JOURNAL);}

// At start, before the database is opened: an unfinished restore is undone.
function recoverInterruptedRestore(config,log=console){
  const file=journalPath(config);let j;
  try{j=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;log.error?.(`Diário de restauração ilegível (${file}); verifique a pasta de dados.`);return {error:'diario-ilegivel'};}
  let outcome;
  if(j.state==='concluido'){if(j.previous)removeDatabase(j.previous);outcome='concluida';}
  else if(j.previous&&fs.existsSync(j.previous)){removeDatabase(j.target);moveDatabase(j.previous,j.target);outcome='desfeita';}
  else outcome='nada-alterado';
  fs.rmSync(file,{force:true});
  if(j.staged)fs.rmSync(path.dirname(j.staged),{recursive:true,force:true});
  log.warn?.(`Restauração interrompida encontrada ao iniciar (${j.state}): ${outcome==='desfeita'?'o banco anterior foi recolocado':outcome}.`);
  return {state:j.state,outcome,startedAt:j.startedAt,actor:j.actor};
}

class RestoreService {
  // validator: BackupValidator; manager: BackupManager (safety backups); audit(entry) writes to the Admin log
  // (config/admin.sqlite and logs/auditoria.log), which a restore never replaces; setMaintenance(message|null)
  // pauses the API and the scale.
  constructor({config,store,manager,validator,audit=async()=>{},setMaintenance,log=console,hooks={},maxBytes=512*1024*1024}){
    Object.assign(this,{config,store,manager,validator,audit,setMaintenance,log,hooks,maxBytes});this.uploads=new Map();this.running=false;
  }
  expire(){const now=Date.now();for(const u of this.uploads.values())if(u.expires<now)this.cancel(u.id);}
  // Step 1: receives the file (a stream of bytes) into a staging folder and reads its header.
  async receive(stream){
    this.expire();for(const u of [...this.uploads.values()])this.cancel(u.id);
    const id=randomUUID();fs.mkdirSync(this.config.paths.tmp,{recursive:true});
    const dir=fs.mkdtempSync(path.join(this.config.paths.tmp,'restore-'));const file=path.join(dir,'arquivo.luminorbackup');
    const u={id,dir,file,expires:Date.now()+UPLOAD_TTL_MS,staged:null,review:null};this.uploads.set(id,u);
    try{
      let size=0;const fh=await fsp.open(file,'w');
      try{for await(const chunk of stream){size+=chunk.length;if(size>this.maxBytes)throw new BackupError('tamanho','Arquivo grande demais para um backup do PDV.',413);await fh.write(chunk);}}finally{await fh.close();}
      if(!size)throw new BackupError('formato','Nenhum arquivo recebido.',400);
      const head=this.validator.inspect(await fsp.readFile(file));
      return {uploadId:id,bytes:size,...head};
    }catch(e){this.cancel(id);throw e;}
  }
  get(id){this.expire();const u=this.uploads.get(String(id||''));if(!u)throw httpError(404,'Arquivo de backup não encontrado. Selecione o arquivo de novo.');return u;}
  // Step 2: full validation; the database is staged, migrated and summarized for the review.
  async validate(id,{recoveryKey}={}){
    const u=this.get(id);u.staged=null;u.review=null;
    fs.rmSync(path.join(u.dir,'banco'),{recursive:true,force:true});
    const r=await this.validator.validate(await fsp.readFile(u.file),{stageDir:path.join(u.dir,'banco'),recoveryKey});
    u.staged=r.staged;u.review=r.review;u.expires=Date.now()+UPLOAD_TTL_MS;
    return {uploadId:u.id,...r.review};
  }
  cancel(id){const u=this.uploads.get(id);if(!u)return false;this.uploads.delete(id);fs.rmSync(u.dir,{recursive:true,force:true});return true;}
  // Step 3, after the person confirmed and typed the password: the swap.
  async restore(id,{actor}){
    const u=this.get(id);if(!u.staged)throw httpError(409,'Valide o arquivo antes de restaurar.');
    if(this.store.adapter.unavailable)throw httpError(503,'O banco de dados está indisponível. Restaure depois que a conexão voltar ou volte ao banco local.');
    if(this.running)throw httpError(409,'Já existe uma restauração em andamento.');
    if(await this.store.shift())throw httpError(409,'Feche o caixa antes de restaurar um backup.');
    this.running=true;this.setMaintenance('Restaurando um backup. Aguarde alguns instantes…');
    try{
      const safety=await this.manager.create({kind:'seguranca',actor});
      return await this.store.exclusive(()=>this.store.adapter.dialect==='postgres'?this.replaceRows(u,{actor,safety}):this.swap(u,{actor,safety}));
    }finally{this.running=false;this.setMaintenance(null);this.cancel(u.id);}
  }
  record(actor,action,detail,ok=true){return this.audit({username:actor?.username||null,action,ok,detail});}
  details(u,safety){return {backupCreatedAt:u.review.createdAt,backupKind:u.review.kind,backupAppVersion:u.review.appVersion,schemaVersion:u.review.schemaVersion,
    keySource:u.review.keySource,safetyBackup:safety.name,sales:u.review.summary.sales.done};}
  // Cloud database: the staged copy's rows replace the current ones in one transaction.
  async replaceRows(u,{actor,safety}){
    const {store}=this;if(await store.ctx.cash.shift())throw httpError(409,'Feche o caixa antes de restaurar um backup.');
    const detail=this.details(u,safety);
    const staged=SQLiteAdapter.open(u.staged,{journal:'DELETE'});let data;try{data=await exportLocalData(staged);}finally{await staged.close();}
    try{
      await this.hooks.afterSwap?.();
      await replaceData(store.adapter,data);
      const now=await summarize(store.adapter);
      if(JSON.stringify(now.counts)!==JSON.stringify(data.summary.counts))throw Error('as contagens depois da restauração não conferem');
      await store.init();
    }catch(e){
      await this.record(actor,'restauracao_falhou',{...detail,error:e.message},false).catch(()=>{});
      throw httpError(500,`A restauração falhou e os dados anteriores foram mantidos. Detalhe: ${e.message}`,'falhou');
    }
    await this.record(actor,'backup_restaurado',detail);
    return {restored:true,backupCreatedAt:u.review.createdAt,summary:u.review.summary,safetyBackup:safety.name};
  }
  async swap(u,{actor,safety}){
    const {store,config}=this;const target=config.sqlitePath;const startedAt=new Date();
    // Checked again with everything paused: no shift may have been opened since.
    if(await store.ctx.cash.shift())throw httpError(409,'Feche o caixa antes de restaurar um backup.');
    const previous=path.join(path.dirname(target),`luminor-pdv.antes-da-restauracao-${stamp(startedAt)}.sqlite`);
    const jfile=journalPath(config);const journal=state=>writeAtomic(jfile,JSON.stringify({state,target,previous,staged:u.staged,startedAt:startedAt.toISOString(),
      actor:actor?.username||null,backupCreatedAt:u.review.createdAt,safetyBackup:safety.name},null,2));
    const detail=this.details(u,safety);
    journal('preparando');
    await store.adapter.checkpoint();await store.adapter.close();
    moveDatabase(target,previous);journal('trocando');
    try{
      moveFile(u.staged,target);
      await this.hooks.afterSwap?.();
      const adapter=SQLiteAdapter.open(target);
      if(!(await integrityOk(adapter))){await adapter.close();throw Error('o banco restaurado não passou na verificação de integridade');}
      await store.replaceAdapter(adapter);
      journal('concluido');
      await this.record(actor,'backup_restaurado',detail);
    }catch(e){
      this.log.error?.(`Restauração falhou, voltando ao banco anterior: ${e.message}`);
      try{
        await store.adapter.close();removeDatabase(target);moveDatabase(previous,target);
        store.attach(SQLiteAdapter.open(target));await store.init();
        fs.rmSync(jfile,{force:true});
      }catch(rollback){
        // The journal stays: the next start puts the previous file back.
        this.log.error?.(`Falha ao voltar ao banco anterior: ${rollback.message}. Reinicie o PDV.`);
        this.setMaintenance('Falha na restauração. Reinicie o Luminor PDV para recuperar os dados anteriores.',{sticky:true});
        throw httpError(500,'A restauração falhou. Reinicie o Luminor PDV: os dados anteriores serão recuperados.');
      }
      await this.record(actor,'restauracao_falhou',{...detail,error:e.message},false).catch(()=>{});
      throw httpError(500,`A restauração falhou e os dados anteriores foram mantidos. Detalhe: ${e.message}`,'falhou');
    }
    removeDatabase(previous);fs.rmSync(jfile,{force:true});
    return {restored:true,backupCreatedAt:u.review.createdAt,summary:u.review.summary,safetyBackup:safety.name};
  }
}
module.exports={RestoreService,recoverInterruptedRestore,JOURNAL,moveDatabase,removeDatabase,moveFile};
