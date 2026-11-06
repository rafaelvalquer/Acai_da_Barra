'use strict';
// Settings changed in the Admin area. Plain values (backup time, which database is active, the cloud database's
// host and user) are kept in config/admin.sqlite; secrets (database address with its password, CA certificate,
// backup key) in the vault. The values in config/luminor-pdv.env are only the defaults.
const fs=require('node:fs'),path=require('node:path');
const fail=msg=>{throw Object.assign(Error(msg),{status:400});};
class AdminSettingsService {
  constructor({store,vault,config}){this.store=store;this.vault=vault;this.config=config;}
  async backup(){
    const s=await this.store.setting('backup',{})||{};const d=this.config.backup;
    return {enabled:typeof s.enabled==='boolean'?s.enabled:d.enabled,time:/^\d{2}:\d{2}$/.test(s.time||'')?s.time:d.time,
      retentionDays:Number.isInteger(s.retentionDays)?s.retentionDays:d.retention.daily,extraFolder:typeof s.extraFolder==='string'?s.extraFolder:''};
  }
  async saveBackup(input){
    const cur=await this.backup();const next={...cur};
    if(input.enabled!==undefined)next.enabled=!!input.enabled;
    if(input.time!==undefined){const m=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(input.time));if(!m)fail('Horário inválido. Use HH:MM, por exemplo 02:00.');next.time=input.time;}
    if(input.retentionDays!==undefined){const n=Number(input.retentionDays);if(!Number.isInteger(n)||n<1||n>90)fail('Dias de backup diário: de 1 a 90.');next.retentionDays=n;}
    if(input.extraFolder!==undefined){
      const dir=String(input.extraFolder||'').trim();
      if(dir){
        if(!path.isAbsolute(dir))fail('Informe o caminho completo da pasta, por exemplo E:\\Backups PDV.');
        try{fs.mkdirSync(dir,{recursive:true});const probe=path.join(dir,`.luminor-teste-${process.pid}`);fs.writeFileSync(probe,'ok');fs.rmSync(probe);}
        catch(e){fail(`Não foi possível gravar na pasta ${dir}: ${e.code||e.message}. Confira se o pendrive ou a unidade está conectado.`);}
      }
      next.extraFolder=dir;
    }
    await this.store.setSetting('backup',next);return next;
  }
  // {provider, postgres:{host,port,database,user}, activatedAt}. Null until something was chosen in the Admin area.
  database(){return this.store.setting('database',null);}
  saveDatabase(v){return this.store.setSetting('database',v);}
  // The cloud copy: {enabled, full, target:{host,port,database,user}, enabledAt, lastSyncAt, lastCheck}.
  sync(){return this.store.setting('sync',null);}
  saveSync(v){return this.store.setSetting('sync',v);}
  // Identifies this computer as the owner of the cloud copy. Created once, kept across updates.
  async deviceId(){
    let id=await this.store.setting('deviceId',null);
    if(!id){id=require('node:crypto').randomUUID();await this.store.setSetting('deviceId',id);}
    return id;
  }
  backupKeyConfirmedAt(){return this.store.setting('backupKeyConfirmedAt',null);}
  confirmBackupKey(){return this.store.setSetting('backupKeyConfirmedAt',new Date().toISOString());}
}
module.exports={AdminSettingsService};
