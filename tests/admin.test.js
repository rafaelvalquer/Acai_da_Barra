'use strict';
// The Admin area's sign-in (plan section 6): first access with admin/admin, forced password change, lockout,
// sessions, recovery code, and that nothing (restart, update, restore, admin.sqlite lost) brings the initial
// password back. Real server, throwaway PDV_HOME.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {isPostgres}=require('./helpers');
const {boot,newHome,ok,setupAdmin,login,openShift,sell,closeShift,backup,backupFile,restore,salesCount,adminAudit,TEST_ADMIN_PASSWORD}=require('./app-helpers');
const {IDLE_MS}=require('../src/auth/AdminSessionService');
const SKIP=isPostgres&&'a autenticação Admin usa o config/admin.sqlite, igual nos dois bancos';
const OTHER_PASSWORD=TEST_ADMIN_PASSWORD.split('').reverse().join('')+'-2';
const session=async t=>(await t.get('/api/admin/session')).body;

test('first installation: admin/admin only opens the screen to set the definitive password',{skip:SKIP},async()=>{
  const t=await boot();try{
    assert.deepEqual(await session(t),{state:'inicial',authenticated:false,user:null});
    assert.equal((await login(t,'admin','administrador')).status,401);
    const r=ok(await t.post('/api/admin/login',{username:'admin',password:'admin'}));
    assert.deepEqual(r.user,{username:'admin',mustChangePassword:true,initial:true});
    const s=await session(t);assert.equal(s.authenticated,true);assert.equal(s.user.scope,'troca-senha');assert.equal(s.user.mustChangePassword,true);
    // Nothing else is unlocked until the password is changed.
    for(const p of ['/api/admin/overview','/api/admin/database','/api/admin/backup','/api/admin/diagnostics'])assert.equal((await t.get(p)).status,403,p);
    assert.equal((await t.post('/api/admin/backup/export')).status,403);
    // The new password: at least 12 characters, not predictable, not the user name, not "admin".
    for(const weak of ['curta','admin','adminadminadmin','123456789012','senhasenha12','aaaaaaaaaaaa'])
      assert.equal((await t.post('/api/admin/change-password',{current:'admin',next:weak})).status,400,weak);
    assert.equal((await t.post('/api/admin/change-password',{current:'errada',next:TEST_ADMIN_PASSWORD})).status,401);
    const before=t.cookie;
    ok(await t.post('/api/admin/change-password',{current:'admin',next:TEST_ADMIN_PASSWORD}));
    // A new session after the change; the previous one no longer works.
    assert.notEqual(t.cookie,before);assert.equal((await t.get('/api/admin/overview',before)).status,401);
    const ov=(await t.get('/api/admin/overview')).body;assert.equal(ov.user.username,'admin');assert.equal(ov.database.provider,'sqlite');
    assert.equal((await session(t)).state,'pronto');
    // Stored only as an Argon2id hash.
    const u=await t.app.adminStore.get('SELECT * FROM admin_users');
    assert.match(u.password_hash,/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);assert.equal(u.initial,0);
    assert.equal(fs.readFileSync(t.config.adminDbPath).includes(Buffer.from(TEST_ADMIN_PASSWORD)),false);
    // The initial password is gone for good.
    t.cookie=null;assert.equal((await t.post('/api/admin/login',{username:'admin',password:'admin'})).status,401);
    ok(await login(t));assert.equal((await session(t)).user.scope,'completo');
  }finally{await t.stop();}
});

test('the administrator changes the password and the user name; the old ones stop working',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);
    assert.equal((await t.post('/api/admin/change-password',{current:'errada-errada-1',next:OTHER_PASSWORD})).status,401);
    assert.equal((await t.post('/api/admin/change-password',{current:TEST_ADMIN_PASSWORD,next:TEST_ADMIN_PASSWORD})).status,400);
    ok(await t.post('/api/admin/change-password',{current:TEST_ADMIN_PASSWORD,next:OTHER_PASSWORD}));
    const c=t.cookie;t.cookie=null;
    assert.equal((await login(t)).status,401);ok(await login(t,OTHER_PASSWORD));
    // Changing the user name asks for the password.
    assert.equal((await t.post('/api/admin/change-username',{username:'gerencia.barra',password:TEST_ADMIN_PASSWORD})).status,401);
    assert.equal((await t.post('/api/admin/change-username',{username:'a b',password:OTHER_PASSWORD})).status,400);
    ok(await t.post('/api/admin/change-username',{username:'gerencia.barra',password:OTHER_PASSWORD}));
    t.cookie=null;assert.equal((await login(t,OTHER_PASSWORD,'admin')).status,401);
    ok(await login(t,OTHER_PASSWORD,'Gerencia.Barra'));
    // A session opened before the rename continues, under the new name.
    assert.equal((await t.get('/api/admin/overview',c)).body.user.username,'gerencia.barra');
    // Signing out ends the session on the server.
    const signedIn=t.cookie;const out=await t.post('/api/admin/logout');assert.equal(out.status,200);assert.match(out.headers.get('set-cookie'),/Max-Age=0/);
    assert.equal((await t.get('/api/admin/overview',signedIn)).status,401);
    const log=(await (async()=>{ok(await login(t,OTHER_PASSWORD,'gerencia.barra'));return (await t.get('/api/admin/access-log')).body;})()).map(a=>a.action);
    for(const a of ['login','login_falhou','senha_alterada','usuario_alterado','logout'])assert.ok(log.includes(a),a);
  }finally{await t.stop();}
});

test('repeated wrong passwords lock the sign-in for a few minutes, also after a restart',{skip:SKIP},async()=>{
  const home=newHome();let t=await boot(home);try{
    await setupAdmin(t);t.cookie=null;
    for(let i=0;i<4;i++)assert.equal((await login(t,'tentativa-'+i)).status,401);
    assert.equal((await login(t,'tentativa-5')).status,429);
    // Locked: even the right password is refused.
    assert.equal((await login(t)).status,429);
    await t.stop();t=await boot(home);
    assert.equal((await login(t)).status,429);
    // Five minutes later it opens again.
    await t.app.adminStore.run('UPDATE admin_users SET locked_until=?',[new Date(Date.now()-1000).toISOString()]);
    ok(await login(t));
    // Unknown user names are locked too (no hint about which names exist).
    for(let i=0;i<4;i++)assert.equal((await login(t,'x','nao-existe')).status,401);
    assert.equal((await login(t,'x','nao-existe')).status,429);
    assert.ok((await adminAudit(t)).includes('login_bloqueado'));
  }finally{await t.stop();}
});

test('wrong passwords in a confirmation also count, and five of them end the session',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);
    for(let i=0;i<4;i++)assert.equal((await t.post('/api/admin/recovery-code',{password:'errada-'+i})).status,401);
    assert.equal((await t.post('/api/admin/recovery-code',{password:'errada-5'})).status,401);
    assert.equal((await t.get('/api/admin/overview')).status,401);
    t.cookie=null;assert.equal((await login(t)).status,429);
  }finally{await t.stop();}
});

test('an idle session expires after 15 minutes',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);assert.equal((await t.get('/api/admin/overview')).status,200);
    await t.app.adminStore.run('UPDATE admin_sessions SET last_seen_at=?',[new Date(Date.now()-IDLE_MS-1000).toISOString()]);
    assert.equal((await t.get('/api/admin/overview')).status,401);
    assert.equal((await session(t)).authenticated,false);
  }finally{await t.stop();}
});

test('the session cookie is HttpOnly, SameSite=Strict and limited to /api/admin; the PDV pages never see it',{skip:SKIP},async()=>{
  const t=await boot();try{
    const r=await t.post('/api/admin/login',{username:'admin',password:'admin'});
    const c=r.headers.get('set-cookie');assert.match(c,/^luminor_admin=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/api\/admin; Max-Age=28800$/);
    const state=await (await fetch(t.base+'/api/state')).text();assert.equal(state.includes(t.cookie.split('=')[1]),false);
    // The token itself is never stored, only its hash.
    const row=await t.app.adminStore.get('SELECT token_hash FROM admin_sessions');assert.notEqual(row.token_hash,t.cookie.split('=')[1]);
  }finally{await t.stop();}
});

test('the operator at the counter has no way into the Admin area',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);const admin=t.cookie;t.cookie=null;
    await openShift(t,'Operadora');await sell(t);
    // An employee of the PDV is not an administrator, whatever is typed.
    assert.equal((await login(t,TEST_ADMIN_PASSWORD,'Operadora')).status,401);
    const gets=['overview','database','backup','diagnostics','access-log','audit'];
    for(const p of gets)assert.equal((await t.get('/api/admin/'+p,null)).status,401,p);
    const posts=['logout','change-password','change-username','recovery-code','database/integrity','database/test','database/prepare','database/migrate','database/activate','database/use-local',
      'backup/export','backup/download','backup/settings','backup/recovery-key','backup/recovery-key/confirm','backup/restore/validate','backup/restore/cancel','backup/restore','diagnostics/export'];
    for(const p of posts){const r=await t.post('/api/admin/'+p,{password:TEST_ADMIN_PASSWORD},null);assert.ok([401,200].includes(r.status)&&(p==='logout'||r.status===401),`${p}: ${r.status}`);}
    assert.equal((await t.upload(Buffer.from('x'),null)).status,401);
    // A forged or old cookie does not help.
    assert.equal((await t.get('/api/admin/overview','luminor_admin=abc')).status,401);
    // POSTs need the page token and the same origin, even with a valid administrator session.
    let r=await fetch(t.base+'/api/admin/change-password',{method:'POST',headers:{'Content-Type':'application/json',Cookie:admin},body:JSON.stringify({current:TEST_ADMIN_PASSWORD,next:OTHER_PASSWORD})});assert.equal(r.status,403);
    r=await fetch(t.base+'/api/admin/backup/export',{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':t.token,Origin:'http://evil.example',Cookie:admin},body:'{}'});assert.equal(r.status,403);
    r=await fetch(t.base+'/api/admin/backup/export',{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':t.token,Referer:'http://evil.example/x',Cookie:admin},body:'{}'});assert.equal(r.status,403);
    assert.equal((await t.get('/api/admin/overview',admin)).status,200);
  }finally{await t.stop();}
});

test('an update (restart with the same data folder) keeps the administrator and never brings admin/admin back',{skip:SKIP},async()=>{
  const home=newHome();let t=await boot(home);try{
    await setupAdmin(t);await t.stop();
    t=await boot(home);
    assert.equal((await session(t)).state,'pronto');
    assert.equal((await t.post('/api/admin/login',{username:'admin',password:'admin'})).status,401);ok(await login(t));
  }finally{await t.stop();}
});

test('admin.sqlite lost on an initialized computer: the account comes back locked, only the recovery code opens it',{skip:SKIP},async()=>{
  const home=newHome();let t=await boot(home);let code;try{
    await setupAdmin(t);
    assert.equal((await t.post('/api/admin/recovery-code',{password:'errada-errada'})).status,401);
    code=ok(await t.post('/api/admin/recovery-code',{password:TEST_ADMIN_PASSWORD})).code;
    assert.match(code,/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    assert.equal((await session(t)).user.hasRecoveryCode,true);
  }finally{await t.stop();}
  for(const f of fs.readdirSync(path.join(home,'config')).filter(f=>f.startsWith('admin.sqlite')))fs.rmSync(path.join(home,'config',f));
  t=await boot(home);try{
    assert.equal((await session(t)).state,'recuperacao');
    // Neither the initial password nor the old one: the account has no password now.
    assert.equal((await t.post('/api/admin/login',{username:'admin',password:'admin'})).status,401);
    assert.equal((await login(t)).status,401);
    assert.equal((await t.post('/api/admin/recover',{username:'admin',code:'AAAA-BBBB-CCCC-DDDD'})).status,401);
    const r=ok(await t.post('/api/admin/recover',{username:'admin',code:code.toLowerCase().replace(/-/g,' ')}));assert.equal(r.user.mustChangePassword,true);
    assert.equal((await t.get('/api/admin/overview')).status,403);
    ok(await t.post('/api/admin/change-password',{next:OTHER_PASSWORD}));
    assert.equal((await t.get('/api/admin/overview')).status,200);
    // The code is used up.
    t.cookie=null;assert.equal((await t.post('/api/admin/recover',{username:'admin',code})).status,401);
    ok(await login(t,OTHER_PASSWORD));
    assert.ok((await adminAudit(t)).includes('admin_db_recriado'));
  }finally{await t.stop();}
});

test('the reset command (run on this computer) gives a temporary password, never admin/admin',{skip:SKIP},async()=>{
  const t=await boot();try{
    await setupAdmin(t);t.cookie=null;
    const {temporaryPassword}=await t.app.system.auth.resetWithTemporaryPassword();
    assert.notEqual(temporaryPassword,'admin');assert.equal((await login(t)).status,401);
    assert.equal((await t.post('/api/admin/login',{username:'admin',password:'admin'})).status,401);
    const r=ok(await login(t,temporaryPassword));assert.equal(r.user.mustChangePassword,true);
    assert.equal((await t.get('/api/admin/overview')).status,403);
    ok(await t.post('/api/admin/change-password',{current:temporaryPassword,next:OTHER_PASSWORD}));
    assert.equal((await t.get('/api/admin/overview')).status,200);
  }finally{await t.stop();}
});

test('restoring a commercial backup does not change the administrator password',{skip:SKIP},async()=>{
  const t=await boot();try{
    // The backup was made while the password was the first one.
    await setupAdmin(t);await openShift(t);await sell(t,'7,00');await closeShift(t);
    const file=backupFile(t,(await backup(t)).name);
    ok(await t.post('/api/admin/change-password',{current:TEST_ADMIN_PASSWORD,next:OTHER_PASSWORD}));
    const r=await restore(t,file,{password:OTHER_PASSWORD});ok(await r.confirm());
    assert.equal(await salesCount(t),1);
    t.cookie=null;
    assert.equal((await login(t)).status,401);
    assert.equal((await t.post('/api/admin/login',{username:'admin',password:'admin'})).status,401);
    ok(await login(t,OTHER_PASSWORD));assert.equal((await session(t)).state,'pronto');
  }finally{await t.stop();}
});

test('a restore into a brand-new installation keeps that installation’s own administrator',{skip:SKIP},async()=>{
  const a=await boot(),b=await boot();try{
    await setupAdmin(a,OTHER_PASSWORD);await openShift(a);await sell(a);await closeShift(a);
    const file=backupFile(a,(await backup(a)).name);const key=ok(await a.post('/api/admin/backup/recovery-key',{password:OTHER_PASSWORD})).key;
    await setupAdmin(b);const r=await restore(b,file,{key});ok(await r.confirm());
    b.cookie=null;assert.equal((await login(b,OTHER_PASSWORD)).status,401);ok(await login(b));
  }finally{await a.stop();await b.stop();}
});
