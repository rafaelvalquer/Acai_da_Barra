'use strict';
// The Admin area's assistant for moving the sales to Supabase (PostgreSQL) and back, without editing code:
//   1 test      connects to the address and password typed (TLS, certificate checked); the active database is not touched
//   2 prepare   creates the PDV's tables in the cloud database (it must be empty or already prepared)
//   3 migrate   with the shift closed and sales paused: safety backup, copy of every row, mandatory reconciliation
//   4 activate  only if the local data did not change since the reconciliation; the PDV then sells on the cloud database
// Any failure leaves the local SQLite database as the active one, unchanged. Going back to local copies the cloud
// data into a new local file (checked the same way), or, when the cloud is unreachable, reopens the local file as it
// was at the migration.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {SQLiteAdapter}=require('./adapters/SQLiteAdapter');const {migratePostgres}=require('./migrations/postgres');const {migrateSqlite}=require('./migrations/sqlite');
const {exportLocalData}=require('./migration-tools/ExportLocalData');const {importToPostgres,isEmpty}=require('./migration-tools/ImportToPostgres');
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
  constructor({config,manager,settings,vault,backups,setMaintenance=()=>{},audit=async()=>{},log=console}){
    Object.assign(this,{config,manager,settings,vault,backups,setMaintenance,audit,log});this.busy=false;
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
  // 3. Copy and reconciliation. The local database is only read.
  async migrate(actor){
    if(this.store.adapter.dialect!=='sqlite')throw httpError(409,'A migração parte do banco local (SQLite).');
    if(await this.store.shift())throw httpError(409,'Feche o caixa antes de migrar os dados.');
    const c=await this.pending();const pg=await this.open(c);
    try{
      // Only into a database the PDV prepared (step 2 refuses one holding someone else's tables).
      if(!(await pg.schemaVersion()))throw httpError(409,'Prepare o banco na nuvem antes de migrar.');
      return await this.exclusiveTask('Copiando os dados para o banco na nuvem. Aguarde…',async()=>{
        const safety=await this.backups.create({kind:'seguranca',actor});
        const result=await this.store.exclusive(async()=>{
          if(await this.store.ctx.cash.shift())throw httpError(409,'Feche o caixa antes de migrar os dados.');
          const local=this.store.adapter;const data=await exportLocalData(local);
          await importToPostgres(pg,data);
          const report=await validateMigration(local,pg);
          return {report,fingerprint:await fingerprint(local)};
        });
        const target=describeUrl(c.url);
        const record={at:new Date().toISOString(),ok:result.report.ok,fingerprint:result.fingerprint,target,safetyBackup:safety.name,
          tables:result.report.tables.map(t=>({table:t.table,source:t.source,target:t.target,ok:t.ok})),totals:result.report.totals.filter(t=>!t.ok)};
        await this.settings.saveMigration(record);
        await this.audit({username:actor?.username,action:'banco_migrado',ok:record.ok,detail:{host:target?.host,tabelas:record.tables.length,diferencas:record.tables.filter(t=>!t.ok).length+record.totals.length}});
        if(!record.ok)throw Object.assign(httpError(409,'A conferência encontrou diferenças. O banco local continua ativo. Esvazie o banco na nuvem e migre de novo.'),{report:record});
        return record;
      });
    }catch(e){if(!e.status)e.status=500;if(!e.report)e.message=`Migração não concluída; o banco local continua ativo e sem alterações. ${friendlyPg(e)}`;throw e;}
    finally{await pg.close();}
  }
  // 4. Switches the sales to the cloud database.
  async activate(actor){
    if(this.store.adapter.dialect!=='sqlite')throw httpError(409,'O banco na nuvem já está ativo.');
    const m=await this.settings.migration();const c=await this.pending();
    if(!m?.ok)throw httpError(409,'Migre e confira os dados antes de ativar o banco na nuvem.');
    if(JSON.stringify(m.target)!==JSON.stringify(describeUrl(c.url)))throw httpError(409,'O banco testado não é o mesmo que recebeu a migração. Migre de novo.');
    return this.exclusiveTask('Ativando o banco na nuvem. Aguarde…',async()=>{
      const pg=await this.open(c);let switched=false;
      try{
        await this.store.exclusive(async()=>{
          if(await this.store.ctx.cash.shift())throw httpError(409,'Feche o caixa antes de trocar o banco de dados.');
          if(await fingerprint(this.store.adapter)!==m.fingerprint)throw httpError(409,'Houve vendas ou alterações no banco local depois da migração. Esvazie o banco na nuvem e migre de novo.');
          const report=await validateMigration(this.store.adapter,pg);if(!report.ok)throw httpError(409,'Os dados na nuvem não conferem mais com os locais. Migre de novo.');
          await this.manager.switchTo(pg,{provider:'postgres',url:c.url,ca:c.ca,source:'admin'});switched=true;
        });
        await this.vault.update({databaseUrl:c.url,databaseCa:c.ca});
        await this.settings.saveDatabase({provider:'postgres',postgres:describeUrl(c.url),activatedAt:new Date().toISOString()});
        await this.audit({username:actor?.username,action:'banco_ativado',detail:{provider:'postgres',host:describeUrl(c.url)?.host}});
        return this.manager.status();
      }catch(e){if(!switched)await pg.close();throw e;}
    });
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
