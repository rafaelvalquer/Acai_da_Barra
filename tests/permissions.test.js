'use strict';
// Configurable permissions, enforced on the server (src/server.js, src/auth/AuthorizationService.js): P01–P10 of the
// plan. Each person is a cookie on the till's real HTTP server; the administrator's changes are made through the same
// service the Admin area uses (src/auth/OperatorAuthService.js). Runs on SQLite and on PostgreSQL.
const test=require('node:test'),assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {tillServer,ALL}=require('./pos-helpers');
const {DEFAULTS,CATALOG}=require('../src/auth/PermissionCatalog');const {hasPermission,DENIED}=require('../src/auth/AuthorizationService');
const {GET_ROUTES,POST_ROUTES}=require('../src/server');
const idOf=async(t,name)=>(await t.db.listEmployees()).find(e=>e.name===name).id;
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.result;};
const denied=(r,what)=>{assert.equal(r.status,403,`${what}: ${JSON.stringify(r.body)}`);assert.equal(r.body.error,DENIED);assert.equal(r.body.needsAdmin,true);};
// A sale paid in cash by whoever owns the cookie.
async function sell(t,cookie,amount='0,500'){
  const st=(await t.get('/api/state',cookie)).body;ok(await t.post('/api/cart/manual-weight',{saleId:st.activeSaleId,weight:amount},cookie));
  return ok(await t.post('/api/checkout',{saleId:st.activeSaleId,method:'cash',uuid:randomUUID()},cookie)).sale;
}

test('every route of the till has a permission, and only routes of the catalog exist',()=>{
  const known=new Set(CATALOG.map(p=>p.id));
  for(const [route,p] of Object.entries({...GET_ROUTES,...POST_ROUTES}))assert.ok(p===null||p==='simulator'||known.has(p),`${route}: ${p}`);
  // Only the state and "who am I" need just a session; everything else names its permission.
  assert.deepEqual(Object.entries({...GET_ROUTES,...POST_ROUTES}).filter(([,p])=>p===null).map(([r])=>r).sort(),['/api/operator','/api/state']);
});

test('P01 the menu shows only the allowed screens; P02 a closed screen refuses its endpoints',async()=>{
  const t=await tillServer();try{
    const c=await t.signIn('Carla',DEFAULTS);const carla=await idOf(t,'Carla');
    let st=(await t.get('/api/state',c)).body;
    assert.deepEqual(st.auth.screens,['vendas','historico','caixa']);assert.equal(st.auth.isAdmin,false);
    assert.deepEqual([...st.auth.permissions].sort(),[...DEFAULTS].sort());
    // What belongs to closed screens does not come in the state either.
    assert.deepEqual(st.employees,[]);
    for(const [p,body] of [['/api/report?period=day'],['/api/scale/ports'],['/api/products/save',{name:'Água',price:'5,00',stock:1}],
      ['/api/products/favorite',{id:1,favorite:true}],['/api/employees/save',{name:'Zé'}],['/api/employees/remove',{id:carla}],['/api/scale/connect',{path:'COM9'}],['/api/scale/disconnect']])
      denied(p.startsWith('/api/report')||p==='/api/scale/ports'?await t.get(p,c):await t.post(p,body,c),p);
    assert.equal((await t.db.listProducts()).length,0);assert.deepEqual((await t.db.listEmployees()).map(e=>e.name),['Carla']);
    // The administrator closes the history: out of the menu and refused on the next request, in the same session.
    await t.pos.auth.operators.setPermissions(carla,{'screen.historico':false},{by:'admin'});
    st=(await t.get('/api/state',c)).body;assert.deepEqual(st.auth.screens,['vendas','caixa']);
    denied(await t.get('/api/sales',c),'/api/sales');denied(await t.get('/api/sales/detail?id=1',c),'/api/sales/detail');
    // Without the sales screen nothing of the sales comes in the state.
    await t.pos.auth.operators.setPermissions(carla,{'screen.vendas':false},{by:'admin'});
    st=(await t.get('/api/state',c)).body;assert.equal(st.activeSale,null);assert.deepEqual(st.cart,[]);assert.deepEqual(st.products,[]);
    // Each refusal is logged (once a minute per person and permission).
    const refusals=t.pos.audits.filter(a=>a.action==='acesso_negado');
    assert.deepEqual([...new Set(refusals.map(a=>a.detail.permissao))].sort(),['employees.manage','products.manage','reports.view','scale.manage','screen.historico']);
    assert.equal(refusals.length,5,'repetições da mesma permissão no mesmo minuto não lotam o registro');
    assert.ok(refusals.every(a=>a.username==='Carla'&&a.detail.permissao&&a.detail.rota));
  }finally{await t.close();}
});

test('P03 an employee cannot change the price per kilo nor the automatic capture',async()=>{
  const t=await tillServer();try{
    const c=await t.signIn('Carla',DEFAULTS);const before=await t.db.getConfig();
    denied(await t.post('/api/config',{priceKg:'1,00'},c),'preço');denied(await t.post('/api/config',{autoCapture:!before.autoCapture},c),'captura');
    assert.deepEqual(await t.db.getConfig(),before);
    // With "config.manage" it works, and the change of price is logged with the person.
    const carla=await idOf(t,'Carla');await t.pos.auth.operators.setPermissions(carla,{'config.manage':true},{by:'admin'});
    ok(await t.post('/api/config',{priceKg:'70,00'},c));assert.equal((await t.db.getConfig()).priceKgCents,7000);
    const a=t.pos.audits.find(x=>x.action==='preco_kg_alterado');assert.equal(a.username,'Carla');assert.equal(a.detail.paraCentavos,7000);
  }finally{await t.close();}
});

test('P04 cancelling without permission is refused; P05 allowed by the administrator; P06 revoked at once',async()=>{
  const t=await tillServer();try{
    let c=await t.signIn('Carla',DEFAULTS);const carla=await idOf(t,'Carla');
    ok(await t.post('/api/shift/open',{opening:'50,00'},c));const sale=await sell(t,c);
    denied(await t.post('/api/sales/cancel',{id:sale.id,reason:'cliente desistiu'},c),'cancelar');
    denied(await t.post('/api/sales/correct',{id:sale.id,reason:'peso errado'},c),'corrigir');
    denied(await t.post('/api/cart/manual-value',{saleId:(await t.get('/api/state',c)).body.activeSaleId,amount:'5,00'},c),'valor digitado');
    assert.equal((await t.db.saleDetail(sale.id)).status,'done');
    // P05: the administrator allows cancelling. The open session gets it on the next request.
    await t.pos.auth.operators.setPermissions(carla,{'sales.cancel':true},{by:'admin'});
    assert.equal(ok(await t.post('/api/sales/cancel',{id:sale.id,reason:'cliente desistiu'},c)).status,'canceled');
    const log=t.pos.audits.find(a=>a.action==='venda_cancelada');assert.equal(log.username,'Carla');assert.equal(log.detail.venda,sale.id);
    // P06: taken away. "sales.cancel" is critical: the session ends now (401), and after signing in again it is refused.
    const other=await sell(t,c);
    await t.pos.auth.operators.setPermissions(carla,{'sales.cancel':false},{by:'admin'});
    const r=await t.post('/api/sales/cancel',{id:other.id,reason:'x'},c);assert.equal(r.status,401);assert.equal(r.body.auth,'login');
    c=await t.signIn('Carla',DEFAULTS);
    denied(await t.post('/api/sales/cancel',{id:other.id,reason:'x'},c),'cancelar de novo');assert.equal((await t.db.saleDetail(other.id)).status,'done');
    // A permission that is not critical is taken away without ending the session: refused from the next request on.
    await t.pos.auth.operators.setPermissions(carla,{'sales.transfer':false},{by:'admin'});
    denied(await t.post('/api/open-sales/transfer-item',{saleId:'x',key:'y',toSaleId:'new'},c),'transferir');
    assert.equal((await t.get('/api/state',c)).status,200);
  }finally{await t.close();}
});

test('P07 without a session every route answers 401 before doing anything',async()=>{
  const t=await tillServer();try{
    const c=await t.signIn('Carla');ok(await t.post('/api/shift/open',{opening:'10,00'},c));
    for(const cookie of [undefined,'luminor_pos=forjado','luminor_pos=']){
      for(const p of Object.keys(GET_ROUTES)){const r=await t.get(p,cookie);assert.equal(r.status,401,`${p} ${cookie}`);assert.equal(r.body.auth,'login');}
      for(const p of Object.keys(POST_ROUTES)){const r=await t.post(p,{opening:'1,00',name:'Invasor',price:'1,00',stock:1,counted:'0,00'},cookie);assert.equal(r.status,401,`${p} ${cookie}`);}
    }
    assert.equal((await t.db.listProducts()).length,0);assert.ok(await t.db.shift(),'o caixa continua aberto');
    // The session itself is in an HttpOnly cookie: the page and the API never return the token.
    const s=(await t.get('/api/auth/session',c)).body;assert.ok(!JSON.stringify(s).includes(c.split('=')[1]));
  }finally{await t.close();}
});

test('P08 a permission that does not exist is denied to everyone and cannot be saved',async()=>{
  const t=await tillServer();try{
    const admin={kind:'admin',permissions:new Set(),locked:false};const op={kind:'operador',permissions:new Set(['nao.existe','admin.backups','sales.create']),locked:false};
    assert.equal(hasPermission(admin,'nao.existe'),false);assert.equal(hasPermission(op,'nao.existe'),false);
    // The administrator's own areas are never an employee permission, even if written in the database.
    assert.equal(hasPermission(op,'admin.backups'),false);assert.equal(hasPermission(admin,'admin.backups'),true);
    assert.equal(hasPermission({...op,locked:true},'sales.create'),false);assert.equal(hasPermission(null,'sales.create'),false);
    await t.signIn('Carla',DEFAULTS);const carla=await idOf(t,'Carla');
    await assert.rejects(t.pos.auth.operators.setPermissions(carla,{'nao.existe':true},{by:'admin'}),/Permissão desconhecida|inválid/i);
    await assert.rejects(t.pos.auth.operators.setPermissions(carla,{'admin.restore':true},{by:'admin'}),/Permissão desconhecida|inválid|administrador/i);
    await assert.rejects(t.pos.auth.operators.setPermissions(carla,{'sales.cancel':'sim'},{by:'admin'}),/inválid|verdadeiro/i);
    const rows=await t.db.adapter.all('SELECT permission FROM employee_permissions');assert.ok(rows.every(r=>CATALOG.some(p=>p.id===r.permission)));
  }finally{await t.close();}
});

test('P09 the identity is the session: ids sent by the browser are ignored',async()=>{
  const t=await tillServer();try{
    await t.signIn('Bruno',DEFAULTS);const bruno=await idOf(t,'Bruno');
    const c=await t.signIn('Carla',DEFAULTS);const carla=await idOf(t,'Carla');
    // "/api/operator" tells who is signed in and never changes it.
    const who=ok(await t.post('/api/operator',{id:bruno},c));assert.equal(who.person.name,'Carla');
    assert.equal((await t.get('/api/state',c)).body.operator.name,'Carla');
    const shift=ok(await t.post('/api/shift/open',{opening:'20,00',operatorId:bruno,employeeId:bruno},c));
    assert.equal((await t.db.shift()).opened_by,carla);assert.ok(shift);
    const st=(await t.get('/api/state',c)).body;
    ok(await t.post('/api/cart/manual-weight',{saleId:st.activeSaleId,weight:'0,300',operatorId:bruno},c));
    const sale=ok(await t.post('/api/checkout',{saleId:st.activeSaleId,method:'pix',uuid:randomUUID(),operatorId:bruno,employeeId:bruno},c)).sale;
    assert.equal((await t.db.saleDetail(sale.id)).operator_name,'Carla');
    // Someone else's cookie name or a header does not help either.
    assert.equal((await t.get('/api/state',`${c}; luminor_pos=forjado`)).body.operator?.name??'Carla','Carla');
  }finally{await t.close();}
});

test('P10 the scale simulator is off in a real installation and needs "scale.manage" when turned on',async()=>{
  for(const [simulator,perms,expected] of [['off',ALL,403],['admin',DEFAULTS,403],['admin',['scale.manage'],200],['open',DEFAULTS,200]]){
    const t=await tillServer({simulator});try{
      const c=await t.signIn('Carla',perms);
      assert.equal((await t.post('/api/scale/demo',{},c)).status,expected,`${simulator} ${perms.length}`);
      assert.equal((await t.post('/api/scale/demo-weight',{grams:500},c)).status,expected);
      assert.equal((await t.get('/api/state',c)).body.simulator,expected===200);
    }finally{await t.close();}
  }
});
