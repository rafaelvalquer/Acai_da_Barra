'use strict';
// A running PDV for the tests: real HTTP server on a random port, data in a throwaway PDV_HOME, the vault in file
// mode (DPAPI is tested on its own). Requests carry the page token, the same Origin a browser sends and the Admin
// cookie, like the browser does.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');const test=require('node:test');
const {start}=require('../src/main');const {loadConfig}=require('../src/config');
const {TEST_ADMIN_PASSWORD}=require('./helpers');
const homes=[];
test.after(()=>{for(const d of homes)fs.rmSync(d,{recursive:true,force:true});});
function newHome(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-app-'));homes.push(d);return d;}
function quiet(){const lines=[];const f=k=>m=>lines.push(`${k} ${m}`);return {info:f('info'),warn:f('warn'),error:f('error'),lines,recent:()=>[]};}
async function boot(home=newHome(),{env={},clock,hooks,connect}={}){
  const config=loadConfig({PDV_HOME:home,PORT:'0',PDV_BACKUP_ENABLED:'false',PDV_VAULT:'arquivo',...env});const log=quiet();
  const app=await start({config,log,clock,hooks,connect});
  const base=`http://127.0.0.1:${app.server.address().port}`;const {token}=await (await fetch(base+'/api/session')).json();
  const t={app,home,config,log,base,token,cookie:null};
  const headers=(cookie,extra={})=>({'X-Luminor-Token':token,Origin:base,...(cookie?{Cookie:cookie}:{}),...extra});
  const parse=async r=>{const text=await r.text();try{return JSON.parse(text);}catch(_){return text;}};
  const keep=r=>{const c=r.headers.get('set-cookie');if(c)t.cookie=/Max-Age=0/.test(c)?null:c.split(';')[0];return r;};
  t.get=async(p,cookie=t.cookie)=>{const r=await fetch(base+p,{headers:cookie?{Cookie:cookie}:{}});return {status:r.status,body:await parse(r)};};
  t.post=async(p,body={},cookie=t.cookie,extra={})=>{const r=keep(await fetch(base+p,{method:'POST',headers:headers(cookie,{'Content-Type':'application/json',...extra}),body:JSON.stringify(body)}));return {status:r.status,body:await parse(r),headers:r.headers};};
  t.upload=async(bytes,cookie=t.cookie)=>{const r=await fetch(base+'/api/admin/backup/restore/upload',{method:'POST',headers:headers(cookie,{'Content-Type':'application/octet-stream'}),body:bytes});return {status:r.status,body:await parse(r)};};
  t.stop=()=>app.stop();
  return t;
}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.body));return r.body.result;};
// First access: admin/admin, then the definitive password.
async function setupAdmin(t,password=TEST_ADMIN_PASSWORD){
  ok(await t.post('/api/admin/login',{username:'admin',password:'admin'}));
  ok(await t.post('/api/admin/change-password',{current:'admin',next:password}));
  return t.cookie;
}
async function login(t,password=TEST_ADMIN_PASSWORD,username='admin'){return t.post('/api/admin/login',{username,password});}
async function openShift(t,name='Ana'){const op=ok(await t.post('/api/employees/save',{name})).id;ok(await t.post('/api/shift/open',{opening:'50,00',operatorId:op}));return op;}
const active=async t=>(await t.get('/api/state')).body.activeSaleId;
async function sell(t,amount='10,00',method='pix'){const saleId=await active(t);ok(await t.post('/api/cart/manual-value',{saleId,amount}));return ok(await t.post('/api/checkout',{saleId,method,uuid:randomUUID()})).sale;}
async function closeShift(t){const st=(await t.get('/api/state')).body;ok(await t.post('/api/shift/close',{counted:(st.cash.expectedCents/100).toFixed(2).replace('.',',')}));}
const backup=async t=>ok(await t.post('/api/admin/backup/export'));
const backupFile=(t,name)=>fs.readFileSync(path.join(t.home,'backups','manuais',name));
const keyOf=t=>t.app.system.backups.keys.key();
const recoveryKey=async t=>ok(await t.post('/api/admin/backup/recovery-key',{password:TEST_ADMIN_PASSWORD})).key;
async function restore(t,bytes,{key,password=TEST_ADMIN_PASSWORD}={}){
  const up=ok(await t.upload(bytes));const review=ok(await t.post('/api/admin/backup/restore/validate',{uploadId:up.uploadId,recoveryKey:key}));
  return {up,review,confirm:()=>t.post('/api/admin/backup/restore',{uploadId:up.uploadId,password})};
}
const salesCount=async t=>(await t.app.db.adapter.get('SELECT COUNT(*) AS n FROM sales')).n;
const adminAudit=async t=>(await t.app.adminStore.recentAudit(100)).map(a=>a.action);
module.exports={boot,newHome,ok,setupAdmin,login,openShift,active,sell,closeShift,backup,backupFile,keyOf,recoveryKey,restore,salesCount,adminAudit,TEST_ADMIN_PASSWORD};
