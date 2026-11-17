'use strict';
// A print service for the tests: the real PrinterService, the real queue (config/admin.sqlite of the test), and a fake
// printer in place of the Windows spooler. The fake can be told to fail the way Windows does (no driver, spooler
// stopped, printer off) and keeps every byte it was given.
const {PrinterService}=require('../src/printing/PrinterService');const {ElginTransport}=require('../src/printing/transports/ElginTransport');
const {BrowserFallbackTransport}=require('../src/printing/transports/BrowserFallbackTransport');
class FakeSpooler {
  constructor(){this.id='windows-spooler';this.label='Fila de impressão do Windows (teste)';this.escpos=true;this.sent=[];this.failWith=null;this.delayMs=0;this.names=['ELGIN i9','Microsoft Print to PDF'];this.nextJob=100;}
  supported(){return true;}
  async listPrinters(){return {spooler:'Running',spoolerRunning:true,user:'SYSTEM',printers:this.names.map(name=>({name,default:false,driver:'x',port:'USB001',status:{code:'ready',label:'Pronta (segundo o Windows)'}}))};}
  async getStatus(name){return this.names.includes(name)?{code:'ready',label:'Pronta (segundo o Windows)'}:{code:'missing',label:'A fila não aparece.'};}
  async send({printer,bytes,jobName}){
    if(this.delayMs)await new Promise(r=>setTimeout(r,this.delayMs));
    if(this.failWith)throw Object.assign(Error(this.failWith.message),{code:this.failWith.code||'write_failed',ambiguous:!!this.failWith.ambiguous});
    this.sent.push({printer,bytes:Buffer.from(bytes),jobName});return {spoolJobId:this.nextJob++,bytes:bytes.length};
  }
}
function fakePrinting(adminStore,audits=[]){
  const spooler=new FakeSpooler();
  const service=new PrinterService({store:adminStore,transports:{[spooler.id]:spooler,'elgin-e1':new ElginTransport(),browser:new BrowserFallbackTransport()},audit:async e=>{audits.push(e);},log:{warn(){},error(){},info(){}}});
  return {service,spooler,audits};
}
module.exports={FakeSpooler,fakePrinting};
