'use strict';
// Backups and restores of the store's commercial data, as one service: manual and automatic backups, retention, the
// extra copy folder, alerts, the recovery key and the restore flow. The mechanics live in the other files of
// src/backup/; this is what the Admin area uses.
const path=require('node:path');
const {BackupKeys}=require('./BackupKeys');const {BackupStatus}=require('./BackupStatus');
const {BackupManager}=require('./BackupManager');const {BackupValidator}=require('./BackupValidator');
const {RestoreService}=require('./RestoreService');const {BackupScheduler}=require('./BackupScheduler');
const STALE_MS=48*3600*1000;
class BackupService {
  // settings: AdminSettingsService; vault: SecretVault; audit(entry): Admin log.
  constructor({config,store,settings,vault,hardware=null,log=console,clock=()=>new Date(),hooks={},setMaintenance=()=>{},audit=async()=>{}}){
    Object.assign(this,{config,store,settings,log,clock});
    this.current={enabled:config.backup.enabled,time:config.backup.time,retentionDays:config.backup.retention.daily,extraFolder:''};
    this.keys=new BackupKeys({vault,settings});
    this.status=new BackupStatus(path.join(config.paths.backups,'estado.json'));
    this.manager=new BackupManager({config,store,keys:this.keys,status:this.status,hardware,log,clock,hooks});
    this.manager.extraFolder=()=>this.current.extraFolder;
    this.manager.retention=()=>({daily:this.current.retentionDays,weekly:config.backup.retention.weekly,monthly:config.backup.retention.monthly});
    this.validator=new BackupValidator({keys:this.keys});
    this.restorer=new RestoreService({config,store,manager:this.manager,validator:this.validator,setMaintenance,audit,log,hooks});
    this.scheduler=new BackupScheduler({manager:this.manager,status:this.status,settings:()=>this.current,clock,log});
    this.closeTimer=null;
  }
  async start({schedule=true}={}){
    await this.keys.init();if(this.settings)this.current=await this.settings.backup();
    const removed=this.manager.cleanup();if(removed)this.log.warn?.(`${removed} arquivo(s) de backup incompleto(s) removido(s) ao iniciar.`);
    if(schedule)this.scheduler.start();return this;
  }
  stop(){clearTimeout(this.closeTimer);return this.scheduler.stop();}
  async saveSettings(input){this.current=await this.settings.saveBackup(input);return this.current;}
  create(opts){return this.manager.create(opts);}
  // After the shift closes: a backup of the day, unless nothing changed since the last one. Never delays the close.
  afterShiftClose(){
    if(!this.manager.supported||!this.current.enabled)return;
    clearTimeout(this.closeTimer);
    this.closeTimer=setTimeout(()=>this.manager.create({kind:'fechamento',skipIfUnchanged:true}).catch(()=>{}),250);this.closeTimer.unref?.();
  }
  alerts(){
    const out=[];const st=this.status;const s=this.current;const f=st.lastFailure;
    if(f)out.push({level:'erro',text:`O último backup ${f.kind==='automatico'?'automático ':f.kind==='fechamento'?'do fechamento ':''}falhou: ${f.error}`,at:f.at});
    const last=st.lastAutomatic;
    if(s.enabled&&(!last||this.clock()-Date.parse(last.at)>STALE_MS))out.push({level:'aviso',text:last?'Nenhum backup automático nas últimas 48 horas. Verifique se o PDV fica ligado.':`Ainda não há backup automático. Ele roda todos os dias às ${s.time}.`});
    if(!s.enabled)out.push({level:'aviso',text:'O backup automático está desligado.'});
    if(st.data.lastCopyFailure&&s.extraFolder)out.push({level:'aviso',text:`A cópia para ${st.data.lastCopyFailure.folder} falhou: ${st.data.lastCopyFailure.error}`,at:st.data.lastCopyFailure.at});
    if(!this.keys.confirmed())out.push({level:'aviso',text:'Anote a chave de recuperação dos backups e guarde fora do computador. Sem ela, os backups não abrem em outro computador.'});
    return out;
  }
  // Small summary for every screen (the alert dot on the Configurações button).
  brief(){
    const alerts=this.alerts();
    return {lastBackupAt:this.status.lastSuccess?.at||null,alert:alerts.some(a=>a.level==='erro')?'erro':alerts.some(a=>a.level==='aviso')?'aviso':null};
  }
  overview(){
    const strip=e=>{if(!e)return e;const {file,databaseSha256,...rest}=e;return rest;};
    return {supported:this.manager.supported,provider:this.store.adapter.dialect,settings:this.current,folder:this.config.paths.backups,
      lastSuccess:strip(this.status.lastSuccess),lastAutomatic:strip(this.status.lastAutomatic),lastFailure:this.status.lastFailure,
      lastCopy:this.status.data.lastCopy||null,history:this.status.data.history||[],next:this.scheduler.next(),
      recoveryKey:{confirmed:this.keys.confirmed(),id:this.keys.id()},alerts:this.alerts(),files:this.manager.list().map(({file,...e})=>e)};
  }
}
module.exports={BackupService};
