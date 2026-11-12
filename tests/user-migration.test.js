'use strict';
// Updating to the version with individual sign-in (commercial database v5 → v6, config/admin.sqlite v1 → v2), the way
// back (an older PDV never works on the newer schema), and the permissions across backups, restores and the cloud
// copy. The store tests run on SQLite and on PostgreSQL; the whole installation always uses SQLite.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {tempStore,count,isPostgres}=require('./helpers');const {posAuth}=require('./pos-helpers');
const {PdvStore}=require('../src/store');const {SCHEMA_VERSION}=require('../src/database/schema');
const {AdminStore,ADMIN_STORE_VERSION}=require('../src/auth/AdminStore');
const {DEFAULTS,CATALOG}=require('../src/auth/PermissionCatalog');
const {decodeBackup}=require('../src/backup/BackupFormat');
const app=require('./app-helpers');const {ok}=app;
const {fakeCloud,settled,sameAsCloud,withCopy}=require('./cloud-helpers');
const FILES='backups em arquivo e a cópia na nuvem são do banco local (SQLite)';
// The database as the previous version (v5) left it: no permissions table, schema at 5.
async function backToV5(s){
  if(isPostgres)await s.adapter.exec('DROP TABLE employee_permissions; DELETE FROM schema_migrations WHERE version>=6;');
  else await s.adapter.exec('DROP TABLE employee_permissions; PRAGMA user_version=5;');
}
// The open sales as the till lists them, and the items of the one on the scale.
const openSales=async s=>{const st=await s.readState();return {list:st.openSales,cart:st.cart,total:st.cartTotalCents};};

test('v5 → v6 keeps the open shift, the open sales and their items, and gives nobody a permission or a PIN',async()=>{
  const box=await tempStore('luminor-v6-');try{
    let s=box.s;assert.equal(SCHEMA_VERSION,6);
    const ana=(await s.saveEmployee({name:'Ana'})).id;await s.saveEmployee({name:'Bruno'});await s.openShift('100,00',ana);
    const a=await s.activeSaleId();await s.addManualWeight(a,'0,500');
    const water=(await s.product({name:'Água',price:'5,00',stock:10})).id;const b=(await s.createDraftSale()).id;await s.addUnit(b,water,2);
    const before={shift:(await s.shift()).id,sales:await openSales(s),active:await s.activeSaleId(),employees:(await s.listEmployees()).map(e=>e.name)};
    assert.equal(before.sales.list.length,2);assert.equal(before.sales.cart.length,1);
    await backToV5(s);assert.equal(await s.schemaVersion(),5);
    // The update: the program starts on the old database.
    s=await box.reopen();
    assert.equal(await s.schemaVersion(),6);assert.equal(await count(s,'employee_permissions'),0);
    assert.deepEqual({shift:(await s.shift()).id,sales:await openSales(s),active:await s.activeSaleId(),employees:(await s.listEmployees()).map(e=>e.name)},before);
    // Nobody gained anything: no permission, nobody on the sign-in screen until the administrator gives a PIN.
    for(const e of (await s.accessIndex()).byId.values())assert.deepEqual(e.allowed,[]);
    const pos=await posAuth(s);try{assert.deepEqual(await pos.auth.options(),[]);}finally{await pos.close();}
    // The sales go on where they were.
    await s.addManualWeight(a,'0,100');await s.addUnit(b,water,1);assert.equal((await s.listProducts())[0].available,7);
    // Starting again changes nothing.
    s=await box.reopen();assert.equal(await s.schemaVersion(),6);assert.equal((await openSales(s)).list.length,2);
  }finally{await box.clean();}
});

test('a database of a newer version is never opened: the older program refuses instead of working on it',async()=>{
  const box=await tempStore('luminor-v7-');try{
    const s=box.s;const next=SCHEMA_VERSION+1;
    if(isPostgres)await s.adapter.exec(`INSERT INTO schema_migrations(version,applied_at) VALUES(${next},now())`);else await s.adapter.exec(`PRAGMA user_version=${next}`);
    await assert.rejects(PdvStore.open(s.adapter),e=>e.code==='banco_mais_novo'&&e.status===409&&/restaure o backup feito antes da atualização/.test(e.message));
    if(isPostgres)await s.adapter.exec(`DELETE FROM schema_migrations WHERE version=${next}`);else await s.adapter.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  }finally{await box.clean();}
  // The same for config/admin.sqlite.
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-adm7-'));try{
    const file=path.join(dir,'admin.sqlite');await (await AdminStore.open(file)).close();
    const d=new DatabaseSync(file);d.exec(`PRAGMA user_version=${ADMIN_STORE_VERSION+1}`);d.close();
    await assert.rejects(AdminStore.open(file),{code:'banco_mais_novo'});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('updating an installation in use: the administrator keeps the password, the open sales stay, nobody signs in without a PIN',async()=>{
  let t=await app.boot();try{
    await app.setupAdmin(t);await app.openShift(t,'Ana');
    ok(await t.post('/api/cart/manual-value',{saleId:await app.active(t),amount:'7,00'}));ok(await t.post('/api/open-sales/create'));
    ok(await t.post('/api/cart/manual-value',{saleId:await app.active(t),amount:'3,50'}));
    const before=(await t.get('/api/open-sales')).body;const shift=(await t.app.db.shift()).id;
    await t.stop();
    // What the previous version left: the commercial database at 5, config/admin.sqlite at 1 (no PINs, no sessions).
    let d=new DatabaseSync(t.config.sqlitePath);d.exec('DROP TABLE employee_permissions; PRAGMA user_version=5;');d.close();
    d=new DatabaseSync(t.config.adminDbPath);d.exec('DROP TABLE pos_sessions; DROP TABLE operator_accounts; PRAGMA user_version=1;');d.close();
    const password=t.adminPassword;t=await app.boot(t.home);t.adminPassword=password;
    // The administrator signs in with the same password: no reset, no new first access.
    const r=ok(await app.login(t));assert.equal(r.user.mustChangePassword,false);
    assert.deepEqual((await t.get('/api/auth/options')).body.operators,[]);assert.equal((await t.get('/api/state')).status,401);
    await app.atTill(t);
    assert.deepEqual((await t.get('/api/open-sales')).body,before);assert.equal((await t.app.db.shift()).id,shift);
    const v=new DatabaseSync(t.config.adminDbPath);try{assert.equal(v.prepare('PRAGMA user_version').get().user_version,ADMIN_STORE_VERSION);}finally{v.close();}
    // From here, each employee gets a PIN and a profile from the administrator.
    await app.operator(t,'Ana',DEFAULTS);await app.signIn(t,'Ana');
    const st=(await t.get('/api/state')).body;assert.equal(st.auth.person.name,'Ana');assert.equal(st.openSales.length,2);
  }finally{await t.stop();}
});

test('backup and restore: the permissions come back, are reviewed if they changed, and blocks and PINs stay with this computer',{skip:isPostgres&&FILES},async()=>{
  const a=await app.boot();let b=null;try{
    await app.setupAdmin(a);const ana=await app.operator(a,'Ana',DEFAULTS);const bruno=await app.operator(a,'Bruno',[...DEFAULTS,'cash.view_expected']);
    const file=app.backupFile(a,(await app.backup(a)).name);const key=await app.recoveryKey(a);
    // In the backup: the permissions, never a PIN or a session (they are in config/admin.sqlite).
    const {manifest,database}=decodeBackup(file,app.keyOf(a));
    assert.equal(manifest.summary.counts.employee_permissions,2*CATALOG.length);
    const copy=path.join(a.home,'tmp','check.sqlite');fs.mkdirSync(path.dirname(copy),{recursive:true});fs.writeFileSync(copy,database);
    const d=new DatabaseSync(copy);try{
      assert.deepEqual(d.prepare("SELECT name FROM sqlite_master WHERE name IN ('operator_accounts','pos_sessions','admin_users')").all(),[]);
    }finally{d.close();fs.rmSync(copy);}
    for(const pin of [ana.pin,bruno.pin])assert.ok(!database.includes(Buffer.from(pin)));
    // After the backup: Ana gains the reports, Bruno is blocked.
    await app.adminSession(a);
    ok(await a.post('/api/admin/operators/permissions',{employeeId:ana.id,permissions:{'reports.view':true},password:a.adminPassword}));
    ok(await a.post('/api/admin/operators/disable',{employeeId:bruno.id,active:false}));
    const r=await app.restore(a,file);ok(await r.confirm());
    // Ana's permissions went back to what the backup had, which is not what the administrator last saved: reviewed first.
    let s=await a.post('/api/auth/login',{employeeUuid:ana.uuid,pin:ana.pin},null);assert.equal(s.status,403);assert.equal(s.body.review,true);
    await app.adminSession(a);const list=(await a.get('/api/admin/operators')).body.operators;
    assert.equal(list.find(o=>o.name==='Ana').review,true);
    ok(await a.post('/api/admin/operators/permissions',{employeeId:ana.id,permissions:{},password:a.adminPassword}));
    s=ok(await a.post('/api/auth/login',{employeeUuid:ana.uuid,pin:ana.pin},null));assert.deepEqual([...s.session.permissions].sort(),[...DEFAULTS].sort());
    // The block is not undone by the restore.
    s=await a.post('/api/auth/login',{employeeUuid:bruno.uuid,pin:bruno.pin},null);assert.equal(s.status,403);assert.match(s.body.error,/bloqueado/);
    // On a new computer (a recovery): the employees and their permissions come back, the PINs do not.
    b=await app.boot();await app.setupAdmin(b);
    const up=await app.restore(b,file,{key});ok(await up.confirm());
    assert.deepEqual((await b.get('/api/auth/options')).body.operators,[]);
    await app.atTill(b);const team=(await b.get('/api/state')).body.employees;
    const brunoHere=team.find(e=>e.name==='Bruno').id;const pin=require('./pos-helpers').testPin();
    ok(await b.post('/api/admin/operators/credentials',{employeeId:brunoHere,pin,password:b.adminPassword}));
    s=ok(await b.post('/api/auth/login',{employeeUuid:bruno.uuid,pin},null));
    assert.ok(s.session.permissions.includes('cash.view_expected'),'as permissões do backup');
    // The old PIN of the other computer does not work here.
    assert.equal((await b.post('/api/auth/login',{employeeUuid:bruno.uuid,pin:bruno.pin},null)).status,401);
  }finally{await a.stop();if(b)await b.stop();}
});

test('the cloud copy receives the permissions and their changes, never the PINs or sessions',{skip:isPostgres&&FILES},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud);try{
    const ana=await app.operator(t,'Ana',DEFAULTS);await settled(t);
    const rows=async()=>(await cloud.db.query('SELECT permission,allowed FROM employee_permissions ORDER BY permission')).rows.filter(r=>r.allowed===1).map(r=>r.permission);
    assert.deepEqual(await rows(),[...DEFAULTS].sort());
    await app.adminSession(t);ok(await t.post('/api/admin/operators/permissions',{employeeId:ana.id,permissions:{'reports.view':true,'sales.discard':false},password:t.adminPassword}));
    await settled(t);await sameAsCloud(t,cloud);
    assert.deepEqual(await rows(),[...DEFAULTS.filter(p=>p!=='sales.discard'),'reports.view'].sort());
    const secret=(await cloud.db.query("SELECT to_regclass('operator_accounts') AS a,to_regclass('pos_sessions') AS b")).rows[0];
    assert.deepEqual(secret,{a:null,b:null});
  }finally{await t.stop();}
});
