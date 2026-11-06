'use strict';
// npm run backup [-- --tipo manual|atualizacao]
// Makes a backup from the command line, with or without the PDV open (the installer runs it before an update).
const {loadConfig,prepareHome}=require('../config');
const {BackupService}=require('../backup/BackupService');const {SecretVault}=require('../config/SecretVault');
const {AdminStore}=require('../auth/AdminStore');const {AdminSettingsService}=require('../config/AdminSettingsService');const {HardwareConfig}=require('../hardware');
const path=require('node:path');
async function main(){
  const i=process.argv.indexOf('--tipo');const kind=i>0?process.argv[i+1]:'manual';
  if(!['manual','atualizacao'].includes(kind))throw Error('Tipo inválido. Use manual ou atualizacao.');
  const config=loadConfig();prepareHome(config);
  const vault=new SecretVault(config.vaultFile,{mode:config.vault});await vault.load();
  const adminStore=await AdminStore.open(config.adminDbPath);const settings=new AdminSettingsService({store:adminStore,vault,config});
  const {DatabaseManager}=require('../database/DatabaseManager');const manager=new DatabaseManager({config,settings,vault,log:console});
  const db=await manager.open();
  try{
    if(db.adapter.unavailable)throw Error('banco na nuvem indisponível');
    const service=await new BackupService({config,store:db,settings,vault,hardware:new HardwareConfig(path.join(config.paths.config,'hardware.json')),log:{info(){},warn:console.warn,error:console.error}}).start({schedule:false});
    const r=await service.create({kind});
    console.log(`Backup gravado: ${r.file} (${r.bytes} bytes, ${r.summary.sales.done} vendas).`);
  }finally{manager.stop();await db.close();await adminStore.close();}
}
if(require.main===module)main().catch(e=>{console.error(`Backup não realizado: ${e.message}`);process.exit(1);});
module.exports={main};
