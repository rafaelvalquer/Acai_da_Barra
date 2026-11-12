'use strict';
// Who is at the till, for src/server.js: signing in (an employee with their PIN, or the administrator with their
// password), locking, signing out, and the identity of each request, read from the session on the server. The
// administrator's account and password stay the ones of the Admin area (config/admin.sqlite, AdminAuthService):
// there is no second password for the till.
const crypto=require('node:crypto');
const {PosSessionService}=require('./PosSessionService');const {OperatorAuthService}=require('./OperatorAuthService');
const {AdminSessionService}=require('./AdminSessionService');
const {CATALOG,SCREENS}=require('./PermissionCatalog');const {hasPermission,httpError}=require('./AuthorizationService');
const ALL=new Set(CATALOG.map(p=>p.id));
const SCALE_BUSY='Retire o produto da balança antes de trocar de pessoa no caixa.';
class PosAuth {
  // adminAuth: AdminAuthService; pepper: Buffer (vault: operatorPinPepper); terminal: this computer.
  constructor({adminStore,adminAuth,db,pepper,audit,clock=()=>Date.now(),terminal}){
    Object.assign(this,{adminStore,adminAuth,db,audit,clock});
    this.sessions=new PosSessionService(adminStore,{clock,terminal});
    this.operators=new OperatorAuthService({store:adminStore,db,sessions:this.sessions,pepper,audit,clock});
  }
  // The PIN key is created once per installation and kept in the vault (never in a database or a backup).
  static async pepper(vault){
    let v=vault.get('operatorPinPepper');
    if(!v){v=crypto.randomBytes(32).toString('base64');await vault.update({operatorPinPepper:v});}
    return Buffer.from(v,'base64');
  }
  // The identity of the request, or null. touch: false for the screen's periodic reads (they are not "use").
  // identity: {kind,key,name,employeeId,permissions:Set,locked,token}
  async identify(req,{touch=true}={}){
    const token=PosSessionService.read(req);const s=await this.sessions.get(token,{touch});
    return s?this.identityOf(s,token):null;
  }
  async identityOf(s,token){
    if(s.kind==='admin'){
      const u=await this.adminStore.get('SELECT id,username FROM admin_users WHERE id=?',[s.account_id]);
      if(!u){await this.sessions.destroyHash(s.token_hash);return null;}
      return {kind:'admin',key:`admin:${u.id}`,adminUserId:u.id,username:u.username,name:`Administrador (${u.username})`,employeeId:null,permissions:ALL,locked:!!s.locked_at,token};
    }
    const account=await this.operators.accountById(s.account_id);const index=await this.db.accessIndex();
    const employee=account?index.byUuid.get(account.employee_uuid):null;const permissions=this.operators.effective(account,employee);
    // PIN changed, access blocked, employee deactivated, permissions under review: the session is over.
    if(!permissions){await this.sessions.destroyHash(s.token_hash);return null;}
    return {kind:'operador',key:`operador:${account.id}`,accountId:account.id,uuid:employee.uuid,name:employee.name,employeeId:employee.id,permissions,locked:!!s.locked_at,token};
  }
  // What the store records as the person doing an operation.
  static actor(identity){return {kind:identity.kind,employeeId:identity.employeeId??null,name:identity.name};}
  // What the screen may know about the session: the person, the screens and the permissions (never the token).
  static view(identity){
    if(!identity)return {authenticated:false};
    const permissions=CATALOG.map(p=>p.id).filter(p=>hasPermission({...identity,locked:false},p));
    const person={kind:identity.kind,name:identity.name,employeeId:identity.employeeId,uuid:identity.uuid||null,username:identity.username||null};
    if(identity.locked)return {authenticated:false,locked:true,person};
    return {authenticated:true,locked:false,person,isAdmin:identity.kind==='admin',permissions,screens:SCREENS.filter(s=>permissions.includes(s.id)).map(s=>s.tab)};
  }
  options(){return this.operators.loginOptions();}
  // Someone else may not take over the till with weight on the scale (that cup belongs to the sale on screen).
  async guardSwitch(key,scaleIdle){
    if(scaleIdle)return;const last=await this.sessions.lastIdentity();
    if(last&&last!==key)throw httpError(409,SCALE_BUSY,{scaleBusy:true});
  }
  // body: {employeeUuid,pin} or {mode:'admin',username,password}. Returns the cookies to set and the session view.
  async login(body,{scaleIdle,userAgent=''}){
    if(body?.mode==='admin'){
      const r=await this.adminAuth.login({username:body.username,password:body.password,userAgent});
      const adminCookie=AdminSessionService.cookie(r.token);
      // First access or a forced change: the password is changed in the Admin area before anything else.
      if(r.user.mustChangePassword)return {cookies:[adminCookie],mustChangePassword:true,session:{authenticated:false}};
      const user=await this.adminAuth.user(r.user.username);
      try{await this.guardSwitch(`admin:${user.id}`,scaleIdle);}catch(e){await this.adminStore.run('DELETE FROM admin_sessions WHERE user_id=?',[user.id]);throw e;}
      const token=await this.sessions.create({kind:'admin',accountId:user.id,adminToken:r.token});
      await this.audit({username:user.username,action:'login_operador',detail:{perfil:'administrador',terminal:this.sessions.terminal}});
      return {cookies:[adminCookie,PosSessionService.cookie(token)],session:await this.viewOf(token)};
    }
    const {account,employee}=await this.operators.verify({employeeUuid:body?.employeeUuid,pin:body?.pin});
    await this.guardSwitch(`operador:${account.id}`,scaleIdle);
    // An employee signing in ends any Admin area session open on this computer: it is someone else at the keyboard now.
    await this.adminStore.run('DELETE FROM admin_sessions');
    const token=await this.sessions.create({kind:'operador',accountId:account.id});
    await this.audit({username:employee.name,action:'login_operador',detail:{terminal:this.sessions.terminal}});
    return {cookies:[PosSessionService.cookie(token),AdminSessionService.clearCookie()],session:await this.viewOf(token)};
  }
  async viewOf(token){const s=await this.sessions.get(token,{touch:false});return PosAuth.view(s?await this.identityOf(s,token):null);}
  // The administrator already in the Admin area takes the till too (same sign-in, no second password).
  async adminAtTill(adminSession,{scaleIdle}){
    await this.guardSwitch(`admin:${adminSession.userId}`,scaleIdle);
    const token=await this.sessions.create({kind:'admin',accountId:adminSession.userId,adminToken:adminSession.token});
    await this.audit({username:adminSession.username,action:'login_operador',detail:{perfil:'administrador',terminal:this.sessions.terminal}});
    return {cookies:[PosSessionService.cookie(token)],session:await this.viewOf(token)};
  }
  async logout(req,{scaleIdle}){
    const token=PosSessionService.read(req);const s=await this.sessions.get(token,{touch:false});
    if(s){
      if(!scaleIdle)throw httpError(409,'Retire o produto da balança antes de sair.',{scaleBusy:true});
      const who=await this.identityOf(s,token);await this.sessions.destroy(token);
      if(who)await this.audit({username:who.kind==='admin'?who.username:who.name,action:'logout_operador'});
    }
    return {cookies:[PosSessionService.clearCookie(),AdminSessionService.clearCookie()]};
  }
  // The till stays as it is (open sales, the reading on the scale) until the same person types the PIN again.
  async lock(req){
    const token=PosSessionService.read(req);const s=await this.sessions.get(token,{touch:false});
    if(!s)throw httpError(401,'Entre com o seu usuário para usar o caixa.',{auth:'login'});
    const who=await this.identityOf(s,token);if(!who)throw httpError(401,'Entre com o seu usuário para usar o caixa.',{auth:'login'});
    await this.sessions.lock(token);
    await this.audit({username:who.kind==='admin'?who.username:who.name,action:'terminal_bloqueado'});
    return {cookies:[AdminSessionService.clearCookie()],session:PosAuth.view({...who,locked:true})};
  }
  // For the scale's automatic capture: the person signed in now, if they may put items in a sale.
  async terminalActor(){
    const s=await this.sessions.current();if(!s)return null;
    const who=await this.identityOf(s,null).catch(()=>null);
    return who&&!who.locked&&hasPermission(who,'sales.create')?PosAuth.actor(who):null;
  }
  async employeeDeactivated(employeeId){
    const e=(await this.db.accessIndex()).byId.get(Number(employeeId));if(e)await this.operators.employeeDeactivated(e.uuid);
  }
  // The administrator's password changed or was recovered: their till sessions end too.
  adminSessionsEnded(userId){return this.sessions.destroyFor('admin',userId);}
}
module.exports={PosAuth};
