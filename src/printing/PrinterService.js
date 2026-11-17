'use strict';
const {closingLines,testLines,toBytes,ascii}=require('./ThermalReceiptBuilder');
const {PrinterSettings}=require('./PrinterSettings');const {PrintJobRepository}=require('./PrintJobRepository');
const {WindowsSpoolerTransport}=require('./transports/WindowsSpoolerTransport');const {ElginTransport}=require('./transports/ElginTransport');const {BrowserFallbackTransport}=require('./transports/BrowserFallbackTransport');
// The closing report on paper. Printing is an effect outside the database: it happens only after the close is
// committed, a failure never undoes the close, and every attempt is a row of the queue (PrintJobRepository).
//   - the first ("original") print of a close is a single job per close (dedupe key), so a double click or an
//     automatic print plus a click cannot print it twice by accident;
//   - a doubtful result (the PDV restarted or the system timed out while handing over) is reported as doubtful and a
//     new copy needs an explicit confirmation; a plain failure can be retried;
//   - copies after the original are marked "2a VIA - REIMPRESSAO" with who asked;
//   - nothing is retried by itself, and nothing here takes bytes or commands from the browser.
// The transport (Windows queue, Elgin E1, browser) is chosen by the settings and can be swapped without touching the
// report (ThermalReceiptBuilder).
const fail=(status,message,expose)=>Object.assign(Error(message),{status,...(expose?{expose}:{})});
class PrinterService {
  // store: config/admin.sqlite (AdminStore). transports: replaced in tests. audit: the administrative log.
  constructor({store,transports=null,audit=async()=>{},clock=()=>new Date(),log=console}){
    this.settings=new PrinterSettings(store);this.jobs=new PrintJobRepository(store);this.audit=audit;this.clock=clock;this.log=log;
    const spooler=new WindowsSpoolerTransport(),elgin=new ElginTransport(),browser=new BrowserFallbackTransport();
    this.transports=transports||{[spooler.id]:spooler,[elgin.id]:elgin,[browser.id]:browser};
    this.chain=Promise.resolve();
  }
  async start(){try{const n=await this.jobs.recoverInterrupted();if(n)this.log.warn?.(`${n} impressão(ões) interrompida(s) pelo reinício: marcadas como duvidosas.`);}catch(e){this.log.error?.(`Fila de impressão: ${e.message}`);}}
  // One hand-over to the printer at a time.
  serial(fn){const run=this.chain.then(fn,fn);this.chain=run.catch(()=>{});return run;}
  transportOf(settings){const t=this.transports[settings.transport];if(!t)throw fail(400,'Forma de envio desconhecida.');return t;}
  getSettings(){return this.settings.get();}
  async saveSettings(input,{by}={}){const s=await this.settings.save(input);await this.audit({username:by,action:'impressora_configurada',detail:{impressora:s.printerName,tipo:s.type,envio:s.transport,automatica:s.autoPrint,corte:s.autoCut&&s.cutVerified}});return s;}
  async listPrinters(){
    const s=await this.settings.get();const t=this.transportOf(s);
    if(!t.supported())return {transport:t.id,supported:false,error:t.unsupportedError().message,printers:[],spoolerRunning:false};
    try{return {transport:t.id,supported:true,...await t.listPrinters()};}
    catch(e){return {transport:t.id,supported:true,error:e.message,printers:[],spoolerRunning:false};}
  }
  async getPrinterStatus(){
    const s=await this.settings.get();const t=this.transportOf(s);
    if(t.browser)return {transport:t.id,...await t.getStatus()};
    if(!s.printerName)return {transport:t.id,code:'not_configured',label:'Nenhuma impressora escolhida.'};
    try{return {transport:t.id,printer:s.printerName,...await t.getStatus(s.printerName)};}catch(e){return {transport:t.id,printer:s.printerName,code:'unavailable',label:e.message};}
  }
  // What goes to the printer or the screen for a close. Pure: no state is read or written.
  render(report,settings,{reprint=null}={}){
    const lines=closingLines(report,{width:settings.columns,storeName:settings.storeName,unit:settings.unit,header:settings.header,footer:settings.footer,reprint});
    return {lines,text:lines.map(ascii).join('\n')};
  }
  bytesFor(lines,settings,transport){
    const mode=settings.type==='generic_80'||!transport.escpos?'text':'escpos';
    const cut=mode==='escpos'&&settings.autoCut&&settings.cutVerified;
    return toBytes(lines,{mode,cut});
  }
  async testPrint({by,cut=false}={}){
    const s=await this.settings.get();const t=this.transportOf(s);
    const lines=testLines({width:s.columns,printer:s.printerName||'(navegador)'});
    if(t.browser)return {mode:'browser',text:lines.map(ascii).join('\n')};
    if(!s.printerName)throw fail(400,'Escolha a impressora antes de imprimir o teste.');
    if(!t.supported())throw t.unsupportedError();
    const mode=s.type==='generic_80'?'text':'escpos';
    const bytes=toBytes(lines,{mode,cut:cut&&mode==='escpos'});
    const job=await this.jobs.create({kind:'test',printer:s.printerName,transport:t.id,requestedAt:this.clock().toISOString(),requestedBy:by});
    return this.serial(()=>this.submit(job,t,s,bytes,{by,label:'Teste de impressão'}));
  }
  // Prints (or reprints) a saved close. report: the close as the database has it (never from the browser).
  // reprint: true for a copy after the original. confirmDuplicate: the person confirmed a new copy after a doubtful result.
  async printClosing(report,{by,reprint=false,confirmDuplicate=false,auto=false}={}){
    const s=await this.settings.get();const t=this.transportOf(s);
    if(!t.browser&&!s.printerName)throw fail(409,'A impressora de fechamento não foi escolhida. Peça ao administrador para configurá-la na Administração do sistema.',{printer:'not_configured'});
    if(!t.browser&&!t.supported())throw Object.assign(t.unsupportedError(),{status:409});
    const existing=await this.jobs.forReconciliation(report.uuid);
    const original=existing.find(j=>j.dedupe_key===`original:${report.uuid}`);
    const now=this.clock().toISOString();
    // Anything already accepted, or being sent, makes the next one a reprint.
    if(auto&&original)return {ok:true,duplicate:true,status:original.status,message:'Este fechamento já tem uma impressão registrada.',job:original};
    const asCopy=!!original&&(reprint||['SUBMITTED','SPOOLING'].includes(original.status));
    if(asCopy&&original&&original.status==='SPOOLING')throw fail(409,'Já existe uma impressão deste fechamento em andamento. Aguarde.',{printing:true});
    if(asCopy&&existing.some(j=>j.ambiguous&&j.status==='FAILED')&&!confirmDuplicate)
      throw fail(409,'Não é possível saber se a última impressão deste fechamento saiu. Confira o papel; se não saiu, confirme para imprimir outra via.',{ambiguous:true,needsConfirmation:true});
    let job,mode;
    if(!asCopy){
      // The original: one job per close. A failed (not doubtful) job is retried in place; a doubtful one needs confirmation.
      job=original||await this.jobs.create({kind:'closing',dedupeKey:`original:${report.uuid}`,reconciliationUuid:report.uuid,shiftId:report.shiftId,revision:report.revision,printer:s.printerName,transport:t.id,copies:s.copies,requestedAt:now,requestedBy:by,auto});
      if(!job)job=await this.jobs.byDedupe(`original:${report.uuid}`);
      if(job.status==='FAILED'&&job.ambiguous&&!confirmDuplicate)throw fail(409,'Não é possível saber se a impressão saiu. Confira o papel; se não saiu, confirme para imprimir de novo.',{ambiguous:true,needsConfirmation:true});
      if(job.status==='CANCELED')throw fail(409,'Esta impressão foi cancelada.');
      mode={reprint:null};
    }else{
      job=await this.jobs.create({kind:'reprint',reconciliationUuid:report.uuid,shiftId:report.shiftId,revision:report.revision,printer:s.printerName,transport:t.id,copies:s.copies,requestedAt:now,requestedBy:by,auto:false});
      mode={reprint:{by,at:now}};
    }
    const {lines,text}=this.render(report,s,mode);
    if(t.browser){await this.jobs.begin(job.uuid,{printer:'(navegador)',transport:t.id});await this.jobs.submitted(job.uuid,{at:now});
      return {mode:'browser',text,job:await this.jobs.byUuid(job.uuid)};}
    const bytes=this.bytesFor(lines,s,t);
    return this.serial(()=>this.submit(job,t,s,bytes,{by,report,reprint:asCopy,copies:s.copies}));
  }
  async reprintClosing(report,opts={}){return this.printClosing(report,{...opts,reprint:true});}
  // Hands the bytes to the transport and records the outcome. Never throws for a printing problem: the answer says what happened.
  async submit(job,t,s,bytes,{by,report=null,reprint=false,copies=1,label}={}){
    if(!await this.jobs.begin(job.uuid,{printer:s.printerName,transport:t.id}))return {ok:false,status:(await this.jobs.byUuid(job.uuid)).status,message:'Esta impressão já está em andamento ou foi enviada.',job:await this.jobs.byUuid(job.uuid)};
    const name=report?`Fechamento turno ${report.shiftId} rev ${report.revision}`:label||'Luminor PDV';
    try{
      let r={};
      for(let n=0;n<(job.kind==='test'?1:copies||1);n++)r=await t.send({printer:s.printerName,bytes,jobName:name});
      await this.jobs.submitted(job.uuid,{spoolJobId:r.spoolJobId,at:this.clock().toISOString()});
      await this.audit({username:by,action:job.kind==='test'?'impressora_teste':reprint?'fechamento_reimpresso':'fechamento_impresso',detail:{turno:report?.shiftId??null,revisao:report?.revision??null,impressora:s.printerName,trabalhoWindows:r.spoolJobId||null}});
      return {ok:true,status:'SUBMITTED',message:'Enviado para a impressora. Confira se o papel saiu.',job:await this.jobs.byUuid(job.uuid)};
    }catch(e){
      const ambiguous=!!e.ambiguous;
      await this.jobs.failed(job.uuid,{error:e.message,ambiguous});
      await this.audit({username:by,action:'impressao_falhou',ok:false,detail:{turno:report?.shiftId??null,revisao:report?.revision??null,impressora:s.printerName,erro:e.message,codigo:e.code||null,duvidosa:ambiguous}});
      return {ok:false,status:'FAILED',ambiguous,message:ambiguous?`${e.message} Não é possível saber se imprimiu: confira o papel antes de tentar de novo.`:e.message,job:await this.jobs.byUuid(job.uuid)};
    }
  }
  jobsFor(uuid){return this.jobs.forReconciliation(uuid);}
  recentFailures(limit=20){return this.jobs.recentFailures(limit);}
  recent(limit=20){return this.jobs.recent(limit);}
}
module.exports={PrinterService};
