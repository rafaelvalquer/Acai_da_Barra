'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const {randomBytes}=require('node:crypto');
const Authz=require('./auth/AuthorizationService');const Policy=require('./auth/CashVisibilityPolicy');
const {readMoney}=require('./protocol');
// The amount of a movement for the log (already accepted by the store, so it parses).
const readCents=v=>{try{return readMoney(v);}catch(_){return null;}};
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
// Who may call each operation of the till (src/auth/PermissionCatalog.js). A route that is not here does not exist.
// Every route needs a signed-in, unlocked session; the permission is checked before anything runs.
const GET_ROUTES={
  '/api/state':null,                       // any session; what it shows depends on the permissions
  '/api/open-sales':'screen.vendas',
  '/api/report':'reports.view',
  '/api/sales':'screen.historico',
  '/api/sales/detail':'screen.historico',
  // The close's own report and history: who may read which close is decided inside (own closes, or the history permission).
  '/api/shift/closings':'cash.reconciliation.view_confirmed','/api/shift/closings/report':'cash.reconciliation.view_confirmed','/api/shift/closings/print-status':'cash.reconciliation.view_confirmed',
  '/api/shift/closings/revisions':'cash.reconciliation.view_revisions',
  '/api/scale/ports':'scale.manage'
};
const POST_ROUTES={
  '/api/config':'config.manage',
  '/api/operator':null,                    // tells who is signed in; never changes it
  '/api/employees/save':'employees.manage','/api/employees/remove':'employees.manage',
  '/api/shift/open':'cash.open','/api/shift/move':'cash.move','/api/shift/close':'cash.close','/api/shift/close/begin':'cash.close',
  '/api/shift/closings/print':'cash.reconciliation.view_confirmed','/api/shift/closings/reopen':'cash.reconciliation.reopen','/api/shift/closings/correct':'cash.reconciliation.correct',
  '/api/products/save':'products.manage','/api/products/favorite':'products.manage','/api/products/remove':'products.manage',
  '/api/open-sales/create':'sales.create','/api/open-sales/select':'sales.create','/api/open-sales/rename':'sales.create',
  '/api/open-sales/discard':'sales.discard','/api/open-sales/transfer-item':'sales.transfer',
  '/api/cart/unit':'sales.create','/api/cart/weight':'sales.create','/api/cart/quantity':'sales.create','/api/cart/remove':'sales.create',
  '/api/cart/manual-weight':'sales.manual_weight','/api/cart/manual-value':'sales.manual_value',
  '/api/checkout':'sales.checkout','/api/sales/cancel':'sales.cancel','/api/sales/correct':'sales.correct',
  '/api/scale/pending/retry':'sales.create','/api/scale/pending/discard':'sales.create',
  '/api/scale/connect':'scale.manage','/api/scale/disconnect':'scale.manage',
  '/api/scale/demo':'simulator','/api/scale/demo-weight':'simulator'
};
// What the till screen receives: only what this person may see, computed from the state the store keeps (never
// changed here: every part is a new object).
function visibleState(state,identity,{brief}){
  const strict={strict:state.strictBlind!==false};
  const can=p=>Authz.hasPermission(identity,p);const selling=can('screen.vendas');
  return {config:state.config,cash:Policy.cash(state.cash,identity,strict),
    openSales:selling||can('screen.caixa')?state.openSales:[],activeSaleId:selling?state.activeSaleId:null,activeSale:selling?state.activeSale:null,
    cart:selling?state.cart:[],cartTotalCents:selling?state.cartTotalCents:0,
    products:selling||can('products.view')||can('products.manage')?state.products:[],
    employees:can('employees.manage')?state.employees:[],
    scale:state.scale,operator:{id:identity.employeeId,name:identity.name,kind:identity.kind},
    // The backup warnings (the dot on Configurações) for whoever sees that screen; the details stay in the Admin area.
    system:brief?(identity.kind==='admin'?brief:{version:brief.version,maintenance:brief.maintenance,database:brief.database,sync:brief.sync,alert:can('screen.configuracoes')?brief.alert:null}):null};
}
// db: the store. scale: the scale driver. auth: who is at the till (src/auth/PosAuth.js, or the demo's own), required:
// without it nothing would be protected, so the server does not start. system (optional, absent in the online
// demo): the Admin area (/api/admin/*), backups, maintenance pauses.
// simulator: the scale simulator (/api/scale/demo*): 'off' (default), 'admin' (only with scale.manage; set
// PDV_SCALE_SIMULATOR=true to try the till without a scale) or 'open' (the online demo and the tests).
function createServer({db,scale,system=null,auth,simulator=process.env.PDV_SCALE_SIMULATOR==='true'?'admin':'off',printing=null}){
  if(!auth||typeof auth.identify!=='function')throw Error('O servidor do PDV precisa da autenticação do caixa.');
  const PosAuthView=auth.constructor.view||auth.view;const actorOf=auth.constructor.actor||auth.actor;
  const token=randomBytes(24).toString('hex');let lastAutoError='';
  // Weighings that could not be stored wait here for an explicit retry or discard; they are never dropped silently.
  let pending=[];let capturing=false;
  // One scale cycle goes to exactly one open sale: the store reads the sale on the scale and stores the weighing in
  // the same step, so the destination can't change in between.
  async function capture(reading,saleId,actor){
    try{const sale=await db.as(actor).captureWeighing(reading,saleId);scale.consume();return sale;}
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
  printing=system?.printing||printing;
  const maintenance=()=>system?.maintenance?.()||null;
  const audit=e=>Promise.resolve(auth.audit?.(e)).catch(()=>{});
  const who=identity=>identity.kind==='admin'?identity.username:identity.name;
  // Refused operations go to the administrative log, at most once a minute for the same person and permission.
  const deniedAt=new Map();
  function denied(identity,permission,route){
    const k=`${identity.key}|${permission}`;const now=Date.now();if((deniedAt.get(k)||0)>now-60000)return;
    deniedAt.set(k,now);if(deniedAt.size>500)deniedAt.delete(deniedAt.keys().next().value);
    audit({username:who(identity),action:'acesso_negado',ok:false,detail:{permissao:permission,rota:route}});
  }
  // After a restore the pending weighings belong to data that is gone.
  if(system)system.onRestored=()=>{pending=[];lastAutoError='';};
  // Automatic capture only for someone signed in who may put items in a sale. Otherwise (nobody signed in, the till
  // locked) the reading stays on the scale and goes in when that person types the PIN again: nothing is lost, and the
  // cycle id keeps it from going in twice.
  scale.onReady=async()=>{
    if(capturing||maintenance())return;capturing=true;
    try{
      const actor=await auth.terminalActor();if(!actor)return;
      const config=await db.getConfig();if(!config.autoCapture||!(await db.shift()))return;
      // Checked before consuming, so with the shift closed or auto-capture off the reading waits on the scale.
      const reading=scale.peek();if(!reading)return;
      try{await capture(reading,null,actor);lastAutoError='';}catch(err){lastAutoError=err.message;}
    }catch(err){lastAutoError=err.message;}
    finally{capturing=false;}
  };
  // The person of this request, checked for the permission (null: any signed-in, unlocked session).
  async function allowed(req,route,permission,{touch=true}={}){
    const identity=await auth.identify(req,{touch});
    try{
      if(permission==='simulator'){
        if(simulator==='off')throw Authz.httpError(403,'O simulador da balança está desligado neste computador.');
        if(simulator==='admin')Authz.requirePermission(identity,'scale.manage');else Authz.requireAuthentication(identity);
      }else if(permission)Authz.requirePermission(identity,permission);
      else Authz.requireAuthentication(identity);
    }catch(e){if(e.status===403&&identity&&!identity.locked)denied(identity,permission,route);throw e;}
    return identity;
  }
  const cookies=list=>({'Set-Cookie':list});
  async function authRoutes(req,res,pathname){
    if(req.method==='GET'&&pathname==='/api/auth/session')return send(res,200,PosAuthView(await auth.identify(req,{touch:false})));
    if(req.method==='GET'&&pathname==='/api/auth/options')return send(res,200,{operators:await auth.options(),admin:!!system||!!auth.demo,demo:auth.demo||null});
    if(req.method!=='POST')return fail(res,404,'Endereço não encontrado');
    if(req.headers['x-luminor-token']!==token)return fail(res,403,'Sessão de segurança inválida');
    const b=await readBody(req);
    if(pathname==='/api/auth/login'){const r=await auth.login(b,{scaleIdle:scale.idle(),userAgent:String(req.headers['user-agent']||'')});return send(res,200,{ok:true,result:{session:r.session,mustChangePassword:!!r.mustChangePassword}},cookies(r.cookies));}
    if(pathname==='/api/auth/logout'){const r=await auth.logout(req,{scaleIdle:scale.idle()});return send(res,200,{ok:true,result:{session:{authenticated:false}}},cookies(r.cookies));}
    if(pathname==='/api/auth/lock'){const r=await auth.lock(req);return send(res,200,{ok:true,result:{session:r.session}},cookies(r.cookies));}
    return fail(res,404,'Operação não encontrada');
  }
  // —— the close's report, history and printing ——
  // A refused read or print of a close: logged (once a minute per person and permission) and answered with 403.
  function need(identity,permission,route){
    if(Authz.hasPermission(identity,permission))return;
    denied(identity,permission,route);throw Authz.httpError(403,Authz.DENIED,{permission,needsAdmin:true});
  }
  // Whether this person may read this close: the administrator always; someone with the report permission only the
  // close of their own shift, or any close with the history permission. Superseded revisions and a close under
  // correction are for those who may see the revisions.
  function mayRead(identity,rec,route){
    if(identity.kind==='admin')return true;
    need(identity,'cash.reconciliation.view_confirmed',route);
    const own=rec.closedByEmployeeId!==null&&rec.closedByEmployeeId===identity.employeeId;
    if(!own&&!Authz.hasPermission(identity,'cash.view_history')){denied(identity,'cash.view_history',route);throw Authz.httpError(403,Authz.DENIED,{permission:'cash.view_history',needsAdmin:true});}
    if((rec.status==='REOPENED'||rec.superseded)&&!seesRevisions(identity))
      throw Authz.httpError(409,rec.superseded?'Esta é uma versão substituída por uma correção. Peça ao administrador.':'Este fechamento está em correção pelo administrador.',{reopened:true});
    return true;
  }
  const seesRevisions=identity=>Authz.hasPermission(identity,'cash.reconciliation.view_revisions');
  // The reason of a reopening or correction is for those who may see the revisions.
  function shape(identity,rec){
    if(seesRevisions(identity))return rec;
    const {reopen,correctionReason,correctedBy,...rest}=rec;return rest;
  }
  async function loadClosing(identity,route,q){
    const rec=await db.getConfirmedReport({shiftId:q.shiftId,revision:q.revision||null});
    mayRead(identity,rec,route);return rec;
  }
  async function closingsList(identity,route){
    if(identity.kind!=='admin')need(identity,'cash.reconciliation.view_confirmed',route);
    const all=identity.kind==='admin'||Authz.hasPermission(identity,'cash.view_history');
    const rows=await db.listClosings({employeeId:all?null:identity.employeeId});
    const open=seesRevisions(identity)||identity.kind==='admin';
    return {closings:rows.map(r=>open?r:{...r,reopened:false,status:r.status==='REOPENED'?'CONFIRMED':r.status})};
  }
  async function closingReport(identity,route,q){
    const rec=await loadClosing(identity,route,q);
    return {report:shape(identity,rec),print:await printInfo(identity,rec)};
  }
  const printJob=j=>({kind:j.kind,status:j.status,requestedAt:j.requested_at,submittedAt:j.submitted_at,attempts:j.attempts,lastError:j.last_error,ambiguous:j.ambiguous,requestedBy:j.requested_by,printer:j.printer,auto:j.auto});
  async function printInfo(identity,rec){
    if(!printing)return {available:false};
    const canPrint=Authz.hasPermission(identity,'cash.reconciliation.print'),canReprint=Authz.hasPermission(identity,'cash.reconciliation.reprint');
    const s=await printing.getSettings();const jobs=canPrint||canReprint?await printing.jobsFor(rec.uuid):[];
    return {available:true,configured:s.transport==='browser'||!!s.printerName,transport:s.transport,autoPrint:s.autoPrint,canPrint,canReprint,jobs:jobs.map(printJob)};
  }
  async function printStatus(identity,route,q){
    if(!Authz.hasPermission(identity,'cash.reconciliation.print')&&!Authz.hasPermission(identity,'cash.reconciliation.reprint'))need(identity,'cash.reconciliation.print',route);
    return printInfo(identity,await loadClosing(identity,route,q));
  }
  async function printClosing(identity,route,b,name){
    if(!printing)throw Authz.httpError(501,'A impressão não está disponível nesta versão.');
    const reprint=b.reprint===true;need(identity,reprint?'cash.reconciliation.reprint':'cash.reconciliation.print',route);
    const rec=await loadClosing(identity,route,{shiftId:b.shiftId,revision:b.revision});
    // What goes on paper: the close as saved, without the administrator's notes for someone who may not see them.
    const out=await printing.printClosing(shape(identity,rec),{by:name,reprint,confirmDuplicate:b.confirmDuplicate===true});
    return {print:{ok:out.ok!==false,status:out.status||'SUBMITTED',message:out.message||null,ambiguous:!!out.ambiguous,mode:out.mode||'spooler',text:out.mode==='browser'?out.text:undefined},jobs:(await printing.jobsFor(rec.uuid)).map(printJob)};
  }
  // After the commit: the report for whoever may read it, and the automatic print if it is on. A printing problem never
  // undoes the close: it is only reported.
  async function closeAnswer(identity,r,name){
    const rec=r.reconciliation;
    if(!r.duplicate){
      if(system)system.afterShiftClose();
      await audit({username:name,action:'conferencia_confirmada',detail:{turno:rec.shiftId,revisao:rec.revision,informadoCentavos:Object.fromEntries(rec.items.map(i=>[i.method,i.countedCents])),
        diferencaCentavos:Object.fromEntries(rec.items.map(i=>[i.method,i.differenceCents])),diferencaTotalCentavos:rec.totals.differenceCents}});
      await audit({username:name,action:'caixa_fechado',detail:{turno:rec.shiftId,situacao:rec.totals.status}});
    }
    const seesReport=identity.kind==='admin'||Authz.hasPermission(identity,'cash.reconciliation.view_confirmed');
    const out={shiftId:rec.shiftId,confirmed:true,duplicate:r.duplicate,blind:!seesReport,report:seesReport?shape(identity,rec):null,print:null};
    if(!r.duplicate&&printing&&seesReport){
      try{
        const s=await printing.getSettings();
        if(s.autoPrint&&Authz.hasPermission(identity,'cash.reconciliation.print')){
          const p=await printing.printClosing(shape(identity,rec),{by:name,auto:true});
          out.print={ok:p.ok!==false,status:p.status||'SUBMITTED',message:p.message||null,ambiguous:!!p.ambiguous,mode:p.mode||'spooler',text:p.mode==='browser'?p.text:undefined,auto:true};
        }
      }catch(e){out.print={ok:false,status:'FAILED',message:e.message,auto:true};}
    }
    return out;
  }
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
    // The commercial database out of reach (old cloud mode): nothing at the till can work, signing in included.
    if(db.adapter.unavailable&&pathname.startsWith('/api/')){try{db.adapter.fail();}catch(e){return fail(res,503,e.message,{database:'indisponivel'});}}
    if(pathname.startsWith('/api/auth/'))return authRoutes(req,res,pathname);
    if(req.method==='GET'&&pathname in GET_ROUTES){
      // The screen reads its state every second: that alone does not keep the session alive.
      const identity=await allowed(req,pathname,GET_ROUTES[pathname],{touch:pathname!=='/api/state'});
      const can=p=>Authz.hasPermission(identity,p);
      switch(pathname){
        case '/api/state':return send(res,200,{...visibleState(await db.getState(scale),identity,{brief:system?await system.brief():null}),
          auth:PosAuthView(identity),canSwitch:scale.idle(),pendingCaptures:can('sales.create')?pending:[],lastAutoError:can('sales.create')?lastAutoError:'',
          // Whether this person may use the scale simulator (the card on the Balança screen).
          simulator:simulator==='open'||(simulator==='admin'&&can('scale.manage'))});
        case '/api/open-sales':return send(res,200,{activeSaleId:await db.activeSaleId(),sales:await db.listDraftSales()});
        case '/api/report':return send(res,200,Policy.report(await db.report({period:q.period,date:q.date}),identity,{strict:await db.strictBlind()}));
        case '/api/sales':{
          const filter={q:q.q,from:q.from,to:q.to,status:q.status};
          // Without the reports, only the sales of the open shift.
          if(!can('reports.view'))filter.onlyShift=(await db.shift())?.id||0;
          const history=await db.salesHistory(filter);
          // Whoever may not see the shift's totals gets no payment method of any sale, whatever period they ask for.
          return send(res,200,Policy.salesOfShift(history,identity,{strict:await db.strictBlind()}));
        }
        case '/api/sales/detail':{
          const d=await db.saleDetail(q.id);
          if(!can('reports.view')&&d.shift_id!==(await db.shift())?.id){denied(identity,'reports.view',pathname);throw Authz.httpError(403,Authz.DENIED,{permission:'reports.view',needsAdmin:true});}
          return send(res,200,Policy.salesOfShift(d,identity,{strict:await db.strictBlind()}));
        }
        case '/api/shift/closings':return send(res,200,await closingsList(identity,pathname));
        case '/api/shift/closings/report':return send(res,200,await closingReport(identity,pathname,q));
        case '/api/shift/closings/revisions':return send(res,200,await db.getRevisions({shiftId:q.shiftId}));
        case '/api/shift/closings/print-status':return send(res,200,await printStatus(identity,pathname,q));
        case '/api/scale/ports':try{return send(res,200,{ports:await scale.ports()});}catch(e){return fail(res,400,e.message);}
      }
    }
    if(req.method!=='POST'||!(pathname in POST_ROUTES))return fail(res,404,pathname.startsWith('/api/')&&req.method==='POST'?'Operação não encontrada':'Endereço não encontrado');
    if(req.headers['x-luminor-token']!==token)return fail(res,403,'Sessão de segurança inválida');
    const identity=await allowed(req,pathname,POST_ROUTES[pathname]);
    const b=await readBody(req);
    const store=db.as(actorOf(identity));const name=who(identity);
    let result;
    switch(pathname){
      case '/api/config':{
        const before=await db.getConfig();result=await store.updateConfig(b);
        if(result.priceKgCents!==before.priceKgCents)await audit({username:name,action:'preco_kg_alterado',detail:{deCentavos:before.priceKgCents,paraCentavos:result.priceKgCents}});
        break;
      }
      case '/api/operator':result=PosAuthView(identity);break;
      case '/api/employees/save':result=await store.saveEmployee(b);break;
      case '/api/employees/remove':result=await store.removeEmployee(b.id);await auth.employeeDeactivated?.(b.id);break;
      case '/api/shift/open':result=await store.openShift(b.opening);await audit({username:name,action:'caixa_aberto',detail:{turno:result?.id}});break;
      case '/api/shift/move':{
        const blind=!Policy.seesExpected(identity,{strict:await db.strictBlind()});const summary=await store.moveCash(b.kind,b.amount,b.note,{blind});
        await audit({username:name,action:b.kind==='withdrawal'?'sangria':'suprimento',detail:{turno:summary.shift?.id,valorCentavos:readCents(b.amount),descricao:String(b.note||'').trim().slice(0,180)}});
        result=Policy.moveResult(summary,identity);break;
      }
      case '/api/shift/close':{
        // The full count: the four typed amounts. A single value is the old one-value close (compatibility).
        if(b.counted!==null&&typeof b.counted==='object'){
          need(identity,'cash.reconciliation.confirm',pathname);
          const r=await store.closeShift(b.counted,{shiftId:b.shiftId,idempotencyKey:b.idempotencyKey});
          result=await closeAnswer(identity,r,name);break;
        }
        need(identity,'cash.reconciliation.confirm',pathname);
        const r=await store.closeShift(b.counted,{shiftId:b.shiftId});if(system)system.afterShiftClose();
        await audit({username:name,action:'caixa_fechado',detail:{turno:r.shiftId,situacao:r.status}});
        result=Policy.closeResult(r,identity,{strict:await db.strictBlind()});break;
      }
      case '/api/shift/close/begin':{need(identity,'cash.reconciliation.confirm',pathname);result=await store.beginClose({shiftId:b.shiftId});await audit({username:name,action:'conferencia_iniciada',detail:{turno:result.shiftId}});break;}
      case '/api/shift/closings/print':result=await printClosing(identity,pathname,b,name);break;
      case '/api/shift/closings/reopen':{
        Authz.requireAdmin(identity);await auth.confirmAdminPassword(identity,b.password);
        const r=await store.requestReopen({shiftId:b.shiftId,reason:b.reason});
        await audit({username:name,action:'conferencia_reaberta',detail:{turno:r.shiftId,revisao:r.revision,motivo:String(b.reason||'').trim().slice(0,300)}});
        result={shiftId:r.shiftId,reconciliation:r.reconciliation};break;
      }
      case '/api/shift/closings/correct':{
        Authz.requireAdmin(identity);await auth.confirmAdminPassword(identity,b.password);
        const r=await store.confirmCorrection({shiftId:b.shiftId,idempotencyKey:b.idempotencyKey,counted:b.counted,reason:b.reason});
        if(!r.duplicate)await audit({username:name,action:'conferencia_corrigida',detail:{turno:r.reconciliation.shiftId,revisao:r.reconciliation.revision,motivo:String(b.reason||'').trim().slice(0,300),
          valoresAnterioresCentavos:r.previousCounted,valoresNovosCentavos:Object.fromEntries(r.reconciliation.items.map(i=>[i.method,i.countedCents])),diferencaTotalCentavos:r.reconciliation.totals.differenceCents}});
        result={duplicate:r.duplicate,reconciliation:r.reconciliation};break;
      }
      case '/api/products/save':{
        const before=b.id?(await db.listProducts()).find(p=>p.id===Number(b.id)):null;result=await store.product(b);
        const after=b.id?(await db.listProducts()).find(p=>p.id===Number(b.id)):null;
        if(before&&after&&before.price_cents!==after.price_cents)await audit({username:name,action:'preco_produto_alterado',detail:{produto:after.name,deCentavos:before.price_cents,paraCentavos:after.price_cents}});
        break;
      }
      case '/api/products/favorite':result=await store.favoriteProduct(b.id,b.favorite);break;
      case '/api/products/remove':result=await store.deleteProduct(b.id);break;
      case '/api/open-sales/create':guardSwitch();result=await store.createDraftSale();break;
      case '/api/open-sales/select':if(b.saleId!==await db.activeSaleId())guardSwitch();result=await store.selectDraftSale(b.saleId);break;
      case '/api/open-sales/rename':result=await store.renameDraftSale(b.saleId,b.label);break;
      case '/api/open-sales/discard':result=await store.discardDraftSale(b.saleId);break;
      case '/api/open-sales/transfer-item':result=await store.transferDraftSaleItem(b.saleId,b.key,b.toSaleId);break;
      case '/api/cart/unit':result=await store.addUnit(b.saleId,b.id,b.quantity);break;
      case '/api/cart/weight':{
        if(!(await db.shift()))throw Error('Abra o caixa primeiro');
        if(b.saleId!==await db.activeSaleId())throw Error('A balança está pesando para outra venda. Selecione esta venda antes de lançar o peso.');
        const reading=scale.peek();if(!reading)throw Error('Aguarde um peso estável e novo ciclo de pesagem');
        result=await capture(reading,b.saleId,actorOf(identity));lastAutoError='';break;
      }
      case '/api/cart/manual-weight':result=await store.addManualWeight(b.saleId,b.weight);break;
      case '/api/cart/manual-value':result=await store.addManualValue(b.saleId,b.amount);break;
      case '/api/cart/quantity':result=await store.setQuantity(b.saleId,b.key,b.quantity);break;
      case '/api/cart/remove':result=await store.removeDraftSaleItem(b.saleId,b.key);break;
      case '/api/checkout':result=await store.checkoutDraftSale(b.saleId,b.method,b.uuid,b.received,b.revision,b.payments);
        if(identity.kind==='admin'&&!result.duplicate)await audit({username:name,action:'venda_admin',detail:{venda:result.sale?.id}});break;
      case '/api/sales/cancel':result=await store.cancelSale(b.id,b.reason);await audit({username:name,action:'venda_cancelada',detail:{venda:result.id,motivo:result.cancel_reason}});
        result=Policy.salesOfShift(result,identity,{strict:await db.strictBlind()});break;
      case '/api/sales/correct':result=await store.correctSale(b.id,b.reason,{select:scale.idle()});await audit({username:name,action:'venda_corrigida',detail:{venda:result.sale?.id,motivo:result.sale?.cancel_reason}});
        result={...result,sale:Policy.salesOfShift(result.sale,identity,{strict:await db.strictBlind()})};break;
      case '/api/scale/pending/retry':{
        const p=takePending(b.captureId);
        try{result=await store.addWeighed(p.saleId,p.grams,p.captureId);}catch(err){p.error=err.message;throw err;}
        pending=pending.filter(x=>x!==p);lastAutoError='';break;
      }
      case '/api/scale/pending/discard':{const p=takePending(b.captureId);pending=pending.filter(x=>x!==p);console.warn(`Pesagem pendente descartada: ${p.grams} g (${p.label||p.saleId}) por ${name}`);result=true;break;}
      case '/api/scale/demo':result=scale.demo();lastAutoError='';break;
      case '/api/scale/demo-weight':result=scale.setDemoGrams(Number(b.grams));break;
      case '/api/scale/connect':result=await scale.connect(b.path,b.baudRate||2400);lastAutoError='';if(system)system.rememberScale(b.path,b.baudRate||2400);break;
      case '/api/scale/disconnect':scale.disconnect();result=scale.snapshot();if(system)system.rememberScale(null);break;
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
module.exports={createServer,send,fail,readBody,HOST,GET_ROUTES,POST_ROUTES};
// `node src/server.js` (the command used up to v0.1) starts the PDV the same way as `npm start`.
if(require.main===module)require('./main').start().catch(e=>{console.error(`Não foi possível iniciar o Luminor PDV: ${e.message}`);process.exit(e.code==='EADDRINUSE'?3:1);});
