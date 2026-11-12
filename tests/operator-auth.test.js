'use strict';
// Sign-in of the employees at the till (src/auth/PosAuth.js, OperatorAuthService.js, PosSessionService.js): A01–A07
// of the plan, plus the PIN policy and what never goes to the log. A08 (an employee in the Admin area) needs the whole
// installation: tests/authorization-http.test.js. Runs on SQLite and on PostgreSQL (npm run test:postgres).
const test=require('node:test'),assert=require('node:assert/strict');
const {tempStore}=require('./helpers');const {posAuth,testPin}=require('./pos-helpers');
const {checkPin,WRONG}=require('../src/auth/OperatorAuthService');const {PosAuth}=require('../src/auth/PosAuth');
const {LIMITS}=require('../src/auth/PosSessionService');
const req=cookie=>({headers:cookie?{cookie}:{}});
const MIN=60*1000;
// A clock the tests move by hand.
function fakeClock(start=Date.parse('2026-11-10T13:00:00Z')){let now=start;const c=()=>now;c.add=ms=>{now+=ms;};return c;}
async function setup({clock}={}){
  const box=await tempStore('luminor-auth-');const pos=await posAuth(box.s,{clock});
  return {box,db:box.s,pos,auth:pos.auth,async close(){await pos.close();await box.clean();}};
}
const login=(t,uuid,pin,o={scaleIdle:true})=>t.auth.login({employeeUuid:uuid,pin},o);
async function refused(promise,status,pattern){
  const e=await promise.then(()=>null,x=>x);assert.ok(e,'deveria ser recusado');assert.equal(e.status,status,e.message);
  if(pattern)assert.match(e.message,pattern);return e;
}

test('PIN policy: 6 to 8 digits and nothing easy to guess',()=>{
  for(const pin of ['583914','48207135','7391046'])assert.equal(checkPin(pin),pin);
  for(const pin of ['','12345','123456789','12a456',' 583914'])assert.throws(()=>checkPin(pin),/6 a 8 números/,pin);
  for(const pin of ['111111','123456','654321','121212','123123','147147','12341234','112233','000000','101010','1100110','24682468'])
    assert.throws(()=>checkPin(pin),/fácil de adivinhar/,pin);
});

test('A01 the right PIN signs in; the session is a random token kept only as a hash',async()=>{
  const t=await setup();try{
    const carla=await t.pos.provision('Carla');
    const r=await login(t,carla.uuid,carla.pin);
    assert.equal(r.session.authenticated,true);assert.equal(r.session.person.name,'Carla');assert.equal(r.session.isAdmin,false);
    const cookie=r.cookies[0];assert.match(cookie,/^luminor_pos=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=\d+$/);
    const token=cookie.split(';')[0].split('=')[1];
    const who=await t.auth.identify(req(`luminor_pos=${token}`));assert.equal(who.name,'Carla');assert.equal(who.employeeId,carla.id);
    const rows=await t.pos.adminStore.all('SELECT * FROM pos_sessions');assert.equal(rows.length,1);
    assert.ok(!JSON.stringify(rows).includes(token),'o token não é guardado');assert.equal(rows[0].kind,'operador');
    // The sign-in screen lists who may sign in, by name only.
    assert.deepEqual(await t.auth.options(),[{uuid:carla.uuid,name:'Carla'}]);
  }finally{await t.close();}
});

test('A02 a wrong PIN, an unknown employee and an employee without a PIN get the same answer',async()=>{
  const t=await setup();try{
    const carla=await t.pos.provision('Carla');const bruno=(await t.db.saveEmployee({name:'Bruno'})).id;
    const brunoUuid=(await t.db.accessIndex()).byId.get(bruno).uuid;
    for(const [uuid,pin] of [[carla.uuid,testPin()],[carla.uuid,'12'],[carla.uuid,null],['nao-existe',carla.pin],[brunoUuid,carla.pin]]){
      const e=await refused(login(t,uuid,pin),401);assert.equal(e.message,WRONG);
    }
    assert.equal((await t.pos.adminStore.all('SELECT * FROM pos_sessions')).length,0);
    assert.ok(t.pos.audits.some(a=>a.action==='login_operador_falhou'&&a.ok===false));
    // Bruno has no PIN: he is not offered on the sign-in screen and cannot sign in.
    assert.deepEqual((await t.auth.options()).map(o=>o.name),['Carla']);
  }finally{await t.close();}
});

test('A03 five wrong PINs lock the account for 5 minutes, even for the right PIN',async()=>{
  const clock=fakeClock();const t=await setup({clock});try{
    const carla=await t.pos.provision('Carla');
    for(let i=1;i<=4;i++)await refused(login(t,carla.uuid,testPin()),401);
    await refused(login(t,carla.uuid,testPin()),429,/5 minutos/);
    await refused(login(t,carla.uuid,carla.pin),429,/5 minutos/);
    // The lock is kept in config/admin.sqlite (a restart does not clear it).
    assert.ok((await t.auth.operators.account(carla.uuid)).locked_until);
    clock.add(5*MIN+1000);
    assert.equal((await login(t,carla.uuid,carla.pin)).session.authenticated,true);
    // A success clears the count.
    const a=await t.auth.operators.account(carla.uuid);assert.equal(a.failed_count,0);assert.equal(a.locked_until,null);
  }finally{await t.close();}
});

test('A04 a deactivated employee or a blocked access cannot sign in, and their open session ends',async()=>{
  const t=await setup();try{
    const carla=await t.pos.signIn('Carla');const bruno=await t.pos.signIn('Bruno');
    // Blocked by the administrator: told only after the right PIN.
    await t.auth.operators.setActive(bruno.id,false,{by:'admin'});
    await refused(login(t,bruno.uuid,bruno.pin),403,/bloqueado/);
    await refused(login(t,bruno.uuid,testPin()),401);
    assert.equal(await t.auth.identify(req(bruno.cookie)),null);
    // Deactivated in Funcionários: same answer as a wrong PIN, and gone from the sign-in screen.
    const s=await login(t,carla.uuid,carla.pin);const cookie=s.cookies[0].split(';')[0];
    await t.db.removeEmployee(carla.id);
    assert.equal(await t.auth.identify(req(cookie)),null,'a sessão termina com o funcionário desativado');
    await t.auth.employeeDeactivated(carla.id);
    const e=await refused(login(t,carla.uuid,carla.pin),401);assert.equal(e.message,WRONG);
    assert.deepEqual(await t.auth.options(),[]);
    // Given back: Bruno signs in with the PIN he had.
    await t.auth.operators.setActive(bruno.id,true,{by:'admin'});
    assert.equal((await login(t,bruno.uuid,bruno.pin)).session.person.name,'Bruno');
  }finally{await t.close();}
});

test('A05 a session ends after 30 minutes without use or 12 hours after signing in',async()=>{
  const clock=fakeClock();const t=await setup({clock});try{
    const carla=await t.pos.provision('Carla');
    let cookie=(await login(t,carla.uuid,carla.pin)).cookies[0].split(';')[0];
    clock.add(29*MIN);assert.ok(await t.auth.identify(req(cookie)));
    // Reading the screen's state is not use.
    clock.add(29*MIN);assert.ok(await t.auth.identify(req(cookie),{touch:false}));
    clock.add(2*MIN);assert.equal(await t.auth.identify(req(cookie)),null,'30 minutos parado');
    cookie=(await login(t,carla.uuid,carla.pin)).cookies[0].split(';')[0];
    for(let h=0;h<LIMITS.operador.max/MIN;h+=20){clock.add(20*MIN);if(!(await t.auth.identify(req(cookie))))break;}
    assert.equal(await t.auth.identify(req(cookie)),null,'12 horas no máximo');
    // A locked session is still the same person, but nothing works until the PIN is typed again.
    cookie=(await login(t,carla.uuid,carla.pin)).cookies[0].split(';')[0];
    const lock=await t.auth.lock(req(cookie));assert.equal(lock.session.locked,true);assert.equal(lock.session.authenticated,false);
    const who=await t.auth.identify(req(cookie));assert.equal(who.locked,true);
    assert.equal(PosAuth.view(who).authenticated,false);
    assert.equal(await t.auth.terminalActor(),null,'bloqueado: a balança não lança sozinha');
  }finally{await t.close();}
});

test('A06 another person signing in at the terminal ends the previous identity',async()=>{
  const t=await setup();try{
    const carla=await t.pos.signIn('Carla');const bruno=await t.pos.signIn('Bruno');
    assert.equal(await t.auth.identify(req(carla.cookie)),null);
    assert.equal((await t.auth.identify(req(bruno.cookie))).name,'Bruno');
    assert.equal((await t.auth.terminalActor()).name,'Bruno');
    // With weight on the scale nobody else takes over (that cup belongs to the sale on screen); the same person may come back.
    await refused(login(t,carla.uuid,carla.pin,{scaleIdle:false}),409,/balança/);
    assert.equal((await login(t,bruno.uuid,bruno.pin,{scaleIdle:false})).session.person.name,'Bruno');
    // Signing out with weight on the scale is refused too; locking is not.
    const cookie=(await login(t,bruno.uuid,bruno.pin)).cookies[0].split(';')[0];
    await refused(t.auth.logout(req(cookie),{scaleIdle:false}),409,/balança/);
    await t.auth.lock(req(cookie));
    await t.auth.logout(req(cookie),{scaleIdle:true});assert.equal(await t.auth.identify(req(cookie)),null);
  }finally{await t.close();}
});

test('A07 a new PIN ends the sessions opened with the old one; the old PIN stops working',async()=>{
  const t=await setup();try{
    const carla=await t.pos.signIn('Carla');const pin=testPin();
    await t.auth.operators.setPin(carla.id,pin,{by:'admin'});
    assert.equal(await t.auth.identify(req(carla.cookie)),null);
    await refused(login(t,carla.uuid,carla.pin),401);
    assert.equal((await login(t,carla.uuid,pin)).session.person.name,'Carla');
    // Only valid PINs are accepted.
    await refused(t.auth.operators.setPin(carla.id,'123456',{by:'admin'}),400,/fácil/);
  }finally{await t.close();}
});

test('the PIN never reaches the log; permissions out of their seal block the sign-in until reviewed',async()=>{
  const t=await setup();try{
    const carla=await t.pos.signIn('Carla',['screen.vendas','sales.create']);await refused(login(t,carla.uuid,'48207135'),401);
    const all=JSON.stringify(t.pos.audits);for(const secret of [carla.pin,'48207135'])assert.ok(!all.includes(secret),'PIN no registro');
    const stored=JSON.stringify(await t.pos.adminStore.all('SELECT * FROM operator_accounts'));assert.ok(!stored.includes(carla.pin));
    // Permissions changed straight in the commercial database (a restored backup, an edited file): not trusted.
    await t.db.savePermissions(carla.id,{'reports.view':true},{by:'fora do painel'});
    assert.equal(await t.auth.identify(req(carla.cookie)),null,'a sessão termina');
    const e=await refused(login(t,carla.uuid,carla.pin),403,/revisadas/);assert.equal(e.expose?.review,true);
    assert.equal((await t.auth.operators.listOperators())[0].review,true);
    // The administrator reviews and saves: she signs in again, with what was saved.
    await t.auth.operators.setPermissions(carla.id,{},{by:'admin'});
    const s=await login(t,carla.uuid,carla.pin);assert.ok(s.session.permissions.includes('reports.view'));
  }finally{await t.close();}
});
