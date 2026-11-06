'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {Store}=require('./db');const {ScaleDriver}=require('./scale');
const HOST='127.0.0.1';
const WEB=path.resolve(__dirname,'../public');
const STATIC=['/app.js','/style.css','/logo.svg','/fonts/work-sans.woff2'];
function send(res,status,payload){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload));}
function fail(res,status,error){send(res,status,{error});}
async function readBody(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>20000)throw Error('Requisição muito grande');}try{return JSON.parse(text||'{}');}catch(_){throw Error('JSON inválido');}}
function serve(res,filename){
  const full=path.join(WEB,filename);
  const mime=filename.endsWith('.css')?'text/css; charset=utf-8':filename.endsWith('.js')?'application/javascript; charset=utf-8':filename.endsWith('.svg')?'image/svg+xml':filename.endsWith('.woff2')?'font/woff2':'text/html; charset=utf-8';
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'"});
  fs.createReadStream(full).pipe(res);
}
function createServer({db,scale}){
  const token=randomBytes(24).toString('hex');let lastAutoError='';
  // Weighings that could not be stored wait here for an explicit retry or discard; they are never dropped silently.
  let pending=[];
  // One scale cycle goes to exactly one open sale. Node runs this to completion, so the destination can't change
  // between reading the active sale and storing the weighing.
  function capture(reading,saleId){
    try{const sale=db.addWeighed(saleId,reading.grams,reading.captureId);scale.consume();return sale;}
    catch(err){
      scale.consume();let label='';try{label=db.draftRow(saleId)?.label||'';}catch(_){}
      pending=[...pending.filter(p=>p.captureId!==reading.captureId),{...reading,saleId,label,error:err.message,at:new Date().toISOString()}];
      throw err;
    }
  }
  function takePending(captureId){const p=pending.find(x=>x.captureId===captureId);if(!p)throw Error('Pesagem pendente não encontrada');return p;}
  // The weighing destination only changes with nothing on the plate, so a cup placed for one customer can't
  // finish its weighing in another customer's sale.
  function guardSwitch(){if(!scale.idle())throw Error('Retire o produto da balança para trocar de venda.');}
  scale.onReady=()=>{
    if(!db.getConfig().autoCapture||!db.shift())return;
    // Checked before consuming, so with the shift closed or auto-capture off the reading waits on the scale.
    const reading=scale.peek();const saleId=db.activeSaleId();if(!reading||!saleId)return;
    try{capture(reading,saleId);lastAutoError='';}catch(err){lastAutoError=err.message;}
  };
  async function router(req,res){
    const url=new URL(req.url,`http://${HOST}`);const pathname=url.pathname;const q=Object.fromEntries(url.searchParams);
    if(req.method==='GET' && pathname==='/')return serve(res,'index.html');
    if(req.method==='GET' && STATIC.includes(pathname))return serve(res,pathname.slice(1));
    if(req.method==='GET' && pathname==='/api/session')return send(res,200,{token});
    if(req.method==='GET' && pathname==='/api/state')return send(res,200,{...db.getState(scale),canSwitch:scale.idle(),pendingCaptures:pending,lastAutoError});
    if(req.method==='GET' && pathname==='/api/open-sales')return send(res,200,{activeSaleId:db.activeSaleId(),sales:db.listDraftSales()});
    if(req.method==='GET' && pathname==='/api/report')return send(res,200,db.report({period:q.period,date:q.date}));
    if(req.method==='GET' && pathname==='/api/sales')return send(res,200,db.salesHistory(q));
    if(req.method==='GET' && pathname==='/api/sales/detail')return send(res,200,db.saleDetail(q.id));
    if(req.method==='GET' && pathname==='/api/scale/ports'){
      try{return send(res,200,{ports:await scale.ports()});}catch(e){return fail(res,400,e.message);}
    }
    if(req.method!=='POST'||!pathname.startsWith('/api/'))return fail(res,404,'Endereço não encontrado');
    if(req.headers['x-luminor-token']!==token)return fail(res,403,'Sessão de segurança inválida');
    const b=await readBody(req);
    let result;
    switch(pathname){
      case '/api/config':result=db.updateConfig(b);break;
      case '/api/operator':result=db.setOperator(b.id);break;
      case '/api/employees/save':result=db.saveEmployee(b);break;
      case '/api/employees/remove':result=db.removeEmployee(b.id);break;
      case '/api/shift/open':result=db.openShift(b.opening,b.operatorId);break;
      case '/api/shift/move':result=db.moveCash(b.kind,b.amount,b.note);break;
      case '/api/shift/close':result=db.closeShift(b.counted);break;
      case '/api/products/save':result=db.product(b);break;
      case '/api/products/remove':result=db.deleteProduct(b.id);break;
      case '/api/open-sales/create':guardSwitch();result=db.createDraftSale();break;
      case '/api/open-sales/select':if(b.saleId!==db.activeSaleId())guardSwitch();result=db.selectDraftSale(b.saleId);break;
      case '/api/open-sales/rename':result=db.renameDraftSale(b.saleId,b.label);break;
      case '/api/open-sales/discard':result=db.discardDraftSale(b.saleId);break;
      case '/api/open-sales/transfer-item':result=db.transferDraftSaleItem(b.saleId,b.key,b.toSaleId);break;
      case '/api/cart/unit':result=db.addUnit(b.saleId,b.id,b.quantity);break;
      case '/api/cart/weight':{
        if(!db.shift())throw Error('Abra o caixa primeiro');
        if(b.saleId!==db.activeSaleId())throw Error('A balança está pesando para outra venda. Selecione esta venda antes de lançar o peso.');
        const reading=scale.peek();if(!reading)throw Error('Aguarde um peso estável e novo ciclo de pesagem');
        result=capture(reading,b.saleId);lastAutoError='';break;
      }
      case '/api/cart/manual-weight':result=db.addManualWeight(b.saleId,b.weight);break;
      case '/api/cart/manual-value':result=db.addManualValue(b.saleId,b.amount);break;
      case '/api/cart/quantity':result=db.setQuantity(b.saleId,b.key,b.quantity);break;
      case '/api/cart/remove':result=db.removeDraftSaleItem(b.saleId,b.key);break;
      case '/api/checkout':result=db.checkoutDraftSale(b.saleId,b.method,b.uuid,b.received,b.revision);break;
      case '/api/sales/cancel':result=db.cancelSale(b.id,b.reason);break;
      case '/api/sales/correct':result=db.correctSale(b.id,b.reason,{select:scale.idle()});break;
      case '/api/scale/pending/retry':{
        const p=takePending(b.captureId);
        try{result=db.addWeighed(p.saleId,p.grams,p.captureId);}catch(err){p.error=err.message;throw err;}
        pending=pending.filter(x=>x!==p);lastAutoError='';break;
      }
      case '/api/scale/pending/discard':{const p=takePending(b.captureId);pending=pending.filter(x=>x!==p);console.warn(`Pesagem pendente descartada: ${p.grams} g (${p.label||p.saleId})`);result=true;break;}
      case '/api/scale/demo':result=scale.demo();lastAutoError='';break;
      case '/api/scale/demo-weight':result=scale.setDemoGrams(Number(b.grams));break;
      case '/api/scale/connect':result=await scale.connect(b.path,b.baudRate||2400);lastAutoError='';break;
      case '/api/scale/disconnect':scale.disconnect();result=scale.snapshot();break;
      default:return fail(res,404,'Operação não encontrada');
    }
    send(res,200,{ok:true,result});
  }
  const server=http.createServer((req,res)=>{
    const port=server.address()?.port;
    if(req.headers.host&&![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return fail(res,403,'Host não permitido');
    router(req,res).catch(e=>{console.error(e);fail(res,400,e.message||'Falha interna');});
  });
  return server;
}
if(require.main===module){
  const PORT=Number(process.env.PORT||3187);
  const db=new Store(process.env.LUMINOR_DATA_DIR ? path.join(process.env.LUMINOR_DATA_DIR,'luminor-pdv.sqlite') : undefined);const scale=new ScaleDriver();
  const server=createServer({db,scale});
  server.listen(PORT,HOST,()=>console.log(`\nLuminor PDV iniciado em http://${HOST}:${PORT}\nModo demonstração disponível sem balança.\n`));
  function stop(){scale.disconnect();server.close(()=>{db.close();process.exit(0);});}
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
module.exports={createServer};
