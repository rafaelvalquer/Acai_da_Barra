'use strict';
// The Admin area's assistant for the cloud copy on Supabase (PostgreSQL), without editing code. The till always sells
// on the local database (works without internet); the cloud receives a copy kept up to date by src/sync/CloudSync.js.
//   1 test      connects to the address and password typed (TLS, certificate checked); the local data is not touched
//   2 prepare   creates the PDV's tables in the cloud database (it must be empty or already prepared)
//   3 enable    turns the copy on for this computer; the whole database goes first, checked table by table
// The old mode, in which the till sold straight on the cloud database, is converted at start (convertLegacy). While
// that waits for the cloud, going back to local can still reopen the local file as it was (useLocal "manter").
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {SQLiteAdapter}=require('./adapters/SQLiteAdapter');const {migratePostgres}=require('./migrations/postgres');const {migrateSqlite}=require('./migrations/sqlite');
const {exportLocalData}=require('./migration-tools/ExportLocalData');const {isEmpty}=require('./migration-tools/ImportToPostgres');
const {validateMigration}=require('./migration-tools/ValidateMigration');const {replaceData}=require('./migration-tools/copyData');
const {describeUrl}=require('./DatabaseManager');const {stamp}=require('../backup/clock');const {moveDatabase,removeDatabase,moveFile}=require('../backup/RestoreService');
const httpError=(status,message)=>Object.assign(Error(message),{status});
// Same data ⇔ same fingerprint (the export without its timestamp).
const fingerprint=async q=>{const {exportedAt,...d}=await exportLocalData(q);return crypto.createHash('sha256').update(JSON.stringify(d.tables)).digest('hex');};
// Address from the Supabase dashboard (Connect > Session pooler) plus the password typed separately.
function buildUrl({url,password}){
  let u;try{u=new URL(String(url||'').trim());}catch(_){throw httpError(400,'Endereço inválido. Cole a "connection string" do Supabase, que começa com postgresql://');}
  if(!['postgres:','postgresql:'].includes(u.protocol))throw httpError(400,'O endereço precisa começar com postgresql://');
  if(!u.hostname)throw httpError(400,'O endereço não tem o servidor.');
  if(password)u.password=encodeURIComponent(String(password));
  else if(!u.password||/^\[.*\]$/.test(decodeURIComponent(u.password)))throw httpError(400,'Digite a senha do banco de dados.');
  u.searchParams.delete('sslmode');return u.toString();
}
function friendlyPg(e){
  const m=e.message||String(e);
  if(/self[- ]signed|unable to verify|certificate/i.test(m))return `Certificado do servidor não verificado (${m}). Cole o certificado CA do Supabase (Database Settings > SSL) no campo Certificado.`;
  if(/password authentication failed/i.test(m))return 'Usuário ou senha do banco incorretos.';
  if(/ENOTFOUND|EAI_AGAIN/.test(e.code||m))return 'Servidor não encontrado. Confira o endereço e a internet.';
  if(/ETIMEDOUT|timeout/i.test(e.code||m))return 'Tempo esgotado ao conectar. Confira a internet e use o endereço do Session pooler.';
  if(/ECONNREFUSED/.test(e.code||m))return 'Conexão recusada pelo servidor.';
  return m;
}
class DatabaseMigrationService {
  constructor({config,manager,settings,vault,backups,sync,setMaintenance=()=>{},audit=async()=>{},log=console}){
    Object.assign(this,{config,manager,settings,vault,backups,sync,setMaintenance,audit,log});this.busy=false;this.converting=null;
  }
  get store(){return this.manager.store;}
  async pending(){const url=this.vault.get('pendingDatabaseUrl');if(!url)throw httpError(409,'Teste a conexão com o banco na nuvem primeiro.');return {url,ca:this.vault.get('pendingDatabaseCa')||null};}
  async open(c){try{return await this.manager.connectPostgres(c);}catch(e){throw httpError(502,friendlyPg(e));}}
  async exclusiveTask(message,fn){
    if(this.busy)throw httpError(409,'Já existe uma operação de banco de dados em andamento.');
    this.busy=true;this.setMaintenance(message);
    try{return await fn();}finally{this.busy=false;this.setMaintenance(null);}
  }
  // 1. Nothing is saved as active; the address is kept (in the vault) for the next steps.
  async test(input,actor){
    const url=buildUrl(input);const ca=String(input.ca||'').trim()||null;
    if(ca&&!/-----BEGIN CERTIFICATE-----/.test(ca))throw httpError(400,'O certificado deve estar no formato PEM (começa com -----BEGIN CERTIFICATE-----).');
    const started=Date.now();let pg;
    try{pg=await this.manager.connectPostgres({url,ca});}
    catch(e){await this.audit({username:actor?.username,action:'banco_teste',ok:false,detail:{host:describeUrl(url)?.host,erro:friendlyPg(e)}});throw httpError(502,friendlyPg(e));}
    try{
      const latencyMs=Date.now()-started;const v=await pg.get('SELECT version() AS v');
      const ssl=await pg.get('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()').catch(()=>null);
      const version=await pg.schemaVersion().catch(()=>0);const other=await pg.get("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=current_schema() AND table_name<>'schema_migrations'");
      const empty=version?await isEmpty(pg):{empty:Number(other.n)===0};
      await this.vault.update({pendingDatabaseUrl:url,pendingDatabaseCa:ca});
      const result={ok:true,latencyMs,server:String(v.v).split(' ').slice(0,2).join(' '),tls:ssl?!!ssl.ssl:null,target:describeUrl(url),
        schema:version?`PDV (versão ${version})`:Number(other.n)?'outras tabelas':'vazio',empty:empty.empty,prepared:version>0};
      await this.audit({username:actor?.username,action:'banco_teste',detail:{host:result.target.host,schema:result.schema}});
      return result;
    }finally{await pg.close();}
  }
  // 2. Creates the tables. A database with other tables (not the PDV's) is refused, so nothing of someone else's is touched.
  async prepare(actor){
    const pg=await this.open(await this.pending());
    try{
      const version=await pg.schemaVersion();
      if(!version){const other=await pg.get("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=current_schema()");if(Number(other.n)>0)throw httpError(409,'O banco na nuvem já tem outras tabelas. Use um banco (projeto) vazio para o PDV.');}
      await migratePostgres(pg);const e=await isEmpty(pg);
      await this.audit({username:actor?.username,action:'banco_preparado',detail:{host:describeUrl((await this.pending()).url)?.host}});
      return {prepared:true,version:await pg.schemaVersion(),empty:e.empty};
    }finally{await pg.close();}
  }
  // 3. Turns the cloud copy on for the database tested and prepared. The cloud must be empty, already this
  // computer's copy, or replaced on purpose (replace: the person confirmed it). Nothing changes in the local data.
  async enableSync(actor,{replace=false}={}){
    if(this.store.adapter.dialect!=='sqlite')throw httpError(409,'Aguarde a passagem para o banco deste computador antes de ativar a cópia na nuvem.');
    if(this.sync.enabled)throw httpError(409,'A cópia na nuvem já está ativa.');
    const c=await this.pending();const pg=await this.open(c);
    try{
      if(!(await pg.schemaVersion()))throw httpError(409,'Prepare o banco na nuvem antes de ativar a cópia.');
      await this.sync.claim(pg,{replace:!!replace});
    }catch(e){if(!e.status)throw httpError(502,friendlyPg(e));throw e;}
    finally{await pg.close();}
    await this.vault.update({databaseUrl:c.url,databaseCa:c.ca,pendingDatabaseUrl:null,pendingDatabaseCa:null});
    const target=describeUrl(c.url);await this.sync.enable({target});
    await this.audit({username:actor?.username,action:'nuvem_copia_ativada',detail:{host:target?.host,substituiu:!!replace}});
    return this.sync.status();
  }
  // The local data stays as it is; the cloud keeps what it had received.
  async disableSync(actor){
    if(!this.sync.enabled)throw httpError(409,'A cópia na nuvem não está ativa.');
    const host=this.sync.target?.host;await this.sync.disable();
    await this.vault.update({databaseUrl:null,databaseCa:null});
    await this.audit({username:actor?.username,action:'nuvem_copia_desativada',detail:{host}});
    return this.sync.status();
  }
  async syncNow(actor){const r=await this.sync.syncNow();await this.audit({username:actor?.username,action:'nuvem_sincronizada'});return r;}
  async resendAll(actor){const r=await this.sync.resend();await this.audit({username:actor?.username,action:'nuvem_reenvio_pedido'});return r;}
  // The old cloud mode (the till selling straight on the cloud database) becomes the local database plus the cloud
  // copy: the cloud data is copied here and checked (as "back to local", with a safety backup first), then the copy
  // is turned on and this computer takes the cloud database over at its first send (it holds the same data).
  // Runs at start and when the cloud comes back; while the cloud is out of reach nothing changes, and a copy that
  // fails leaves the PDV as it was, to be tried again at the next start.
  convertLegacy(){
    const a=this.store.adapter;if(a.dialect!=='postgres'||a.unavailable||this.busy)return Promise.resolve(false);
    if(this.converting)return this.converting;
    this.converting=(async()=>{
      const c=this.manager.active;const actor={username:'sistema'};const target=describeUrl(c.url);
      try{
        const ca=c.ca||(c.caFile?fs.readFileSync(c.caFile,'utf8'):null);
        this.log.info?.('Passando para o modo offline: as vendas da nuvem serão copiadas para este computador.');
        await this.useLocal(actor,{mode:'copiar'});
        await this.vault.update({databaseUrl:c.url,databaseCa:ca});
        await this.sync.enable({target,claim:true});
        await this.audit({username:'sistema',action:'modo_offline_ativado',detail:{host:target?.host}});
        this.log.info?.('Modo offline ativado: as vendas são gravadas neste computador e enviadas para a nuvem automaticamente.');
        return true;
      }catch(e){
        this.log.error?.(`Passagem para o modo offline não concluída (o PDV continua como estava): ${e.message}`);
        await this.audit({username:'sistema',action:'modo_offline_falhou',ok:false,detail:{host:target?.host,erro:e.message}});
        throw e;
      }finally{this.converting=null;}
    })();
    return this.converting;
  }
  // Back to the local database. mode "copiar": the cloud data goes into a new local file (reconciled); "manter": the
  // local file as it was at the migration (for when the cloud cannot be reached; later cloud sales are not in it).
  async useLocal(actor,{mode='copiar'}={}){
    if(this.store.adapter.dialect==='sqlite')throw httpError(409,'O banco local já está ativo.');
    if(!['copiar','manter'].includes(mode))throw httpError(400,'Opção inválida.');
    return this.exclusiveTask('Voltando para o banco local. Aguarde…',async()=>{
      const target=this.config.sqlitePath;const dir=path.dirname(target);let staged=null;
      if(mode==='copiar'){
        if(this.store.adapter.unavailable)throw httpError(503,'O banco na nuvem está fora do ar: não dá para copiar os dados. Use a opção de manter o banco local como estava.');
        await this.backups.create({kind:'seguranca',actor});
        fs.mkdirSync(this.config.paths.tmp,{recursive:true});const stage=fs.mkdtempSync(path.join(this.config.paths.tmp,'volta-'));staged=path.join(stage,'local.sqlite');
      }
      await this.store.exclusive(async()=>{
        if(mode==='copiar'){
          const a=SQLiteAdapter.open(staged,{journal:'DELETE'});
          try{await migrateSqlite(a);await replaceData(a,await exportLocalData(this.store.adapter));
            const report=await validateMigration(this.store.adapter,a);if(!report.ok)throw httpError(500,'A cópia local não conferiu com o banco na nuvem. Nada foi alterado.');}
          finally{await a.close();}
          if(fs.existsSync(target))moveDatabase(target,path.join(dir,`luminor-pdv.antes-da-volta-${stamp(new Date())}.sqlite`));
          moveFile(staged,target);
        }else if(!fs.existsSync(target))throw httpError(409,'Não há banco local neste computador. Use a opção de copiar os dados da nuvem.');
        await this.manager.switchTo(SQLiteAdapter.open(target),{provider:'sqlite',source:'admin'});
      }).finally(()=>{if(staged)fs.rmSync(path.dirname(staged),{recursive:true,force:true});});
      await this.settings.saveDatabase({provider:'sqlite',returnedAt:new Date().toISOString(),mode});
      await this.audit({username:actor?.username,action:'banco_local_ativado',detail:{modo:mode}});
      return this.manager.status();
    });
  }
}
module.exports={DatabaseMigrationService,buildUrl,friendlyPg,fingerprint};
