'use strict';
// Authorization over HTTP on the whole installation (src/main.js: the till, the Admin area, config/admin.sqlite and
// the administrative log together): A08, requests without a session, the administrator's changes in "Usuários e
// permissões" taking effect at once, the till's cookie, and the §9 log without secrets. Uses SQLite (the whole
// installation always does in the tests; PostgreSQL is covered by the other auth test files).
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID,randomBytes}=require('node:crypto');
const app=require('./app-helpers');const {ok}=app;const {testPin,ALL}=require('./pos-helpers');
const {DEFAULTS}=require('../src/auth/PermissionCatalog');const {DENIED}=require('../src/auth/AuthorizationService');
const {GET_ROUTES,POST_ROUTES}=require('../src/server');
const audit=async t=>(await t.app.adminStore.recentAudit(300)).reverse();
const without=(list,...drop)=>list.filter(p=>!drop.includes(p));
// A sale of 500 g paid in cash by whoever is signed in at the till.
async function sell(t){
  const saleId=await app.active(t);ok(await t.post('/api/cart/manual-weight',{saleId,weight:'0,500'}));
  return ok(await t.post('/api/checkout',{saleId,method:'cash',uuid:randomUUID(),received:'100,00'})).sale;
}
// The administrator in the Admin area, while Ana stays signed in at the till (the cookies are kept apart).
async function asAdmin(t,fn){const till=t.pos;await app.adminSession(t);t.pos=till;try{return await fn();}finally{t.pos=till;}}

test('A08 an employee at the till is refused in the Admin area (403), and the attempt is logged',async()=>{
  const t=await app.boot();try{
    await app.setupAdmin(t);const ana=await app.operator(t,'Ana',ALL);
    const adminCookie=t.cookie;await app.signIn(t,'Ana',{keepAdmin:false});
    // The Admin area left open on this computer ended when Ana signed in.
    assert.equal(t.cookie,null);
    for(const route of ['overview','database','backup','diagnostics','access-log','audit','operators','permissions/catalog','operators/audit']){
      const r=await t.get('/api/admin/'+route,null);assert.equal(r.status,403,route);assert.match(r.body.error,/Somente o administrador/);
    }
    // The old Admin cookie does not help either (the session behind it is gone).
    assert.equal((await t.get('/api/admin/overview',adminCookie)).status,403);
    const password=t.adminPassword;
    for(const [route,body] of [['operators/permissions',{employeeId:ana.id,permissions:{'cash.view_expected':false},password}],['operators/credentials',{employeeId:ana.id,pin:testPin(),password}],
      ['operators/disable',{employeeId:ana.id,active:false}],['operators/settings',{blindWithdrawalLimit:'999,00',password}],['backup/export',{}],['pos-session',{}],['database/use-local',{password}],['change-password',{current:password,next:'x'}]]){
      const r=await t.post('/api/admin/'+route,body,null);assert.equal(r.status,403,`${route}: ${JSON.stringify(r.body)}`);
    }
    // Nothing changed: Ana keeps her PIN and permissions, and the limit is the default.
    assert.ok((await t.get('/api/state',null)).body.auth.permissions.includes('cash.view_expected'));
    assert.equal(await t.app.db.blindWithdrawalLimit(),20000);
    const denied=(await audit(t)).filter(a=>a.action==='acesso_negado');
    assert.ok(denied.some(a=>a.username==='Ana'&&a.detail.permissao==='admin'&&a.detail.rota==='/api/admin'&&a.ok===false));
    // The administrator signs in again (the Admin area's own sign-in is never blocked for the employee's presence).
    ok(await app.login(t));assert.equal((await t.get('/api/admin/overview')).status,200);
  }finally{await t.stop();}
});

test('without a session every route of the till answers 401 before anything runs; a locked till answers "locked"',async()=>{
  const t=await app.boot();try{
    await app.setupAdmin(t);await app.operator(t,'Ana',ALL);await app.signIn(t,'Ana',{keepAdmin:false});
    ok(await t.post('/api/shift/open',{opening:'10,00'}));const shift=(await t.app.db.shift()).id;const config=await t.app.db.getConfig();
    const cookie=t.pos;t.pos=null;
    const bodies={'/api/config':{priceKg:'1,00'},'/api/shift/close':{counted:'0,00'},'/api/shift/move':{kind:'withdrawal',amount:'1,00'},'/api/employees/save':{name:'Intruso'},
      '/api/products/save':{name:'Água',price:'1,00',stock:1},'/api/open-sales/create':{}};
    for(const [label,c] of [['sem cookie',null],['cookie inventado',`luminor_pos=${randomBytes(32).toString('base64url')}`]]){
      for(const p of Object.keys(GET_ROUTES)){const r=await t.get(p,c);assert.equal(r.status,401,`${label} ${p}`);assert.equal(r.body.auth,'login');}
      for(const p of Object.keys(POST_ROUTES)){const r=await t.post(p,bodies[p]||{},c);assert.equal(r.status,401,`${label} ${p}: ${JSON.stringify(r.body)}`);assert.equal(r.body.auth,'login');}
    }
    // Nothing ran: the same shift, the same price, nobody new.
    assert.equal((await t.app.db.shift()).id,shift);assert.equal((await t.app.db.getConfig()).priceKgCents,config.priceKgCents);
    assert.deepEqual((await t.app.db.listEmployees()).map(e=>e.name),['Ana']);assert.equal((await t.app.db.listProducts()).length,0);
    assert.equal((await t.app.db.cashSummary()).events.length,0);
    // Without the page's token the request is refused before the session is even looked at.
    t.pos=cookie;assert.equal((await t.post('/api/shift/move',{kind:'withdrawal',amount:'1,00'},null,{'X-Luminor-Token':'outro'})).status,403);
    // Locked: still Ana, but nothing works until she types the PIN again.
    ok(await t.post('/api/auth/lock',{},null));
    const s=(await t.get('/api/auth/session',null)).body;assert.equal(s.authenticated,false);assert.equal(s.locked,true);assert.equal(s.person.name,'Ana');
    for(const r of [await t.get('/api/state',null),await t.post('/api/shift/close',{counted:'10,00'},null)]){assert.equal(r.status,401);assert.equal(r.body.auth,'locked');}
    assert.equal((await t.app.db.shift()).id,shift);
    ok(await t.post('/api/auth/login',{employeeUuid:t.operators.Ana.uuid,pin:t.operators.Ana.pin},null));
    assert.equal((await t.get('/api/state',null)).status,200);
  }finally{await t.stop();}
});

test('the administrator\'s changes apply on the next request, need the password, and removing a critical one ends the session',async()=>{
  const t=await app.boot();try{
    await app.setupAdmin(t);const ana=await app.operator(t,'Ana',DEFAULTS);await app.signIn(t,'Ana');
    ok(await t.post('/api/shift/open',{opening:'0,00'}));const sale=await sell(t);
    let r=await t.post('/api/sales/cancel',{id:sale.id,reason:'Cliente desistiu'});assert.equal(r.status,403);assert.equal(r.body.error,DENIED);assert.equal(r.body.permission,'sales.cancel');
    // Without the password, or with a wrong one, nothing changes.
    await asAdmin(t,async()=>{
      for(const password of [undefined,'senha-errada']){
        r=await t.post('/api/admin/operators/permissions',{employeeId:ana.id,permissions:{'sales.cancel':true},password});assert.equal(r.status,401,JSON.stringify(r.body));
      }
    });
    assert.equal((await t.post('/api/sales/cancel',{id:sale.id,reason:'Cliente desistiu'})).status,403);
    // Allowed: the same session of Ana cancels at once, without signing in again.
    await asAdmin(t,async()=>ok(await t.post('/api/admin/operators/permissions',{employeeId:ana.id,permissions:{'sales.cancel':true},password:t.adminPassword})));
    ok(await t.post('/api/sales/cancel',{id:sale.id,reason:'Cliente desistiu'}));
    // A screen taken away: refused on her next request, in the same session.
    await asAdmin(t,async()=>ok(await t.post('/api/admin/operators/permissions',{employeeId:ana.id,permissions:{'screen.historico':false},password:t.adminPassword})));
    r=await t.get('/api/sales');assert.equal(r.status,403);assert.deepEqual((await t.get('/api/state')).body.auth.screens,['vendas','caixa']);
    // A critical permission taken away: her session ends (whatever she had on screen is no longer hers).
    await asAdmin(t,async()=>ok(await t.post('/api/admin/operators/permissions',{employeeId:ana.id,permissions:{'sales.cancel':false},password:t.adminPassword})));
    r=await t.get('/api/state');assert.equal(r.status,401);assert.equal(r.body.auth,'login');
    const changes=(await audit(t)).filter(a=>a.action==='permissoes_alteradas'&&a.detail.funcionario==='Ana');
    assert.deepEqual(changes.slice(-3).map(a=>[a.username,a.detail.adicionadas,a.detail.removidas,!!a.detail.sessoesEncerradas]),
      [['admin',['sales.cancel'],[],false],['admin',[],['screen.historico'],false],['admin',[],['sales.cancel'],true]]);
    // Blocking the access needs no password and ends the session; giving it back does.
    await app.signIn(t,'Ana');
    await asAdmin(t,async()=>ok(await t.post('/api/admin/operators/disable',{employeeId:ana.id,active:false})));
    assert.equal((await t.get('/api/state')).status,401);
    r=await t.post('/api/auth/login',{employeeUuid:ana.uuid,pin:ana.pin});assert.equal(r.status,403);assert.match(r.body.error,/bloqueado/);
    await asAdmin(t,async()=>{
      assert.equal((await t.post('/api/admin/operators/disable',{employeeId:ana.id,active:true})).status,401);
      ok(await t.post('/api/admin/operators/disable',{employeeId:ana.id,active:true,password:t.adminPassword}));
    });
    ok(await t.post('/api/auth/login',{employeeUuid:ana.uuid,pin:ana.pin}));
    // A new PIN also needs the password; without it the old PIN keeps working.
    await asAdmin(t,async()=>assert.equal((await t.post('/api/admin/operators/credentials',{employeeId:ana.id,pin:testPin()})).status,401));
    ok(await t.post('/api/auth/login',{employeeUuid:ana.uuid,pin:ana.pin}));
  }finally{await t.stop();}
});

test('the till cookie is HttpOnly, SameSite=Strict and only for /api; with weight on the scale only locking is allowed',async()=>{
  const t=await app.boot();try{
    await app.setupAdmin(t);const ana=await app.operator(t,'Ana',ALL);await app.operator(t,'Bruno',DEFAULTS);t.pos=null;t.cookie=null;
    let r=await t.post('/api/auth/login',{employeeUuid:ana.uuid,pin:ana.pin},null);ok(r);
    const set=r.headers.getSetCookie();
    assert.match(set.find(c=>c.startsWith('luminor_pos=')),/^luminor_pos=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=43200$/);
    assert.match(set.find(c=>c.startsWith('luminor_admin=')),/Max-Age=0/,'entrar no caixa encerra a área Admin deste computador');
    assert.ok(!JSON.stringify(r.body).includes(t.pos.split('=')[1]),'o token não vai no corpo');
    // A cup on the scale belongs to the sale on screen: nobody else signs in and Ana cannot leave, only lock.
    ok(await t.post('/api/scale/demo',{},null));ok(await t.post('/api/scale/demo-weight',{grams:300},null));
    r=await t.post('/api/auth/logout',{},null);assert.equal(r.status,409);assert.equal(r.body.scaleBusy,true);
    ok(await t.post('/api/auth/lock',{},null));
    r=await t.post('/api/auth/login',{employeeUuid:t.operators.Bruno.uuid,pin:t.operators.Bruno.pin},null);assert.equal(r.status,409);assert.match(r.body.error,/balança/);
    ok(await t.post('/api/auth/login',{employeeUuid:ana.uuid,pin:ana.pin},null));
    ok(await t.post('/api/scale/demo-weight',{grams:0},null));
    const cookie=t.pos;r=await t.post('/api/auth/logout',{},null);ok(r);
    assert.match(r.headers.getSetCookie().find(c=>c.startsWith('luminor_pos=')),/^luminor_pos=; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=0$/);
    assert.equal(t.pos,null);assert.equal((await t.get('/api/state',cookie)).status,401,'o cookie antigo não vale mais');
  }finally{await t.stop();}
});

test('§9 the log tells who did what at the till, and never a PIN, a password or a token',async()=>{
  const t=await app.boot();try{
    await app.setupAdmin(t);const ana=await app.operator(t,'Ana',without(ALL,'employees.manage'));
    // A wrong PIN: the generic answer, logged with the name only.
    const wrong=testPin();let r=await t.post('/api/auth/login',{employeeUuid:ana.uuid,pin:wrong},null);assert.equal(r.status,401);
    await app.signIn(t,'Ana',{keepAdmin:false});const tillCookie=t.pos;
    ok(await t.post('/api/shift/open',{opening:'50,00'},null));const shift=(await t.app.db.shift()).id;
    const sale=await sell(t);
    ok(await t.post('/api/shift/move',{kind:'withdrawal',amount:'20,00',note:'Cofre'},null));
    ok(await t.post('/api/sales/cancel',{id:sale.id,reason:'Cliente desistiu'},null));
    assert.equal((await t.post('/api/employees/save',{name:'Zé'},null)).status,403);
    ok(await t.post('/api/shift/close',{counted:'30,00'},null));
    ok(await t.post('/api/auth/logout',{},null));
    // A new PIN by the administrator.
    const pin=testPin();await app.adminSession(t);ok(await t.post('/api/admin/operators/credentials',{employeeId:ana.id,pin,password:t.adminPassword}));
    const log=await audit(t);const find=(action,user='Ana')=>{const a=log.find(x=>x.action===action&&x.username===user);assert.ok(a,`${action} de ${user}`);assert.match(a.at,/^\d{4}-\d\d-\d\dT/);return a;};
    assert.deepEqual(find('login_operador_falhou').detail,{});assert.equal(find('login_operador_falhou').ok,false);
    assert.equal(find('login_operador').detail.terminal,require('node:os').hostname().slice(0,120));
    assert.deepEqual(find('caixa_aberto').detail,{turno:shift});
    assert.deepEqual(find('sangria').detail,{turno:shift,valorCentavos:2000,descricao:'Cofre'});
    assert.deepEqual(find('venda_cancelada').detail,{venda:sale.id,motivo:'Cliente desistiu'});
    assert.deepEqual(find('acesso_negado').detail,{permissao:'employees.manage',rota:'/api/employees/save'});
    assert.deepEqual(find('caixa_fechado').detail,{turno:shift,situacao:'CONFERIDO'});
    find('logout_operador');
    const reset=log.filter(a=>a.action==='troca_pin');assert.deepEqual(reset.map(a=>[a.username,a.detail.funcionario,a.detail.primeiro]),[['admin','Ana',true],['admin','Ana',false]]);
    assert.deepEqual(find('permissoes_alteradas','admin').detail.funcionario,'Ana');
    // No secret in the log, in the program's log lines, nor in the stored accounts and sessions.
    const secrets=[ana.pin,wrong,pin,t.adminPassword,tillCookie.split('=')[1],t.cookie.split('=')[1],t.token];
    const where={audit:JSON.stringify(log),lines:t.log.lines.join('\n'),file:require('node:fs').readFileSync(require('node:path').join(t.home,'logs','auditoria.log'),'utf8'),
      accounts:JSON.stringify(await t.app.adminStore.all('SELECT * FROM operator_accounts')),sessions:JSON.stringify(await t.app.adminStore.all('SELECT * FROM pos_sessions'))};
    for(const [name,text] of Object.entries(where))for(const s of secrets)assert.ok(!text.includes(s),`segredo em ${name}`);
  }finally{await t.stop();}
});

test('the demo sign-in exists only in the demo: the installed PDV has no test identity, no default PIN and no demo password',async()=>{
  const t=await app.boot();try{
    await app.setupAdmin(t);ok(await t.post('/api/employees/save',{name:'Ana Paula'}));
    const uuid=(await t.get('/api/admin/operators')).body.operators.find(o=>o.name==='Ana Paula').uuid;
    t.pos=null;t.cookie=null;
    const o=(await t.get('/api/auth/options',null)).body;assert.equal(o.demo,null);assert.deepEqual(o.operators,[]);assert.equal(o.admin,true);
    for(const body of [{mode:'admin',username:'admin',password:'demo'},{employeeUuid:uuid,pin:'102030'},{employeeUuid:uuid,pin:'123456'}])
      assert.equal((await t.post('/api/auth/login',body,null)).status,401,JSON.stringify(body));
    // Nothing of demo/ is in the program that is installed.
    const fs=require('node:fs'),path=require('node:path');const src=path.join(__dirname,'..','src');
    for(const f of fs.readdirSync(src,{recursive:true}).filter(f=>f.endsWith('.js')))
      assert.ok(!/createDemoAuth|demo\/auth/.test(fs.readFileSync(path.join(src,f),'utf8')),f);
  }finally{await t.stop();}
});
