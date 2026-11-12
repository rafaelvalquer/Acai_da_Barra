'use strict';
// Everything about this installation that is not selling: the Admin area (accounts, database choice, backups and
// restores, maintenance), the scale's remembered port and the administrative log. The authentication and its data
// (config/admin.sqlite, the vault) are independent of the commercial database, so the Admin area works whatever
// happens to it. Absent from the online demo, which has no installation and no administrator.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {HardwareConfig}=require('../hardware');const {AdminSettingsService}=require('../config/AdminSettingsService');
const {AdminSessionService}=require('../auth/AdminSessionService');const {AdminBootstrap}=require('../auth/AdminBootstrap');const {AdminAuthService}=require('../auth/AdminAuthService');
const {BackupService}=require('../backup/BackupService');const {DatabaseMigrationService}=require('../database/DatabaseMigrationService');const {CloudSync}=require('../sync/CloudSync');
const {describeUrl}=require('../database/DatabaseManager');const {AdminApi}=require('./AdminApi');const {mask}=require('../logger');
const {PosAuth}=require('../auth/PosAuth');
const httpError=(status,message)=>Object.assign(Error(message),{status});
const STARTED=new Date().toISOString();
class AdminSystem {
  constructor({config,databases,adminStore,vault,settings=null,scale,log=console,clock,hooks={},schedule=true,syncTiming={}}){
    Object.assign(this,{config,databases,adminStore,vault,scale,log,schedule});this.maintenanceMessage=null;this.sticky=false;this.onRestored=null;
    this.hardware=new HardwareConfig(path.join(config.paths.config,'hardware.json'));
    this.auditFilePath=path.join(config.paths.logs,'auditoria.log');
    this.settings=settings||new AdminSettingsService({store:adminStore,vault,config});
    this.sessions=new AdminSessionService(adminStore);
    this.bootstrap=new AdminBootstrap({store:adminStore,vault,log});
    this.auth=new AdminAuthService({store:adminStore,sessions:this.sessions,bootstrap:this.bootstrap,vault,audit:e=>this.audit(e)});
    const setMaintenance=(m,o)=>this.setMaintenance(m,o);const audit=e=>this.audit(e);
    this.backups=new BackupService({config,store:databases.store,settings:this.settings,vault,hardware:this.hardware,log,clock,hooks,setMaintenance,audit});
    this.sync=new CloudSync({databases,settings:this.settings,vault,log,audit,timing:syncTiming});
    this.migration=new DatabaseMigrationService({config,manager:databases,settings:this.settings,vault,backups:this.backups,sync:this.sync,setMaintenance,audit,log});
    // The old cloud mode moves to the local database as soon as the cloud answers again.
    databases.onReconnect=()=>this.migration.convertLegacy();
    this.api=new AdminApi(this);
  }
  static async start(opts){const s=new AdminSystem(opts);await s.bootstrap.ensure();await s.startTill();await s.backups.start({schedule:opts.schedule!==false});await s.sync.start();return s;}
  // Sign-in at the till (src/auth/PosAuth.js): the employees' PINs and the till sessions, in config/admin.sqlite. The
  // commercial database is reached through this.db, so a restore or a change of database is followed.
  async startTill(){
    const self=this;const db={accessIndex:()=>self.db.accessIndex(),savePermissions:(...a)=>self.db.savePermissions(...a),employeePermissions:(...a)=>self.db.employeePermissions(...a)};
    this.pos=new PosAuth({adminStore:this.adminStore,adminAuth:this.auth,db,pepper:await PosAuth.pepper(this.vault),audit:e=>this.audit(e),terminal:os.hostname()});
    this.sessions.onDestroyAll=userId=>this.pos.adminSessionsEnded(userId);
    await this.adminStore.pruneAudit().catch(e=>this.log.warn?.(`Registro administrativo antigo não removido: ${e.message}`));
  }
  get db(){return this.databases.store;}
  get version(){return this.config.version;}
  maintenance(){return this.maintenanceMessage;}
  setMaintenance(message,{sticky=false}={}){if(this.sticky&&!sticky)return;this.maintenanceMessage=message;if(sticky)this.sticky=true;}
  // Administrative log: admin.sqlite plus a copy in logs/auditoria.log.
  async audit(entry){
    const e={at:new Date().toISOString(),...entry};
    try{fs.mkdirSync(path.dirname(this.auditFilePath),{recursive:true});fs.appendFileSync(this.auditFilePath,JSON.stringify(e)+'\n');}catch(err){this.log.error?.(`Auditoria não gravada em arquivo: ${err.message}`);}
    await this.adminStore.audit(entry).catch(err=>this.log.error?.(`Auditoria não gravada: ${err.message}`));
  }
  handle(req,res,ctx){return this.api.handle(req,res,ctx);}
  async brief(){
    const unavailable=this.db.adapter.unavailable;
    return {version:this.version,maintenance:this.maintenanceMessage,database:{provider:this.db.adapter.dialect,unavailable:!!unavailable},sync:this.sync.brief(),...this.backups.brief()};
  }
  afterShiftClose(){this.backups.afterShiftClose();}
  rememberScale(portPath,baudRate){try{this.hardware.rememberScale(portPath,baudRate);}catch(e){this.log.error?.(`Porta da balança não gravada: ${e.message}`);}}
  // At start: reconnects the scale to the port used last time, if it is still there.
  async autoConnectScale(){
    const s=this.hardware.scale();if(!s)return null;
    try{await this.scale.connect(s.path,s.baudRate);this.log.info?.(`Balança conectada em ${s.path}.`);return true;}
    catch(e){this.log.warn?.(`Balança não conectada automaticamente (${s.path}): ${e.message}`);return false;}
  }
  async stop(){this.databases.stop();await this.sync.stop();return this.backups.stop();}
  // A restore replaces all commercial data: only with nothing on the scale (the shift is checked by the restore).
  assertRestoreAllowed(){if(!this.scale.idle())throw httpError(409,'Retire o produto da balança antes de restaurar.');}
  async overview(session){
    const b=this.backups.overview();const scale=this.scale.snapshot();
    return {user:{username:session.username},version:this.version,database:this.databases.status(),sync:this.sync.status(),
      backup:{lastSuccess:b.lastSuccess,lastFailure:b.lastFailure,next:b.next,alerts:b.alerts},scale:{status:scale.status,mode:scale.mode},maintenance:this.maintenanceMessage};
  }
  async databaseInfo(){
    const pending=this.vault.get('pendingDatabaseUrl');
    return {...this.databases.status(),schemaVersion:this.db.adapter.unavailable?null:await this.db.schemaVersion().catch(()=>null),
      lastBackupAt:this.backups.status.lastSuccess?.at||null,pending:pending?{...describeUrl(pending),hasCa:!!this.vault.get('pendingDatabaseCa')}:null,
      sync:this.sync.status(),converting:!!this.migration.converting,busy:this.migration.busy};
  }
  // Maintenance screen and the exported diagnostic: no passwords, no keys, no sales.
  async diagnostics({full=false}={}){
    let disk=null;try{const s=fs.statfsSync(this.config.home);disk={freeBytes:s.bavail*s.bsize,totalBytes:s.blocks*s.bsize};}catch(_){}
    const scale=this.scale.snapshot();const hw=this.hardware.scale();const b=this.backups.overview();const mem=process.memoryUsage();
    const d={generatedAt:new Date().toISOString(),version:this.version,
      service:{status:'em execução',pid:process.pid,startedAt:STARTED,uptimeSec:Math.round(process.uptime()),memoryMb:Math.round(mem.rss/1048576),node:process.version,
        platform:`${os.type()} ${os.release()}`,supervised:!!process.env.PDV_LAUNCHER},
      scale:{status:scale.status,mode:scale.mode,port:hw?.path||null,lastError:scale.lastError||null,updatedAt:scale.updatedAt},
      database:this.databases.status(),sync:this.sync.status(),backup:{lastSuccessAt:b.lastSuccess?.at||null,lastFailure:b.lastFailure,next:b.next,alerts:b.alerts},
      disk,paths:{home:this.config.home,data:this.config.paths.data,backups:this.config.paths.backups,logs:this.config.paths.logs},
      settings:{port:this.config.port,timezone:process.env.LUMINOR_TIMEZONE||'America/Sao_Paulo',vault:this.config.vault,envFile:this.config.envFile},
      logs:{errors:this.log.recent?.(20,'error')||[],recent:this.log.recent?.(full?300:60)||[]}};
    return JSON.parse(mask(JSON.stringify(d)));
  }
}
module.exports={AdminSystem};
