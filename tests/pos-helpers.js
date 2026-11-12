'use strict';
// The till's sign-in for tests that start the server by themselves (without the whole installation): a throwaway
// config/admin.sqlite, a PIN key of their own, and employees with a PIN and the permissions each test needs.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const crypto=require('node:crypto');
const {AdminStore}=require('../src/auth/AdminStore');const {PosAuth}=require('../src/auth/PosAuth');
const {CATALOG}=require('../src/auth/PermissionCatalog');const {checkPin}=require('../src/auth/OperatorAuthService');
// Loaded with the test file (not inside a test): on PostgreSQL its shared database closes after the whole file.
const {tempStore}=require('./helpers');const {ScaleDriver}=require('../src/scale');const {createServer}=require('../src/server');
const ALL=CATALOG.map(p=>p.id);
// A PIN the policy accepts, different every time.
function testPin(){for(;;){const pin=String(crypto.randomInt(100000,99999999));try{return checkPin(pin);}catch(_){}}}
async function posAuth(db,{clock}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-pos-'));
  const adminStore=await AdminStore.open(path.join(dir,'admin.sqlite'));const audits=[];
  // No administrator here: tests of the administrator's sign-in use the whole installation (tests/app-helpers.js).
  const adminAuth={login:async()=>{throw Object.assign(Error('Usuário ou senha incorretos.'),{status:401});},user:async()=>null};
  const auth=new PosAuth({adminStore,adminAuth,db,pepper:crypto.randomBytes(32),audit:async e=>{audits.push(e);},clock,terminal:'teste'});
  const pos={auth,adminStore,audits,
    // An employee (created if needed) with a PIN and these permissions: all of them, or the ones listed.
    async provision(name,permissions=ALL){
      const found=(await db.listEmployees()).find(x=>x.name===name);const id=found?found.id:(await db.saveEmployee({name})).id;
      const pin=testPin();await auth.operators.setPin(id,pin,{by:'teste'});
      await auth.operators.setPermissions(id,Object.fromEntries(ALL.map(p=>[p,permissions.includes(p)])),{by:'teste'});
      return {id,uuid:(await db.accessIndex()).byId.get(id).uuid,pin};
    },
    // Signs in at the till; cookie: what the browser would send from then on.
    async signIn(name,permissions=ALL,{scaleIdle=true}={}){
      const p=await pos.provision(name,permissions);const r=await auth.login({employeeUuid:p.uuid,pin:p.pin},{scaleIdle});
      return {...p,cookie:r.cookies[0].split(';')[0],session:r.session};
    },
    async close(){await adminStore.close();fs.rmSync(dir,{recursive:true,force:true});}};
  return pos;
}
// The till's HTTP server on a random port with a throwaway database, used the way the browser does: each person is a
// cookie (signIn(name, permissions) → their cookie). simulator: 'open' (tests), 'admin' or 'off' (production default).
async function tillServer({simulator='open',prefix='luminor-till-',clock}={}){
  const box=await tempStore(prefix);const db=box.s;const scale=new ScaleDriver();const pos=await posAuth(db,{clock});
  const server=createServer({db,scale,auth:pos.auth,simulator});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const parse=async r=>{const text=await r.text();try{return JSON.parse(text);}catch(_){return text;}};
  const {token}=await (await fetch(base+'/api/session')).json();
  const t={db,scale,server,base,token,pos,
    get:async(p,cookie)=>{const r=await fetch(base+p,{headers:cookie?{Cookie:cookie}:{}});return {status:r.status,body:await parse(r)};},
    post:async(p,body={},cookie,headers={})=>{const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':token,...(cookie?{Cookie:cookie}:{}),...headers},body:JSON.stringify(body)});
      return {status:r.status,body:await parse(r),headers:r.headers};},
    async signIn(name,permissions=ALL){return (await pos.signIn(name,permissions)).cookie;},
    async close(){scale.disconnect();server.closeAllConnections();await new Promise(r=>server.close(r));await pos.close();await box.clean();}};
  return t;
}
module.exports={posAuth,tillServer,testPin,ALL};
