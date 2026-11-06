'use strict';
// Which database the till sells on: the local SQLite file, always, so sales never wait for the internet (the cloud
// receives a copy, see src/sync/CloudSync.js). Installations of the old cloud mode, where the till sold straight on
// PostgreSQL (saved in the Admin area, or PDV_DATABASE_PROVIDER=postgres in config/luminor-pdv.env), still open on
// it until the move to the local database (DatabaseMigrationService.convertLegacy). If that cloud database cannot be
// reached at start, the PDV still starts: sales answer "database unavailable" and it keeps trying to reconnect every
// 30 seconds (onReconnect then runs the move), while the Admin area stays available.
const fs=require('node:fs');
const {SQLiteAdapter}=require('./adapters/SQLiteAdapter');const {PostgresAdapter}=require('./adapters/PostgresAdapter');
const {PdvStore}=require('../store');
const RETRY_MS=30*1000;
const unavailableError=reason=>Object.assign(Error(`Banco de dados na nuvem indisponível (${reason}). Verifique a internet ou volte ao banco local em Configurações > Administração.`),{status:503});
// Stands in for the cloud database while it is out of reach: every query fails with a clear message.
class UnavailableAdapter {
  constructor(reason){this.dialect='postgres';this.provider='postgres';this.unavailable=true;this.reason=reason;this.inTransaction=false;}
  fail(){throw unavailableError(this.reason);}
  async all(){this.fail();}async get(){this.fail();}async run(){this.fail();}async exec(){this.fail();}async transaction(){this.fail();}
  async schemaVersion(){this.fail();}async tableNames(){this.fail();}async close(){}
}
function describeUrl(url){
  try{const u=new URL(url);return {host:u.hostname,port:Number(u.port||5432),database:decodeURIComponent(u.pathname.slice(1)||'postgres'),user:decodeURIComponent(u.username||'')};}catch(_){return null;}
}
class DatabaseManager {
  constructor({config,settings=null,vault=null,log=console,connect=opts=>PostgresAdapter.connect(opts)}){
    Object.assign(this,{config,settings,vault,log,connect});this.store=null;this.timer=null;this.lastError=null;this.connectedAt=null;this.lastIntegrity=null;this.onReconnect=null;this.retryMs=RETRY_MS;
  }
  // The saved choice: {provider:'sqlite'|'postgres', url, ca}.
  async choice(){
    const saved=this.settings?await this.settings.database():null;
    if(saved?.provider==='postgres')return {provider:'postgres',url:this.vault?.get('databaseUrl'),ca:this.vault?.get('databaseCa')||null,source:'admin'};
    if(saved?.provider==='sqlite')return {provider:'sqlite',source:'admin'};
    return this.config.provider==='postgres'?{provider:'postgres',url:this.config.databaseUrl,caFile:this.config.databaseCaFile,source:'arquivo'}:{provider:'sqlite',source:'arquivo'};
  }
  async connectPostgres(c){return this.connect({connectionString:c.url,ca:c.ca||null,caFile:c.caFile||null});}
  async open(){
    const c=await this.choice();this.active=c;
    if(c.provider==='sqlite'){this.store=await PdvStore.open(SQLiteAdapter.open(this.config.sqlitePath));return this.store;}
    try{this.store=await PdvStore.open(await this.connectPostgres(c));this.connectedAt=new Date().toISOString();this.lastError=null;}
    catch(e){
      this.lastError={at:new Date().toISOString(),message:e.message};this.log.error?.(`Banco na nuvem indisponível ao iniciar: ${e.message}`);
      this.store=new PdvStore(new UnavailableAdapter(e.code||'sem conexão'));this.retry(c);
    }
    return this.store;
  }
  retry(c){
    clearTimeout(this.timer);
    this.timer=setTimeout(async()=>{
      if(!this.store.adapter.unavailable||this.active!==c)return;
      try{const a=await this.connectPostgres(c);await this.store.exclusive(()=>this.store.replaceAdapter(a));this.connectedAt=new Date().toISOString();this.lastError=null;this.log.info?.('Conexão com o banco na nuvem restabelecida.');
        Promise.resolve(this.onReconnect?.()).catch(()=>{});}
      catch(e){this.lastError={at:new Date().toISOString(),message:e.message};this.retry(c);}
    },this.retryMs);this.timer.unref?.();
  }
  // Switches the store to another database (after a migration, or back to local). Runs inside store.exclusive().
  async switchTo(adapter,choice){clearTimeout(this.timer);await this.store.replaceAdapter(adapter);this.active=choice;this.connectedAt=adapter.dialect==='postgres'?new Date().toISOString():null;this.lastError=null;}
  async integrity(){
    const a=this.store.adapter;const at=new Date().toISOString();let result;
    if(a.unavailable)result={ok:false,at,message:'Banco indisponível'};
    else if(a.dialect==='sqlite')result=await this.store.exclusive(async()=>{
      const ic=Object.values(await a.get('PRAGMA integrity_check')||{})[0];const fk=await a.all('PRAGMA foreign_key_check');
      return {ok:ic==='ok'&&fk.length===0,at,message:ic==='ok'?(fk.length?`${fk.length} referência(s) quebrada(s)`:'Banco íntegro'):String(ic)};
    });
    else result=await this.store.exclusive(async()=>{await a.get('SELECT 1 AS ok');return {ok:true,at,message:'Conexão e consultas funcionando'};});
    this.lastIntegrity=result;return result;
  }
  status(){
    const a=this.store.adapter;const c=this.active||{};
    let size=null;try{size=fs.statSync(this.config.sqlitePath).size+(fs.existsSync(this.config.sqlitePath+'-wal')?fs.statSync(this.config.sqlitePath+'-wal').size:0);}catch(_){}
    return {provider:c.provider||a.dialect,source:c.source||'arquivo',
      sqlite:{path:this.config.sqlitePath,bytes:size,active:a.dialect==='sqlite'},
      postgres:c.provider==='postgres'?{...(describeUrl(c.url||'')||{}),connected:!a.unavailable,connectedAt:this.connectedAt,lastError:this.lastError}:null,
      integrity:this.lastIntegrity};
  }
  stop(){clearTimeout(this.timer);}
}
module.exports={DatabaseManager,UnavailableAdapter,describeUrl};
