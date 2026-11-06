'use strict';
// Daily automatic backup at the configured time (02:00 by default, store clock). Checked at start and every minute:
// if the latest scheduled time passed with no automatic backup after it (the computer was off, or the PDV closed),
// the backup runs right away. After a failure it tries again in 30 minutes, and the alert stays on the Dados e
// Backup screen until a backup succeeds. It runs in the background: sales pause only for the snapshot itself.
const {lastScheduled}=require('./clock');
const RETRY_MS=30*60*1000,TICK_MS=60*1000;
class BackupScheduler {
  constructor({manager,status,settings,clock=()=>new Date(),log=console}){
    Object.assign(this,{manager,status,settings,clock,log});this.timer=null;this.running=null;
  }
  // settings() → {enabled, time}; read on every tick, so a change on the screen applies without a restart.
  due(){
    const {enabled,time}=this.settings();if(!enabled||!this.manager.supported)return false;
    const now=this.clock();const slot=lastScheduled(now,time);
    const last=this.status.lastAutomatic;if(last&&Date.parse(last.at)>=slot.getTime())return false;
    const f=this.status.lastFailure;if(f?.kind==='automatico'&&now-Date.parse(f.at)<RETRY_MS)return false;
    return true;
  }
  async tick(){
    if(this.running)return this.running;if(!this.due())return null;
    this.running=this.manager.create({kind:'automatico'}).then(r=>{this.log.info?.(`Backup automático gravado: ${r.name}`);return r;})
      .catch(e=>{this.log.error?.(`Backup automático falhou: ${e.message}`);return null;}).finally(()=>{this.running=null;});
    return this.running;
  }
  start(){if(this.timer)return;this.tick();this.timer=setInterval(()=>this.tick(),TICK_MS);this.timer.unref?.();}
  async stop(){clearInterval(this.timer);this.timer=null;if(this.running)await this.running;}
  // When the next automatic backup is expected (for the screen).
  next(){
    const {enabled,time}=this.settings();if(!enabled)return null;
    const now=this.clock();const slot=lastScheduled(now,time);const last=this.status.lastAutomatic;
    if(!last||Date.parse(last.at)<slot.getTime())return now.toISOString();
    return lastScheduled(new Date(slot.getTime()+36*3600*1000),time).toISOString();
  }
}
module.exports={BackupScheduler,RETRY_MS};
