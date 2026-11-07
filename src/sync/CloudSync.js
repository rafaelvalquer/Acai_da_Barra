'use strict';
// Keeps the cloud copy (PostgreSQL on Supabase) up to date with the local database, where the till always sells:
// with or without internet, no sale waits for the cloud. What changed (ChangeLog) is sent every few seconds, in one
// transaction; without internet it stays noted here and goes when the connection comes back, in order, never twice.
//   - The local rows are read with the PDV paused for a moment (milliseconds); the cloud is written while the PDV
//     runs, so a slow or missing internet never holds a sale.
//   - The notes are removed only after the cloud committed. A crash in between sends the same rows again, which
//     changes nothing there (INSERT … ON CONFLICT DO UPDATE).
//   - After enabling, after a restore, or when the cloud no longer matches, the whole database is sent instead and
//     checked table by table before it is committed.
//   - The cloud copy belongs to one computer (table pdv_sync): another PDV pointed at it never overwrites it.
const os=require('node:os'),crypto=require('node:crypto');
const {TABLES,TABLE_NAMES}=require('../database/schema');const {Mutex}=require('../database/Mutex');
const {exportLocalData,readTable}=require('../database/migration-tools/ExportLocalData');const {insertRows}=require('../database/migration-tools/copyData');
const {isEmpty}=require('../database/migration-tools/ImportToPostgres');const {resetIdentities,migratePostgres,POSTGRES_VERSION}=require('../database/migrations/postgres');
const {summarize}=require('../database/summary');const {friendlyPg}=require('../database/DatabaseMigrationService');
const ChangeLog=require('./ChangeLog');
const BATCH=200;
// tick: how often local changes are looked at; backoff: waits between attempts without internet (the last one
// repeats forever); check: how often the cloud is compared with the local data.
const TIMING={tick:3000,backoff:[5000,10000,30000,60000],check:30*60*1000,firstCheck:60*1000,saveEvery:60*1000};
const digest=rows=>crypto.createHash('sha256').update(rows.map(r=>JSON.stringify(r)).join('\n')).digest('hex');
const OFFLINE=/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|timeout|terminated|getaddrinfo|socket hang up/i;
const isOffline=e=>OFFLINE.test(`${e.code||''} ${e.message||''}`);
const httpError=(status,message,extra={})=>Object.assign(Error(message),{status,...extra});
// Created by the PDV in the cloud database (idempotent, outside schema_migrations): who owns the copy, and foreign
// keys checked at the end of each transaction, so the rows of one send can arrive in any order.
const CLOUD_SETUP=`CREATE TABLE IF NOT EXISTS pdv_sync(id INTEGER PRIMARY KEY CHECK (id=1),device_id TEXT NOT NULL,device_name TEXT,claimed_at TIMESTAMPTZ NOT NULL,last_push_at TIMESTAMPTZ);
DO $$DECLARE r record;BEGIN
  FOR r IN SELECT c.conname,t.relname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    WHERE c.contype='f' AND NOT c.condeferrable AND t.relnamespace=current_schema()::regnamespace AND t.relname IN (${TABLE_NAMES.map(n=>`'${n}'`).join(',')})
  LOOP EXECUTE format('ALTER TABLE %I ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',r.relname,r.conname);END LOOP;
END$$;`;
const prepareCloud=pg=>pg.exec(CLOUD_SETUP);
const placeholders=n=>Array(n).fill('?').join(',');
// One send of changes: rows gone here are deleted there, the others written as they are here.
async function applyChanges(q,batch){
  await q.exec('SET CONSTRAINTS ALL DEFERRED');
  for(const {table:t,deletes} of [...batch.tables].reverse())
    for(let i=0;i<deletes.length;i+=BATCH){const part=deletes.slice(i,i+BATCH);await q.run(`DELETE FROM ${t.name} WHERE ${t.key} IN (${placeholders(part.length)})`,part);}
  for(const {table:t,upserts} of batch.tables){
    const set=t.columns.filter(c=>c!==t.key).map(c=>`${c}=EXCLUDED.${c}`).join(',');
    for(let i=0;i<upserts.length;i+=BATCH){
      const params=[];const values=upserts.slice(i,i+BATCH).map(r=>`(${t.columns.map(c=>{params.push(r[c]??null);return '?';}).join(',')})`).join(',');
      await q.run(`INSERT INTO ${t.name}(${t.columns.join(',')}) VALUES ${values} ON CONFLICT (${t.key}) DO UPDATE SET ${set}`,params);
    }
  }
  await resetIdentities(q,batch.tables.filter(x=>x.upserts.length).map(x=>x.table));
}
// The whole database: everything in the cloud is replaced and compared table by table before the commit.
async function replaceAll(q,data){
  await q.exec('SET CONSTRAINTS ALL DEFERRED');
  for(const t of [...TABLES].reverse())await q.run(`DELETE FROM ${t.name}`);
  await insertRows(q,data);await resetIdentities(q,TABLES);
  for(const t of TABLES)
    if(digest(await readTable(q,t))!==digest(data.tables[t.name]||[]))throw Error(`A cópia da tabela ${t.name} na nuvem não conferiu com este computador; nada foi alterado na nuvem.`);
}
class CloudSync {
  constructor({databases,settings,vault,log=console,audit=async()=>{},timing={},now=()=>Date.now()}){
    Object.assign(this,{databases,settings,vault,log,audit,now});this.timing={...TIMING,...timing};
    this.queue=new Mutex();this.enabled=false;this.full=false;this.claimPending=false;this.connectPending=false;this.fullGen=0;this.pg=null;this.timer=null;this.stopped=false;
    this.pendingCount={changes:0,sales:0};this.countedWrites=null;this.problem=null;this.failures=0;this.retryAt=0;
    this.lastSyncAt=null;this.lastSavedAt=0;this.lastCheck=null;this.nextCheckAt=0;this.waitingSince=null;this.deviceId=null;this.target=null;
  }
  get store(){return this.databases.store;}
  iso(){return new Date(this.now()).toISOString();}
  // The local database, when it is the one in use (during the move from the old cloud mode it is not yet).
  local(){const a=this.store.adapter;return a.dialect==='sqlite'&&!a.unavailable?a:null;}
  async saveSync(patch){const cur=await this.settings.sync()||{};await this.settings.saveSync({...cur,...patch});}
  async start(){
    this.deviceId=await this.settings.deviceId();
    const s=await this.settings.sync()||{};
    Object.assign(this,{enabled:!!s.enabled,full:!!s.full,claimPending:!!s.claim,target:s.target||null,lastSyncAt:s.lastSyncAt||null,lastCheck:s.lastCheck||null});
    // Any database opened later (a restore, the move from the old cloud mode) passes here before it is used.
    this.store.afterInit=adapter=>this.attach(adapter);
    const a=this.local();if(this.enabled&&a)await this.attach(a);
    // The cloud is reached once at start, even with nothing to send: one prepared by the previous version of the
    // program is brought up to date right after an update, not only at the next sale.
    this.connectPending=this.enabled;
    this.nextCheckAt=this.now()+this.timing.firstCheck;this.schedule(0);
  }
  // A local database without the change log while the copy is on was replaced (restore, copy from the cloud):
  // nothing says what the cloud is missing, so all of it is sent.
  async attach(adapter){
    if(!this.enabled||adapter.dialect!=='sqlite'||adapter.unavailable)return;
    if(!(await ChangeLog.isInstalled(adapter))){await ChangeLog.install(adapter);await this.markFull('banco local substituído');}
    this.countedWrites=null;
  }
  async markFull(reason){
    this.full=true;this.fullGen++;await this.saveSync({full:true});
    this.log.info?.(`Cópia na nuvem: o banco inteiro será enviado (${reason}).`);
  }
  schedule(ms=this.timing.tick){
    clearTimeout(this.timer);if(this.stopped)return;
    this.timer=setTimeout(()=>{this.queue.run(()=>this.step()).catch(e=>this.log.error?.(`Cópia na nuvem: ${e.message}`)).finally(()=>this.schedule());},ms);
    this.timer.unref?.();
  }
  async step(){
    if(!this.enabled||this.stopped)return;const a=this.local();if(!a)return;
    if(a.writes!==this.countedWrites){this.countedWrites=a.writes;await this.count(a);}
    if(this.now()<this.retryAt)return;
    if(this.full||this.pendingCount.changes>0||this.connectPending||this.now()>=this.nextCheckAt)await this.push(a);
  }
  async count(a){
    const p=await this.store.exclusive(async()=>this.store.adapter===a&&await ChangeLog.isInstalled(a)?ChangeLog.pending(a):{changes:0,sales:0});
    this.pendingCount=p;
    if(p.changes||this.full){if(!this.waitingSince)this.waitingSince=this.iso();}else this.waitingSince=null;
  }
  async push(a){
    try{
      const pg=await this.connection();
      if(this.full)await this.sendAll(pg,a);else await this.sendChanges(pg,a);
      if(this.now()>=this.nextCheckAt)await this.check(pg,a);
      this.succeeded();
    }catch(e){await this.failed(e);}
    finally{await this.count(a).catch(()=>{});}
  }
  succeeded(){
    if(this.problem)this.log.info?.('Cópia na nuvem: conexão restabelecida, envio em dia.');
    this.problem=null;this.failures=0;this.retryAt=0;this.connectPending=false;this.lastSyncAt=this.iso();
    if(this.now()-this.lastSavedAt>=this.timing.saveEvery){this.lastSavedAt=this.now();this.saveSync({lastSyncAt:this.lastSyncAt}).catch(()=>{});}
  }
  async failed(e){
    const kind=e.owner?'outro-dono':isOffline(e)?'sem-conexao':'erro';
    const message=kind==='sem-conexao'?'Sem conexão com a nuvem. As vendas continuam guardadas neste computador e serão enviadas quando a internet voltar.':kind==='erro'?friendlyPg(e):e.message;
    if(this.problem?.kind!==kind||this.problem?.message!==message){
      this.log.warn?.(`Cópia na nuvem: ${message}${kind==='sem-conexao'?` (${e.message})`:''}`);
      if(kind!=='sem-conexao')await this.audit({username:'sistema',action:'nuvem_falha',ok:false,detail:{erro:message}}).catch(()=>{});
    }
    this.problem={kind,message,at:this.iso(),since:this.problem?.since||this.iso()};
    this.failures++;const b=this.timing.backoff;this.retryAt=this.now()+b[Math.min(this.failures-1,b.length-1)];
    await this.drop();
  }
  async connection(){
    if(this.pg)return this.pg;
    const url=this.vault.get('databaseUrl');
    if(!url)throw httpError(409,'O endereço do banco na nuvem não está guardado neste computador. Ative a cópia na nuvem de novo na Administração.');
    const pg=await this.databases.connect({connectionString:url,ca:this.vault.get('databaseCa')||null,caFile:null,max:2});
    try{
      await prepareCloud(pg);
      if(this.claimPending){await this.claim(pg,{replace:true});this.claimPending=false;await this.saveSync({claim:false});}
      await this.upgrade(pg);
    }catch(e){await pg.close().catch(()=>{});throw e;}
    this.pg=pg;return pg;
  }
  // The cloud database must have the same tables and columns as this PDV before anything is sent. One of an older
  // version (prepared before an update of the program) gets the PDV's own migrations, only when it is this
  // computer's copy, and then the whole database is sent. A newer one (another PDV, already updated) stops the sends.
  async upgrade(pg){
    const version=await pg.schemaVersion();
    if(version>POSTGRES_VERSION)throw httpError(409,`O banco na nuvem é de uma versão mais nova do PDV (versão ${version}; esta é a ${POSTGRES_VERSION}). Atualize o programa neste computador para voltar a enviar. As vendas continuam guardadas aqui.`);
    if(version===POSTGRES_VERSION)return;
    const r=await pg.get('SELECT device_id,device_name FROM pdv_sync WHERE id=1');if(!r||r.device_id!==this.deviceId)throw this.ownerError(r);
    await migratePostgres(pg);
    this.log.info?.(`Cópia na nuvem: banco na nuvem atualizado da versão ${version} para a ${POSTGRES_VERSION}.`);
    await this.audit({username:'sistema',action:'nuvem_atualizada',detail:{de:version,para:POSTGRES_VERSION}}).catch(()=>{});
    await this.markFull(`banco na nuvem atualizado para a versão ${POSTGRES_VERSION}`);
  }
  ownerError(r){
    return httpError(409,`A cópia na nuvem passou a ser de outro computador${r?.device_name?` (${r.device_name})`:''}. Este PDV parou de enviar; as vendas continuam guardadas aqui. Para este computador voltar a enviar, ative a cópia na nuvem de novo na Administração.`,{owner:true});
  }
  async drop(){const pg=this.pg;this.pg=null;if(pg)await Promise.race([pg.close().catch(()=>{}),new Promise(r=>{const t=setTimeout(r,1000);t.unref?.();})]);}
  // Inside the cloud transaction: the copy must still be this computer's.
  async own(q){
    const r=await q.get('SELECT device_id,device_name FROM pdv_sync WHERE id=1 FOR UPDATE');
    if(!r||r.device_id!==this.deviceId)throw this.ownerError(r);
    await q.run('UPDATE pdv_sync SET last_push_at=? WHERE id=1',[this.iso()]);
  }
  async sendChanges(pg,a){
    const batch=await this.store.exclusive(()=>this.store.adapter===a?ChangeLog.readBatch(a):null);if(!batch)return;
    await pg.transaction(async q=>{await this.own(q);await applyChanges(q,batch);});
    await this.store.exclusive(()=>this.store.adapter===a?ChangeLog.clear(a,batch.maxSeq):null);
  }
  async sendAll(pg,a){
    const gen=this.fullGen;
    const snap=await this.store.exclusive(async()=>this.store.adapter===a?{maxSeq:await ChangeLog.lastSeq(a),data:await exportLocalData(a)}:null);if(!snap)return;
    await pg.transaction(async q=>{await this.own(q);await replaceAll(q,snap.data);});
    await this.store.exclusive(()=>this.store.adapter===a?ChangeLog.clear(a,snap.maxSeq):null);
    if(gen===this.fullGen){this.full=false;await this.saveSync({full:false});}
    const rows=Object.values(snap.data.tables).reduce((s,r)=>s+r.length,0);
    this.log.info?.(`Cópia na nuvem: banco inteiro enviado e conferido (${rows} registros).`);
    await this.audit({username:'sistema',action:'nuvem_envio_completo',detail:{registros:rows}}).catch(()=>{});
  }
  // With nothing waiting, the same summary (rows per table and business totals) on both sides. A difference, such
  // as a row changed straight in Supabase, is corrected by sending everything: the cloud is a copy.
  async check(pg,a){
    this.nextCheckAt=this.now()+this.timing.check;
    const local=await this.store.exclusive(async()=>{if(this.store.adapter!==a)return null;return (await ChangeLog.pending(a)).changes?null:summarize(a);});
    if(!local)return;
    const same=JSON.stringify(local)===JSON.stringify(await summarize(pg));
    if(!same){
      this.log.warn?.('Cópia na nuvem: a nuvem não conferia com este computador; o banco inteiro será enviado de novo.');
      await this.audit({username:'sistema',action:'nuvem_divergente',ok:false,detail:{corrigido:true}}).catch(()=>{});
      await this.markFull('a nuvem não conferia com este computador');await this.sendAll(pg,a);
    }
    this.lastCheck={at:this.iso(),ok:same,corrected:!same};await this.saveSync({lastCheck:this.lastCheck});
  }
  // Before the copy is turned on: the cloud database must be empty, already this computer's, or replaced on purpose.
  async claim(pg,{replace=false}={}){
    await prepareCloud(pg);const deviceId=this.deviceId||(this.deviceId=await this.settings.deviceId());
    await pg.transaction(async q=>{
      const r=await q.get('SELECT device_id,device_name FROM pdv_sync WHERE id=1 FOR UPDATE');
      if(r?.device_id!==deviceId&&!replace&&(r||!(await isEmpty(q)).empty))
        throw httpError(409,r?`Este banco na nuvem já recebe os dados de outro computador (${r.device_name||'sem nome'}). Confirme a substituição para este computador assumir: os dados da nuvem serão trocados pelos deste computador.`
          :'Este banco na nuvem já tem dados do PDV. Confirme a substituição para usá-lo: os dados da nuvem serão trocados pelos deste computador.',{expose:{needsReplace:true,owner:r?.device_name||null}});
      await q.run('INSERT INTO pdv_sync(id,device_id,device_name,claimed_at) VALUES(1,?,?,?) ON CONFLICT (id) DO UPDATE SET device_id=EXCLUDED.device_id,device_name=EXCLUDED.device_name,claimed_at=EXCLUDED.claimed_at',
        [deviceId,os.hostname(),this.iso()]);
    });
  }
  // Turns the copy on: the change log starts here and the whole database goes first. claim: this computer takes the
  // cloud database over at the first send (after the move from the old cloud mode, when both hold the same data).
  async enable({target,claim=false}){
    await this.queue.run(async()=>{
      Object.assign(this,{enabled:true,target,problem:null,failures:0,retryAt:0,full:true,claimPending:claim});this.fullGen++;
      await this.saveSync({enabled:true,full:true,claim,target,enabledAt:this.iso()});
      const a=this.local();if(a)await this.store.exclusive(()=>ChangeLog.install(a));
      this.countedWrites=null;this.nextCheckAt=this.now()+this.timing.firstCheck;await this.drop();
    });
    this.schedule(0);
  }
  async disable(){
    await this.queue.run(async()=>{
      Object.assign(this,{enabled:false,full:false,claimPending:false,problem:null,pendingCount:{changes:0,sales:0},waitingSince:null,target:null});
      await this.saveSync({enabled:false,full:false,claim:false,target:null,disabledAt:this.iso()});
      const a=this.local();if(a)await this.store.exclusive(()=>ChangeLog.remove(a));
      await this.drop();
    });
  }
  // "Sincronizar agora": a send right away, even while waiting to try again after a failure.
  async syncNow(){
    if(!this.enabled)throw httpError(409,'A cópia na nuvem não está ativa.');
    return this.queue.run(async()=>{
      const a=this.local();if(!a)throw httpError(409,'Aguarde a passagem para o banco deste computador.');
      this.retryAt=0;await this.count(a);await this.push(a);
      if(this.problem)throw httpError(502,this.problem.message);
      return this.status();
    });
  }
  async resend(){
    if(!this.enabled)throw httpError(409,'A cópia na nuvem não está ativa.');
    await this.queue.run(async()=>{await this.markFull('pedido na Administração');this.retryAt=0;});this.schedule(0);
    return this.status();
  }
  status(){
    const state=!this.enabled?'desligado':this.problem?this.problem.kind:this.full||this.pendingCount.changes?'enviando':'em-dia';
    return {enabled:this.enabled,state,pendingSales:this.pendingCount.sales,pendingChanges:this.pendingCount.changes,full:this.full,
      waitingSince:this.waitingSince,lastSyncAt:this.lastSyncAt,problem:this.problem,lastCheck:this.lastCheck,target:this.target,device:os.hostname()};
  }
  // For the till screen, asked almost every second: kept in memory, no query.
  brief(){
    if(!this.enabled)return null;const s=this.status();
    return {state:s.state,pendingSales:s.pendingSales,pendingChanges:s.pendingChanges,waitingMs:s.waitingSince?Math.max(0,this.now()-Date.parse(s.waitingSince)):0};
  }
  async stop(){
    this.stopped=true;clearTimeout(this.timer);
    await Promise.race([this.queue.run(()=>{}),new Promise(r=>{const t=setTimeout(r,5000);t.unref?.();})]);
    await this.drop();
  }
}
module.exports={CloudSync,prepareCloud,applyChanges,replaceAll,CLOUD_SETUP,TIMING};
