'use strict';
// Priority 1 for the Elgin i9 (USB): the Windows print queue, chosen by name and driven by the Node backend, with no
// browser dialog and no COM port (the printer's virtual serial port is off, and the scale's COM is never touched).
// Windows PowerShell does the two things Node cannot do without a native module: list the queues (Win32_Printer) and
// hand bytes to the spooler as a RAW document (winspool.drv). The scripts are src/printing/scripts/*.ps1; the queue
// name, the document name and the bytes go in environment variables, so nothing typed or stored is ever part of a command.
// What "sent" means: the spooler accepted the document. Whether paper came out depends on the printer (off, no paper,
// cover open), which the spooler may report only later: the PDV tells the person so and never promises the print.
const {execFile}=require('node:child_process');const path=require('node:path');
const SCRIPTS=path.join(__dirname,'..','scripts');
const MAX_BYTES=60000;
const posix=process.platform!=='win32';
const powershell=()=>path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
function defaultRun(file,args,{env,timeout}){
  return new Promise((resolve,reject)=>{
    execFile(file,args,{env,timeout,windowsHide:true,maxBuffer:4*1024*1024,encoding:'utf8'},(error,stdout,stderr)=>{
      if(error&&!stdout)return reject(Object.assign(error,{stderr}));
      resolve({stdout:String(stdout||''),stderr:String(stderr||''),code:error?.code??0});
    });
  });
}
// Win32 error codes the person can act on.
const WIN32={5:'O Windows negou o acesso à impressora para esta conta.',1801:'Nome de impressora inválido. Escolha a fila de novo.',1722:'O serviço de impressão do Windows não respondeu.',
  1796:'O serviço de impressão do Windows não respondeu.',3012:'A fila de impressão não está disponível.',1:'O Windows recusou a operação.'};
const MESSAGES={
  open_failed:(w)=>w===1801||w===1804?'A impressora não foi encontrada no Windows. Confira o nome da fila (Buscar impressoras).':w===1722||w===1796?'O serviço de impressão do Windows (Spooler) não está respondendo.':(WIN32[w]||'Não foi possível abrir a fila de impressão no Windows.'),
  start_failed:()=> 'O Windows não aceitou o documento. A impressora pode estar desligada, desconectada ou sem driver.',
  write_failed:()=> 'O Windows não aceitou todos os dados da impressão.',
  bad_input:()=> 'Dados de impressão inválidos.',
  list_failed:()=> 'Não foi possível consultar as impressoras do Windows.'
};
const PRINTER_STATE={1:'pausada',2:'erro',4:'excluindo',8:'papel preso',16:'sem papel',32:'alimentação manual',64:'problema de papel',128:'offline',256:'e/s ativa',512:'ocupada',1024:'imprimindo',2048:'saída cheia',4096:'indisponível',8192:'aguardando',16384:'processando',32768:'inicializando',65536:'aquecendo',131072:'pouco toner',262144:'sem toner',524288:'página incorreta',1048576:'intervenção do usuário',2097152:'sem memória',4194304:'porta aberta'};
function describeState(p){
  if(p.offline)return {code:'offline',label:'Desligada ou desconectada (offline no Windows)'};
  const bits=Object.keys(PRINTER_STATE).map(Number).filter(b=>(Number(p.state)&b)===b&&b!==1024&&b!==512&&b!==8192&&b!==16384&&b!==256);
  if(bits.length)return {code:'attention',label:`Atenção: ${bits.map(b=>PRINTER_STATE[b]).join(', ')}`};
  if(Number(p.status)===7)return {code:'offline',label:'Desligada ou desconectada (offline no Windows)'};
  if(Number(p.status)===2)return {code:'error',label:'Com erro no Windows'};
  return {code:'ready',label:'Pronta (segundo o Windows)'};
}
class WindowsSpoolerTransport {
  // run: how a program is started (tests replace it). platform: 'win32' in production.
  constructor({run=defaultRun,platform=process.platform,timeoutMs=20000}={}){Object.assign(this,{run,platform,timeoutMs});this.id='windows-spooler';this.label='Fila de impressão do Windows (spooler)';this.escpos=true;}
  supported(){return this.platform==='win32';}
  unsupportedError(){return Object.assign(Error('A impressão pela fila do Windows só funciona no Windows.'),{code:'unsupported'});}
  async exec(script,env){
    if(!this.supported())throw this.unsupportedError();
    let r;
    try{r=await this.run(powershell(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(SCRIPTS,script)],{env:{...process.env,...env},timeout:this.timeoutMs});}
    catch(e){
      if(e.code==='ENOENT')throw Object.assign(Error('O Windows PowerShell não foi encontrado neste computador.'),{code:'no_powershell'});
      if(e.killed||e.signal||e.code==='ETIMEDOUT')throw Object.assign(Error('O Windows demorou demais para responder (serviço de impressão parado ou travado).'),{code:'timeout',ambiguous:script==='spool-raw.ps1'});
      throw Object.assign(Error(`Falha ao executar a impressão: ${String(e.message||e).slice(0,160)}`),{code:'exec_failed'});
    }
    let json;
    try{json=JSON.parse(String(r.stdout||'').trim().split(/\r?\n/).filter(Boolean).pop()||'');}catch(_){json=null;}
    if(!json)throw Object.assign(Error('Resposta inesperada do Windows ao imprimir.'),{code:'bad_response'});
    return json;
  }
  // [{name,default,status:{code,label},driver,port}] and the state of the print service.
  async listPrinters(){
    const j=await this.exec('list-printers.ps1',{});
    if(!j.ok)throw Object.assign(Error(MESSAGES.list_failed()),{code:j.code||'list_failed'});
    const spooler=String(j.spooler||'');
    return {spooler,spoolerRunning:/^running$/i.test(spooler)||spooler==='4',user:j.user||null,
      printers:[].concat(j.printers||[]).map(p=>({name:String(p.name),default:!!p.default,driver:String(p.driver||''),port:String(p.port||''),status:describeState(p)})).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'))};
  }
  async getStatus(name){
    const r=await this.listPrinters();
    if(!r.spoolerRunning)return {code:'spooler',label:'O serviço de impressão do Windows (Spooler) não está em execução.',spooler:r.spooler};
    const p=r.printers.find(x=>x.name===name);
    if(!p)return {code:'missing',label:`A fila "${name}" não aparece para a conta que executa o PDV (${r.user||'?'}). Se a impressora foi instalada só no seu usuário, instale-a para todos os usuários.`};
    return {code:p.status.code,label:p.status.label,port:p.port,driver:p.driver};
  }
  // The spooler accepts the document or this throws (with .ambiguous when we cannot know whether it was accepted).
  async send({printer,bytes,jobName='Luminor PDV'}){
    if(!printer||typeof printer!=='string')throw Object.assign(Error('Nenhuma impressora escolhida.'),{code:'no_printer'});
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)throw Object.assign(Error('Dados de impressão inválidos.'),{code:'bad_input'});
    const j=await this.exec('spool-raw.ps1',{LUMINOR_PRINTER:printer,LUMINOR_JOB:String(jobName).slice(0,80),LUMINOR_DATA:bytes.toString('base64')});
    if(!j.ok)throw Object.assign(Error((MESSAGES[j.code]||MESSAGES.write_failed)(Number(j.win32)||0)),{code:j.code||'write_failed',win32:j.win32});
    return {spoolJobId:Number(j.jobId)||null,bytes:j.bytes};
  }
}
module.exports={WindowsSpoolerTransport,describeState,MESSAGES,powershell};
