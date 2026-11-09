'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const {randomBytes}=require('node:crypto');
const HOST='127.0.0.1';
const WEB=path.resolve(__dirname,'../public');
const STATIC=['/app.js','/product-filter.js','/style.css','/admin.js','/admin.css','/logo.svg','/favicon.ico','/fonts/work-sans.woff2'];
const SECURITY={'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY'};
function send(res,status,payload,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY,...headers});res.end(JSON.stringify(payload));}
function fail(res,status,error,extra={}){send(res,status,{error,...extra});}
async function readBody(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>20000)throw Error('Requisição muito grande');}try{return JSON.parse(text||'{}');}catch(_){throw Error('JSON inválido');}}
function serve(res,filename){
  const full=path.join(WEB,filename);
  const mime=filename.endsWith('.css')?'text/css; charset=utf-8':filename.endsWith('.js')?'application/javascript; charset=utf-8':filename.endsWith('.svg')?'image/svg+xml':filename.endsWith('.ico')?'image/x-icon':filename.endsWith('.woff2')?'font/woff2':'text/html; charset=utf-8';
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store',...SECURITY,'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'"});
  fs.createReadStream(full).pipe(res);
}
// system (optional, absent in the online demo): the Admin area (/api/admin/*), backups, maintenance pauses.
function createServer({db,scale,system=null}){
  const token=randomBytes(24).toString('hex');let lastAutoError='';
  // Weighings that could not be stored wait here for an explicit retry or discard; they are never dropped silently.
  let pending=[];let capturing=false;
  // One scale cycle goes to exactly one open sale: the store reads the sale on the scale and stores the weighing in
  // the same step, so the destination can't change in between.
  async function capture(reading,saleId=null){
    try{const sale=await db.captureWeighing(reading,saleId);scale.consume();return sale;}
    catch(err){
      scale.consume();
      pending=[...pending.filter(p=>p.captureId!==reading.captureId),{...reading,saleId:err.saleId??saleId,label:err.saleLabel||'',error:err.message,at:new Date().toISOString()}];
      throw err;
    }
  }
  function takePending(captureId){const p=pending.find(x=>x.captureId===captureId);if(!p)throw Error('Pesagem pendente não encontrada');return p;}
  // The weighing destination only changes with nothing on the plate, so a cup placed for one customer can't
  // finish its weighing in another customer's sale.
  function guardSwitch(){if(!scale.idle())throw Error('Retire o produto da balança para trocar de venda.');}
  const maintenance=()=>system?.maintenance?.()||null;
  // After a restore the pending weighings belong to data that is gone.
  if(system)system.onRestored=()=>{pending=[];lastAutoError='';};
  scale.onReady=async()=>{
    // One capture at a time; while a restore replaces the database nothing is captured.
    if(capturing||maintenance())return;capturing=true;
    try{
      const config=await db.getConfig();if(!config.autoCapture||!(await db.shift()))return;
      // Checked before consuming, so with the shift closed or auto-capture off the reading waits on the scale.
      const reading=scale.peek();if(!reading)return;
      try{await capture(reading);lastAutoError='';}catch(err){lastAutoError=err.message;}
    }catch(err){lastAutoError=err.message;}
    finally{capturing=false;}
  };
  async function router(req,res){
    const url=new URL(req.url,`http://${HOST}`);const pathname=url.pathname;const q=Object.fromEntries(url.searchParams);
    if(req.method==='GET' && pathname==='/')return serve(res,'index.html');
    if(req.method==='GET' && STATIC.includes(pathname))return serve(res,pathname.slice(1));
    if(req.method==='GET' && pathname==='/api/health')return send(res,200,{ok:!maintenance()&&!db.adapter.unavailable,version:system?.version||null,maintenance:maintenance(),database:db.adapter.unavailable?'indisponivel':db.adapter.dialect});
    if(req.method==='GET' && pathname==='/api/session')return send(res,200,{token});
    if(pathname.startsWith('/api/admin/')){
      if(!system)return fail(res,404,'A área de administração não existe na demonstração online.',{demo:true});
      return system.handle(req,res,{url,q,token,send,fail,readBody});
    }
    if(maintenance()&&pathname.startsWith('/api/'))return fail(res,503,maintenance(),{maintenance:true});
    if(req.method==='GET' && pathname==='/api/state')return send(res,200,{...await db.getState(scale),canSwitch:scale.idle(),pendingCaptures:pending,lastAutoError,system:system?await system.brief():null});
    if(req.method==='GET' && pathname==='/api/open-sales')return send(res,200,{activeSaleId:await db.activeSaleId(),sales:await db.listDraftSales()});
    if(req.method==='GET' && pathname==='/api/report')return send(res,200,await db.report({period:q.period,date:q.date}));
    if(req.method==='GET' && pathname==='/api/sales')return send(res,200,await db.salesHistory(q));
    if(req.method==='GET' && pathname==='/api/sales/detail')return send(res,200,await db.saleDetail(q.id));
    if(req.method==='GET' && pathname==='/api/scale/ports'){
      try{return send(res,200,{ports:await scale.ports()});}catch(e){return fail(res,400,e.message);}
    }
    if(req.method!=='POST'||!pathname.startsWith('/api/'))return fail(res,404,'Endereço não encontrado');
    if(req.headers['x-luminor-token']!==token)return fail(res,403,'Sessão de segurança inválida');
    const b=await readBody(req);
    let result;
    switch(pathname){
      case '/api/config':result=await db.updateConfig(b);break;
      case '/api/operator':result=await db.setOperator(b.id);break;
      case '/api/employees/save':result=await db.saveEmployee(b);break;
      case '/api/employees/remove':result=await db.removeEmployee(b.id);break;
      case '/api/shift/open':result=await db.openShift(b.opening,b.operatorId);break;
      case '/api/shift/move':result=await db.moveCash(b.kind,b.amount,b.note);break;
      case '/api/shift/close':result=await db.closeShift(b.counted);if(system)system.afterShiftClose();break;
      case '/api/products/save':result=await db.product(b);break;
      case '/api/products/favorite':result=await db.favoriteProduct(b.id,b.favorite);break;
      case '/api/products/remove':result=await db.deleteProduct(b.id);break;
      case '/api/open-sales/create':guardSwitch();result=await db.createDraftSale();break;
      case '/api/open-sales/select':if(b.saleId!==await db.activeSaleId())guardSwitch();result=await db.selectDraftSale(b.saleId);break;
      case '/api/open-sales/rename':result=await db.renameDraftSale(b.saleId,b.label);break;
      case '/api/open-sales/discard':result=await db.discardDraftSale(b.saleId);break;
      case '/api/open-sales/transfer-item':result=await db.transferDraftSaleItem(b.saleId,b.key,b.toSaleId);break;
      case '/api/cart/unit':result=await db.addUnit(b.saleId,b.id,b.quantity);break;
      case '/api/cart/weight':{
        if(!(await db.shift()))throw Error('Abra o caixa primeiro');
        if(b.saleId!==await db.activeSaleId())throw Error('A balança está pesando para outra venda. Selecione esta venda antes de lançar o peso.');
        const reading=scale.peek();if(!reading)throw Error('Aguarde um peso estável e novo ciclo de pesagem');
        result=await capture(reading,b.saleId);lastAutoError='';break;
      }
      case '/api/cart/manual-weight':result=await db.addManualWeight(b.saleId,b.weight);break;
      case '/api/cart/manual-value':result=await db.addManualValue(b.saleId,b.amount);break;
      case '/api/cart/quantity':result=await db.setQuantity(b.saleId,b.key,b.quantity);break;
      case '/api/cart/remove':result=await db.removeDraftSaleItem(b.saleId,b.key);break;
      case '/api/checkout':result=await db.checkoutDraftSale(b.saleId,b.method,b.uuid,b.received,b.revision);break;
      case '/api/sales/cancel':result=await db.cancelSale(b.id,b.reason);break;
      case '/api/sales/correct':result=await db.correctSale(b.id,b.reason,{select:scale.idle()});break;
      case '/api/scale/pending/retry':{
        const p=takePending(b.captureId);
        try{result=await db.addWeighed(p.saleId,p.grams,p.captureId);}catch(err){p.error=err.message;throw err;}
        pending=pending.filter(x=>x!==p);lastAutoError='';break;
      }
      case '/api/scale/pending/discard':{const p=takePending(b.captureId);pending=pending.filter(x=>x!==p);console.warn(`Pesagem pendente descartada: ${p.grams} g (${p.label||p.saleId})`);result=true;break;}
      case '/api/scale/demo':result=scale.demo();lastAutoError='';break;
      case '/api/scale/demo-weight':result=scale.setDemoGrams(Number(b.grams));break;
      case '/api/scale/connect':result=await scale.connect(b.path,b.baudRate||2400);lastAutoError='';if(system)system.rememberScale(b.path,b.baudRate||2400);break;
      case '/api/scale/disconnect':scale.disconnect();result=scale.snapshot();if(system)system.rememberScale(null);break;
      default:return fail(res,404,'Operação não encontrada');
    }
    // Lets the auto-capture finish before answering, so the next request sees its result.
    await settle();
    send(res,200,{ok:true,result});
  }
  async function settle(){for(let i=0;i<200&&capturing;i++)await new Promise(r=>setTimeout(r,2));}
  const server=http.createServer((req,res)=>{
    const port=server.address()?.port;
    if(req.headers.host&&![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))return fail(res,403,'Host não permitido');
    // e.expose: fields the screen needs to decide what to ask next (for example, to confirm a replacement).
    router(req,res).catch(e=>{if(!e.status||e.status>=500)console.error(e);if(!res.headersSent)fail(res,e.status||400,e.message||'Falha interna',e.expose||{});});
  });
  server.settle=settle;
  return server;
}
module.exports={createServer,send,fail,readBody,HOST};
// `node src/server.js` (the command used up to v0.1) starts the PDV the same way as `npm start`.
if(require.main===module)require('./main').start().catch(e=>{console.error(`Não foi possível iniciar o Luminor PDV: ${e.message}`);process.exit(e.code==='EADDRINUSE'?3:1);});
