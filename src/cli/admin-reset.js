'use strict';
// node src/cli/admin-reset.js --confirmar (npm run admin:redefinir without the flag) — emergency access when the administrator password and the recovery code were both lost.
// Must be run on the store's computer by a Windows administrator (only they can open the config folder and its
// vault). Prints a temporary password that has to be changed at the next sign-in; the initial "admin" password is
// never brought back.
const {loadConfig,prepareHome}=require('../config');const {SecretVault}=require('../config/SecretVault');
const {AdminStore}=require('../auth/AdminStore');const {AdminSessionService}=require('../auth/AdminSessionService');
const {AdminBootstrap}=require('../auth/AdminBootstrap');const {AdminAuthService}=require('../auth/AdminAuthService');
const fs=require('node:fs'),path=require('node:path');
async function main(){
  if(!process.argv.includes('--confirmar')){console.log('Isto cria uma senha temporária para o administrador do Luminor PDV.\nPara continuar, rode na pasta do programa: node src/cli/admin-reset.js --confirmar');return;}
  const config=loadConfig();prepareHome(config);
  const vault=new SecretVault(config.vaultFile,{mode:config.vault});await vault.load();
  const store=await AdminStore.open(config.adminDbPath);
  try{
    const audit=e=>{fs.appendFileSync(path.join(config.paths.logs,'auditoria.log'),JSON.stringify({at:new Date().toISOString(),...e})+'\n');return store.audit(e);};
    const bootstrap=new AdminBootstrap({store,vault});await bootstrap.ensure();
    const auth=new AdminAuthService({store,sessions:new AdminSessionService(store),bootstrap,vault,audit});
    const r=await auth.resetWithTemporaryPassword();
    console.log(`Usuário: ${r.username}\nSenha temporária: ${r.temporaryPassword}\nEntre em Configurações > Administração do sistema e defina a nova senha.`);
  }finally{await store.close();}
}
if(require.main===module)main().catch(e=>{console.error(`Não foi possível redefinir: ${e.message}`);process.exit(1);});
module.exports={main};
