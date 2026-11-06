'use strict';
// The first administrator. A new installation gets the account "admin" with the initial password "admin", which only
// lets the person set a definitive password (at least 12 characters). Once that happens the installation is marked
// as initialized in the vault (outside admin.sqlite), so the initial password never works again: not after
// restoring a backup, moving to Supabase, updating the program, or even if admin.sqlite is deleted. In that last case
// the account comes back with no password, and only the emergency recovery code (or the reset command run by a
// Windows administrator on this computer) opens it.
const INITIAL_USER='admin',INITIAL_PASSWORD='admin';
class AdminBootstrap {
  constructor({store,vault,log=console}){this.store=store;this.vault=vault;this.log=log;}
  async ensure(){
    const n=(await this.store.get('SELECT COUNT(*) AS n FROM admin_users')).n;
    if(n>0)return this.state();
    const now=new Date().toISOString();
    if(this.vault.get('adminInitializedAt')){
      await this.store.run('INSERT INTO admin_users(username,password_hash,initial,must_change,recovery_hash,recovery_created_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        [this.vault.get('adminUsername')||INITIAL_USER,null,0,1,this.vault.get('adminRecoveryHash'),this.vault.get('adminRecoveryCreatedAt'),now,now]);
      await this.store.audit({action:'admin_db_recriado',ok:false,detail:{motivo:'admin.sqlite ausente numa instalação já ativada'}});
      this.log.warn?.('Banco de administração recriado: entre com o código de recuperação de emergência.');
      return 'recuperacao';
    }
    await this.store.run('INSERT INTO admin_users(username,password_hash,initial,must_change,created_at,updated_at) VALUES(?,?,1,1,?,?)',[INITIAL_USER,null,now,now]);
    await this.store.audit({action:'admin_criado',detail:{username:INITIAL_USER}});
    return 'inicial';
  }
  async state(){
    const u=await this.store.get('SELECT initial,password_hash,must_change FROM admin_users ORDER BY id LIMIT 1');
    if(!u)return 'vazio';if(u.initial&&!u.password_hash)return 'inicial';if(!u.password_hash)return 'recuperacao';return 'pronto';
  }
  // The initial credentials open the account only while it is still the untouched initial account.
  initialAllowed(user){return !!(user&&user.initial&&!user.password_hash&&!this.vault.get('adminInitializedAt'));}
  async markInitialized(username){await this.vault.update({adminInitializedAt:new Date().toISOString(),adminUsername:username});}
}
module.exports={AdminBootstrap,INITIAL_USER,INITIAL_PASSWORD};
