'use strict';
// The store's backup key: created on the first start and kept in the vault (Windows DPAPI). The same key, written as
// the recovery key, is what the administrator keeps away from the computer: without it, backups cannot be opened on
// a new machine.
const {newKey,keyId,formatKey}=require('./BackupFormat');
class BackupKeys {
  constructor({vault,settings}){this.vault=vault;this.settings=settings;this.confirmedAt=null;}
  async init(){
    await this.vault.load();
    if(!this.vault.get('backupKey'))await this.vault.update({backupKey:newKey().toString('base64'),backupKeyCreatedAt:new Date().toISOString()});
    this.confirmedAt=this.settings?await this.settings.backupKeyConfirmedAt():null;
    return this;
  }
  key(){const k=this.vault.get('backupKey');if(!k)throw Error('Chave de backup não carregada');return Buffer.from(k,'base64');}
  id(){return keyId(this.key());}
  recoveryKey(){return formatKey(this.key());}
  // The administrator confirmed the recovery key was written down and stored away from the computer.
  async confirm(){await this.settings.confirmBackupKey();this.confirmedAt=await this.settings.backupKeyConfirmedAt();}
  confirmed(){return !!this.confirmedAt;}
}
module.exports={BackupKeys};
