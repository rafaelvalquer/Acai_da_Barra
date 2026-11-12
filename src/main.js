'use strict';
// Starts the PDV: permanent data folder, vault and Admin database, commercial database (local or cloud), scale,
// automatic backups and the local server at http://127.0.0.1:3187. Started by the Windows task (through
// src/launcher.js) or by `npm start`.
const fs=require('node:fs'),path=require('node:path');
const {loadConfig,prepareHome}=require('./config');const {SecretVault}=require('./config/SecretVault');
const {AdminSettingsService}=require('./config/AdminSettingsService');const {AdminStore}=require('./auth/AdminStore');
const {DatabaseManager}=require('./database/DatabaseManager');const {importLegacySqlite}=require('./database/importLegacy');
const {recoverInterruptedRestore}=require('./backup/RestoreService');
const {ScaleDriver}=require('./scale');const {createServer,HOST}=require('./server');const {AdminSystem}=require('./admin/AdminSystem');
const {Logger}=require('./logger');
function startupError(config,e){
  try{const dir=config?.paths?.logs;if(dir){fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,'erros-inicializacao.log'),`[${new Date().toISOString()}] ${e.stack||e.message}\n`);}}catch(_){}
}
// simulator: the scale simulator of the till (src/server.js), off unless PDV_SCALE_SIMULATOR=true.
async function start({config=loadConfig(),log=null,scale=new ScaleDriver(),listen=true,clock,hooks,connect,schedule=true,syncTiming,simulator}={}){
  prepareHome(config);log=log||new Logger({dir:config.paths.logs});
  const vault=new SecretVault(config.vaultFile,{mode:config.vault});await vault.load();
  const adminStore=await AdminStore.open(config.adminDbPath);
  const settings=new AdminSettingsService({store:adminStore,vault,config});
  // Before the local database is opened: an unfinished restore is undone, and the database of v0.1 copied in once.
  recoverInterruptedRestore(config,log);
  await importLegacySqlite({source:config.legacySqlite,target:config.sqlitePath,tmpDir:config.paths.tmp,log});
  const databases=new DatabaseManager({config,settings,vault,log,...(connect?{connect}:{})});
  const db=await databases.open();
  const system=await AdminSystem.start({config,databases,adminStore,vault,settings,scale,log,clock,hooks,schedule,syncTiming});
  const server=createServer({db,scale,system,auth:system.pos,...(simulator?{simulator}:{})});
  if(listen)await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,HOST,()=>{server.off('error',reject);resolve();});});
  const st=databases.status();
  log.info(`Luminor PDV ${config.version} iniciado em http://${HOST}:${server.address()?.port||config.port} · banco ${st.provider==='sqlite'?'local (SQLite) '+st.sqlite.path+(system.sync.enabled?' · cópia na nuvem ativa':''):'na nuvem (PostgreSQL, modo antigo) '+(st.postgres?.host||'')} · dados em ${config.home}`);
  // An installation of the old cloud mode moves to the local database now, with the till already answering.
  const converting=system.migration.convertLegacy().catch(()=>false);
  system.autoConnectScale();
  let stopping=null;
  const stop=()=>stopping||(stopping=(async()=>{
    await converting;scale.disconnect();const closed=new Promise(r=>server.close(()=>r()));server.closeAllConnections?.();await closed;
    await system.stop();await db.close();await adminStore.close();
  })());
  return {config,db,databases,scale,system,server,adminStore,vault,log,stop,converting};
}
if(require.main===module){
  let config;
  try{config=loadConfig();}catch(e){console.error(`Configuração inválida: ${e.message}`);process.exit(2);}
  start({config}).then(app=>{
    let quitting=false;
    const quit=()=>{
      if(quitting)return;quitting=true;app.log.info('Encerrando o Luminor PDV.');
      app.stop().then(()=>{app.log.info('Luminor PDV encerrado.');process.exit(0);},e=>{app.log.error(`Erro ao encerrar: ${e.message}`);process.exit(1);});
    };
    process.on('SIGINT',quit);process.on('SIGTERM',quit);
    // Started by src/launcher.js: closing the channel is how it asks the PDV to finish cleanly.
    if(process.send)process.on('disconnect',quit);
    process.on('uncaughtException',e=>{app.log.error(`Erro inesperado: ${e.stack||e.message}`);startupError(config,e);process.exit(1);});
  }).catch(e=>{
    startupError(config,e);
    if(e.code==='EADDRINUSE'){console.error(`A porta ${config.port} já está em uso: o Luminor PDV provavelmente já está aberto. Acesse http://${HOST}:${config.port}`);process.exit(3);}
    console.error(`Não foi possível iniciar o Luminor PDV: ${e.message}`);process.exit(1);
  });
}
module.exports={start};
