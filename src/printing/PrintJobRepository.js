'use strict';
const {randomUUID}=require('node:crypto');
// The closing-report print queue of this computer (table print_jobs of config/admin.sqlite). A job is a record of an
// effect outside the database: PENDING (waiting), SPOOLING (being handed to the printer), SUBMITTED (the print service
// accepted it: not a promise that paper came out), FAILED (with the reason) or CANCELED. Nothing here is retried by
// itself: a failed or doubtful job waits for a person.
const COLUMNS='id,uuid,kind,status,dedupe_key,reconciliation_uuid,shift_id,revision,printer,transport,spool_job_id,copies,requested_at,requested_by,submitted_at,attempts,last_error,ambiguous,auto';
const view=j=>j&&({...j,ambiguous:!!j.ambiguous,auto:!!j.auto});
class PrintJobRepository {
  constructor(store){this.store=store;}
  async create(j){
    const uuid=randomUUID();
    try{
      await this.store.run('INSERT INTO print_jobs(uuid,kind,status,dedupe_key,reconciliation_uuid,shift_id,revision,printer,transport,copies,requested_at,requested_by,auto) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [uuid,j.kind,'PENDING',j.dedupeKey??null,j.reconciliationUuid??null,j.shiftId??null,j.revision??null,j.printer??null,j.transport??null,j.copies||1,j.requestedAt,j.requestedBy??null,j.auto?1:0]);
    }catch(e){if(/UNIQUE|constraint/i.test(String(e.message))&&j.dedupeKey)return null;throw e;}
    return this.byUuid(uuid);
  }
  async byUuid(uuid){return view(await this.store.get(`SELECT ${COLUMNS} FROM print_jobs WHERE uuid=?`,[uuid]));}
  async byDedupe(key){return view(await this.store.get(`SELECT ${COLUMNS} FROM print_jobs WHERE dedupe_key=?`,[key]));}
  async forReconciliation(uuid){return (await this.store.all(`SELECT ${COLUMNS} FROM print_jobs WHERE reconciliation_uuid=? ORDER BY id`,[uuid])).map(view);}
  async recentFailures(limit=20){return (await this.store.all(`SELECT ${COLUMNS} FROM print_jobs WHERE status IN ('FAILED','CANCELED') OR ambiguous=1 ORDER BY id DESC LIMIT ?`,[limit])).map(view);}
  async recent(limit=20){return (await this.store.all(`SELECT ${COLUMNS} FROM print_jobs ORDER BY id DESC LIMIT ?`,[limit])).map(view);}
  // Moves a job to SPOOLING only from PENDING or FAILED (the guard makes two simultaneous attempts a single one).
  async begin(uuid,{printer,transport}){
    const r=await this.store.run("UPDATE print_jobs SET status='SPOOLING',attempts=attempts+1,printer=?,transport=?,last_error=NULL WHERE uuid=? AND status IN ('PENDING','FAILED')",[printer,transport,uuid]);
    return r.changes===1;
  }
  submitted(uuid,{spoolJobId=null,at}){return this.store.run("UPDATE print_jobs SET status='SUBMITTED',spool_job_id=?,submitted_at=?,ambiguous=0,last_error=NULL WHERE uuid=?",[spoolJobId,at,uuid]);}
  failed(uuid,{error,ambiguous=false}){return this.store.run("UPDATE print_jobs SET status='FAILED',last_error=?,ambiguous=? WHERE uuid=?",[String(error).slice(0,300),ambiguous?1:0,uuid]);}
  cancel(uuid){return this.store.run("UPDATE print_jobs SET status='CANCELED' WHERE uuid=? AND status IN ('PENDING','FAILED')",[uuid]);}
  // A restart finds jobs that were being handed over: nobody knows whether the spooler got them. They become FAILED and
  // doubtful, and wait for a person to decide about a new copy.
  async recoverInterrupted(){
    return (await this.store.run("UPDATE print_jobs SET status='FAILED',ambiguous=1,last_error='O PDV foi reiniciado durante o envio: não é possível saber se imprimiu.' WHERE status='SPOOLING'")).changes;
  }
}
module.exports={PrintJobRepository};
