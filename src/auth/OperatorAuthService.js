'use strict';
// The employees' sign-in at the till with an individual PIN (config/admin.sqlite, table operator_accounts). Only the
// administrator creates or changes a PIN; there is no default PIN and an employee without one cannot sign in.
//   PIN       6 to 8 digits, nothing predictable (repeated digits, sequences, repeated blocks, common PINs)
//   storage   Argon2id of HMAC-SHA256(pepper, PIN): the pepper is in this computer's vault, so a copy of
//             admin.sqlite alone is not enough to try PINs offline
//   attempts  5 wrong PINs lock the account for 5 minutes (kept across restarts); attempts for unknown employees
//             are limited in memory, and all failures together are limited per minute
//   messages  a wrong PIN, an employee without a PIN and an inactive employee get the same answer; only a temporary
//             lock is told as it is (the person has to wait). A blocked account or permissions under review are
//             told only after the right PIN.
// The PIN never goes to a log, an error message or the audit.
//
// Permissions are kept with the employees in the commercial database (src/services/PermissionService.js). When the
// administrator saves them, their digest is sealed here (permissions_digest). Permissions that do not match the seal
// (a restored backup, a replaced or edited database) count as none, and the employee cannot sign in until the
// administrator reviews and saves them again: an update or a restore never widens anyone's access.
const crypto=require('node:crypto');
const {hashPassword,verifyPassword}=require('./PasswordService');
const {CATALOG,CRITICAL,isKnown,defaultProfile}=require('./PermissionCatalog');
const {httpError}=require('./AuthorizationService');
const MAX_FAILS=5,LOCK_MS=5*60*1000,GLOBAL_WINDOW_MS=60*1000,GLOBAL_MAX=30;
const WRONG='Funcionário ou PIN incorretos.';
const LOCKED='Acesso bloqueado por 5 minutos depois de 5 tentativas com PIN incorreto. Aguarde ou peça ao administrador.';
const COMMON=new Set(['123456','654321','111111','000000','123123','112233','121212','159753','147258','258369','102030','696969','101010','202020','246810','135790',
  '123321','111222','998877','778899','12345678','87654321','11223344','20202020','19191919','01020304','13579246','24681357','1234567','7654321']);
function checkPin(pin){
  const s=String(pin??'');
  if(!/^\d{6,8}$/.test(s))throw httpError(400,'O PIN deve ter de 6 a 8 números.');
  const d=[...s].map(Number);const steps=d.slice(1).map((x,i)=>x-d[i]);
  const predictable=/^(\d)\1+$/.test(s)||steps.every(x=>x===1)||steps.every(x=>x===-1)||steps.every(x=>x===steps[0])
    ||/^(\d{2})\1+$/.test(s)||/^(\d{3})\1+$/.test(s)||/^(\d{4})\1$/.test(s)||/^((\d)\2)+$/.test(s)||COMMON.has(s)||new Set(d).size<=2;
  if(predictable)throw httpError(400,'Esse PIN é fácil de adivinhar. Escolha outro, sem sequências nem números repetidos.');
  return s;
}
class OperatorAuthService {
  // db: the PdvStore (employees and their permissions). sessions: PosSessionService. pepper: Buffer (vault).
  constructor({store,db,sessions,pepper,audit,clock=()=>Date.now()}){
    if(!pepper||pepper.length<16)throw Error('Chave dos PINs ausente');
    Object.assign(this,{store,db,sessions,pepper,audit,clock});this.unknownFails=new Map();this.recentFails=[];
  }
  peppered(pin){return crypto.createHmac('sha256',this.pepper).update('pin:'+String(pin??'')).digest('hex');}
  digest(uuid,allowed){return crypto.createHmac('sha256',this.pepper).update('permissoes:'+uuid+':'+[...allowed].sort().join(',')).digest('hex');}
  account(uuid){return this.store.get('SELECT * FROM operator_accounts WHERE employee_uuid=?',[String(uuid||'')]);}
  accountById(id){return this.store.get('SELECT * FROM operator_accounts WHERE id=?',[id]);}
  locked(account,key){const until=account?Date.parse(account.locked_until||0):(this.unknownFails.get(key)?.until||0);return until>this.clock()?until:0;}
  // All failures together, per minute: many wrong PINs across different employees slow everybody down.
  floodGuard(){
    const now=this.clock();this.recentFails=this.recentFails.filter(t=>t>now-GLOBAL_WINDOW_MS);
    if(this.recentFails.length>=GLOBAL_MAX)throw httpError(429,'Muitas tentativas incorretas. Aguarde um minuto e tente de novo.');
  }
  async failed(account,key,employee){
    const now=this.clock();this.recentFails.push(now);let count,until=null;
    if(account){count=(Date.parse(account.locked_until||0)&&Date.parse(account.locked_until)<=now?0:account.failed_count)+1;if(count>=MAX_FAILS)until=iso(now+LOCK_MS);
      await this.store.run('UPDATE operator_accounts SET failed_count=?,locked_until=? WHERE id=?',[count>=MAX_FAILS?0:count,until,account.id]);}
    else{const f=this.unknownFails.get(key);count=(f&&!f.until?f.count:0)+1;this.unknownFails.set(key,{count:count>=MAX_FAILS?0:count,until:count>=MAX_FAILS?now+LOCK_MS:0});until=count>=MAX_FAILS;
      if(this.unknownFails.size>1000)this.unknownFails.delete(this.unknownFails.keys().next().value);}
    await this.audit({username:employee?.name||'desconhecido',action:'login_operador_falhou',ok:false,detail:until?{bloqueado:true}:{}});
    return !!until;
  }
  // The permissions that count now for this account, or null when it may not work (no PIN, blocked, employee
  // inactive or missing, permissions not matching the seal). employee: an entry of store.accessIndex().
  effective(account,employee){
    if(!account||!account.pin_hash||Number(account.active)!==1||!employee||!employee.active)return null;
    if(!account.permissions_digest||account.permissions_digest!==this.digest(employee.uuid,employee.allowed))return null;
    return new Set(employee.allowed.filter(isKnown));
  }
  // Employees who can sign in now (for the sign-in screen): names only.
  async loginOptions(){
    const index=await this.db.accessIndex();const accounts=await this.store.all('SELECT employee_uuid FROM operator_accounts WHERE active=1 AND pin_hash IS NOT NULL');
    return accounts.map(a=>index.byUuid.get(a.employee_uuid)).filter(e=>e&&e.active).map(e=>({uuid:e.uuid,name:e.name}))
      .sort((a,b)=>a.name.localeCompare(b.name,'pt-BR',{sensitivity:'base'}));
  }
  // Checks the PIN. Returns {account,employee,permissions} or throws (401 wrong, 429 locked, 403 blocked/review).
  async verify({employeeUuid,pin}){
    this.floodGuard();
    const key=String(employeeUuid||'').slice(0,64);const [account,index]=await Promise.all([this.account(key),this.db.accessIndex()]);
    const employee=index.byUuid.get(key)||null;
    if(this.locked(account,key)){await this.audit({username:employee?.name||'desconhecido',action:'login_operador_falhou',ok:false,detail:{bloqueado:true}});throw httpError(429,LOCKED,{locked:true});}
    const wellFormed=/^\d{6,8}$/.test(String(pin??''));
    const ok=wellFormed&&account?.pin_hash?await verifyPassword(account.pin_hash,this.peppered(pin)):(await verifyPassword(null,'x'),false);
    if(!ok||!employee||!employee.active){
      const nowLocked=await this.failed(account,key,employee);
      throw httpError(nowLocked?429:401,nowLocked?LOCKED:WRONG,nowLocked?{locked:true}:undefined);
    }
    this.unknownFails.delete(key);
    await this.store.run('UPDATE operator_accounts SET failed_count=0,locked_until=NULL WHERE id=?',[account.id]);
    if(Number(account.active)!==1){await this.audit({username:employee.name,action:'login_operador_falhou',ok:false,detail:{motivo:'acesso_bloqueado'}});throw httpError(403,'Seu acesso ao caixa está bloqueado. Fale com o administrador.');}
    const permissions=this.effective(account,employee);
    if(!permissions){await this.audit({username:employee.name,action:'login_operador_falhou',ok:false,detail:{motivo:'permissoes_a_revisar'}});
      throw httpError(403,'Suas permissões precisam ser revisadas pelo administrador antes do próximo acesso.',{review:true});}
    return {account,employee,permissions};
  }
  // —— administrator ——
  async employeeOf(employeeId){
    const index=await this.db.accessIndex();const e=index.byId.get(Number(employeeId));
    if(!e||!e.active)throw httpError(404,'Funcionário não encontrado.');
    return e;
  }
  // Seals the permissions as they are now in the commercial database.
  async seal(account,employeeId){
    const e=await this.employeeOf(employeeId);
    await this.store.run('UPDATE operator_accounts SET permissions_digest=?,updated_at=? WHERE id=?',[this.digest(e.uuid,e.allowed),iso(this.clock()),account.id]);
  }
  // New PIN (first one or a reset). applyDefaults: give the "operador padrão" profile (first PIN only, when asked).
  async setPin(employeeId,pin,{by,applyDefaults=false}){
    const valid=checkPin(pin);let e=await this.employeeOf(employeeId);const now=iso(this.clock());
    let account=await this.account(e.uuid);const first=!account?.pin_hash;
    if(applyDefaults)await this.db.savePermissions(e.id,defaultProfile(),{by});
    const pinHash=await hashPassword(this.peppered(valid));
    if(account)await this.store.run('UPDATE operator_accounts SET pin_hash=?,failed_count=0,locked_until=NULL,pin_changed_at=?,updated_at=? WHERE id=?',[pinHash,now,now,account.id]);
    else await this.store.run('INSERT INTO operator_accounts(employee_uuid,pin_hash,active,pin_changed_at,created_at,updated_at) VALUES(?,?,1,?,?,?)',[e.uuid,pinHash,now,now,now]);
    account=await this.account(e.uuid);
    // The first PIN seals the permissions the administrator sees on the screen; a reset keeps the seal as it was,
    // so permissions changed outside the Admin area still need a review.
    if(first||applyDefaults){await this.seal(account,e.id);await this.store.run('UPDATE operator_accounts SET permissions_changed_at=?,permissions_changed_by=? WHERE id=?',[now,by,account.id]);}
    await this.sessions.destroyFor('operador',account.id);
    await this.audit({username:by,action:'troca_pin',detail:{funcionario:e.name,primeiro:first}});
    if(applyDefaults){e=await this.employeeOf(e.id);await this.audit({username:by,action:'permissoes_alteradas',detail:{funcionario:e.name,perfil:'operador padrão',permitidas:e.allowed.filter(isKnown)}});}
    return this.operator(e.id);
  }
  // changes: {permission: true|false}. reset: the "operador padrão" profile for every permission of the catalog.
  async setPermissions(employeeId,changes,{by,reset=false}){
    const e=await this.employeeOf(employeeId);
    const r=await this.db.savePermissions(e.id,reset?defaultProfile():changes,{by});
    const account=await this.account(e.uuid);const now=iso(this.clock());
    if(account){await this.seal(account,e.id);await this.store.run('UPDATE operator_accounts SET permissions_changed_at=?,permissions_changed_by=?,updated_at=? WHERE id=?',[now,by,now,account.id]);}
    const ended=account&&r.removed.some(p=>CRITICAL.has(p));if(ended)await this.sessions.destroyFor('operador',account.id);
    await this.audit({username:by,action:'permissoes_alteradas',detail:{funcionario:e.name,adicionadas:r.added,removidas:r.removed,...(reset?{perfil:'operador padrão'}:{}),...(ended?{sessoesEncerradas:true}:{})}});
    return this.operator(e.id);
  }
  // Blocks or gives back the access at the till (the PIN and permissions stay).
  async setActive(employeeId,active,{by}){
    const e=await this.employeeOf(employeeId);const account=await this.account(e.uuid);
    if(!account?.pin_hash)throw httpError(400,'Defina um PIN para este funcionário primeiro.');
    await this.store.run('UPDATE operator_accounts SET active=?,failed_count=0,locked_until=NULL,updated_at=? WHERE id=?',[active?1:0,iso(this.clock()),account.id]);
    if(!active)await this.sessions.destroyFor('operador',account.id);
    await this.audit({username:by,action:active?'acesso_ativado':'acesso_desativado',detail:{funcionario:e.name}});
    return this.operator(e.id);
  }
  // An employee deactivated in the Funcionários screen loses the access too (their sessions end now).
  async employeeDeactivated(uuid){
    const account=await this.account(uuid);if(!account)return;
    await this.store.run('UPDATE operator_accounts SET active=0,updated_at=? WHERE id=?',[iso(this.clock()),account.id]);
    await this.sessions.destroyFor('operador',account.id);
  }
  // One employee as the Admin screen shows them.
  async operator(employeeId){
    const [e,perms]=await Promise.all([this.employeeOf(employeeId),this.db.employeePermissions(employeeId)]);
    const account=await this.account(e.uuid);
    return this.view(e,account,perms);
  }
  view(e,account,perms){
    const now=this.clock();const lockedUntil=account&&Date.parse(account.locked_until||0)>now?account.locked_until:null;
    return {id:e.id,uuid:e.uuid,name:e.name,hasPin:!!account?.pin_hash,active:!!account&&Number(account.active)===1,lockedUntil,
      pinChangedAt:account?.pin_changed_at||null,permissionsChangedAt:account?.permissions_changed_at||null,permissionsChangedBy:account?.permissions_changed_by||null,
      review:!!account?.pin_hash&&account.permissions_digest!==this.digest(e.uuid,e.allowed),
      permissions:Object.fromEntries(CATALOG.map(p=>[p.id,!!perms[p.id]]))};
  }
  async listOperators(){
    const [index,accounts]=await Promise.all([this.db.accessIndex(),this.store.all('SELECT * FROM operator_accounts')]);
    const byUuid=new Map(accounts.map(a=>[a.employee_uuid,a]));const out=[];
    for(const e of [...index.byId.values()].filter(e=>e.active).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR',{sensitivity:'base'}))){
      const allowed=new Set(e.allowed);out.push(this.view(e,byUuid.get(e.uuid),Object.fromEntries([...allowed].map(p=>[p,true]))));
    }
    return out;
  }
}
const iso=ms=>new Date(ms).toISOString();
module.exports={OperatorAuthService,checkPin,WRONG};
