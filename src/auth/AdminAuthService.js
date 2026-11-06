'use strict';
// Signing in to the Admin area, checked here on the server and never in the browser. Five wrong attempts lock the
// account for 5 minutes (the lock survives a restart). Every sign-in, failure, sign-out and password change is
// written to the administrative access log.
const crypto=require('node:crypto');
const {hashPassword,verifyPassword,checkNewPassword,checkUsername,newRecoveryCode,normalizeCode}=require('./PasswordService');
const {INITIAL_USER,INITIAL_PASSWORD}=require('./AdminBootstrap');
const MAX_FAILS=5,LOCK_MS=5*60*1000;
const ACCESS=['login','login_falhou','login_bloqueado','logout','senha_alterada','usuario_alterado','recuperacao_usada','recuperacao_falhou','codigo_recuperacao_gerado','confirmacao_falhou'];
const httpError=(status,message)=>Object.assign(Error(message),{status});
const same=(a,b)=>crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a??'')).digest(),crypto.createHash('sha256').update(String(b??'')).digest());
class AdminAuthService {
  // audit(entry): admin.sqlite and logs/auditoria.log.
  constructor({store,sessions,bootstrap,vault,audit,clock=()=>Date.now()}){Object.assign(this,{store,sessions,bootstrap,vault,audit,clock});this.unknownFails=new Map();}
  user(username){return this.store.get('SELECT * FROM admin_users WHERE username=? COLLATE NOCASE',[String(username||'').trim()]);}
  userById(id){return this.store.get('SELECT * FROM admin_users WHERE id=?',[id]);}
  locked(user,key){
    const until=user?Date.parse(user.locked_until||0):(this.unknownFails.get(key)?.until||0);
    return until>this.clock()?until:0;
  }
  async failed(user,key,action='login_falhou'){
    const now=this.clock();let count,until=null;
    if(user){count=(Date.parse(user.locked_until||0)&&Date.parse(user.locked_until)<=now?0:user.failed_count)+1;if(count>=MAX_FAILS)until=new Date(now+LOCK_MS).toISOString();
      await this.store.run('UPDATE admin_users SET failed_count=?,locked_until=? WHERE id=?',[count>=MAX_FAILS?0:count,until,user.id]);}
    else{const f=this.unknownFails.get(key);count=(f&&!f.until?f.count:0)+1;this.unknownFails.set(key,{count:count>=MAX_FAILS?0:count,until:count>=MAX_FAILS?now+LOCK_MS:0});until=count>=MAX_FAILS;}
    await this.audit({username:user?.username||key,action,ok:false,detail:until?{bloqueado:true}:{}});
    return !!until;
  }
  async login({username,password,userAgent=''}){
    const key=String(username||'').trim().toLowerCase().slice(0,64);const user=await this.user(key);
    if(this.locked(user,key)){await this.audit({username:key,action:'login_bloqueado',ok:false});throw httpError(429,'Muitas tentativas incorretas. Aguarde 5 minutos e tente de novo.');}
    const initial=this.bootstrap.initialAllowed(user)&&same(key,INITIAL_USER)&&same(password,INITIAL_PASSWORD);
    const ok=initial||(user?.password_hash?await verifyPassword(user.password_hash,password):(await verifyPassword(null,password),false));
    if(!ok){
      const nowLocked=await this.failed(user,key);
      throw httpError(nowLocked?429:401,nowLocked?'Muitas tentativas incorretas. Aguarde 5 minutos e tente de novo.':'Usuário ou senha incorretos.');
    }
    this.unknownFails.delete(key);
    await this.store.run('UPDATE admin_users SET failed_count=0,locked_until=NULL WHERE id=?',[user.id]);
    const scope=initial||user.must_change?'troca-senha':'completo';
    const token=await this.sessions.create(user.id,scope,userAgent);
    await this.audit({username:user.username,action:'login',detail:{escopo:scope}});
    return {token,user:{username:user.username,mustChangePassword:scope!=='completo',initial}};
  }
  async logout(session){if(!session)return;await this.sessions.destroy(session.token);await this.audit({username:session.username,action:'logout'});}
  // The current password typed again, for operations that change or replace data.
  async confirm(session,password){
    const user=await this.userById(session.userId);
    if(this.locked(user))throw httpError(429,'Muitas tentativas incorretas. Aguarde 5 minutos.');
    if(user?.password_hash&&await verifyPassword(user.password_hash,password))return user;
    if(await this.failed(user,user?.username,'confirmacao_falhou'))await this.sessions.destroyAll(user.id);
    throw httpError(401,'Senha atual incorreta.');
  }
  // First access (initial password), forced change, recovery, or a normal change: a new session is issued and every
  // other session of the account ends.
  async changePassword(session,{current,next,userAgent=''}){
    const user=await this.userById(session.userId);
    if(session.scope==='recuperacao'){/* opened with the emergency code */}
    else if(this.bootstrap.initialAllowed(user)){if(!same(current,INITIAL_PASSWORD))throw httpError(401,'Senha atual incorreta.');}
    else await this.confirm(session,current);
    const password=checkNewPassword(next,{username:user.username,current:session.scope==='recuperacao'?'':current});
    const hash=await hashPassword(password);const now=new Date(this.clock()).toISOString();
    await this.store.run('UPDATE admin_users SET password_hash=?,initial=0,must_change=0,failed_count=0,locked_until=NULL,password_changed_at=?,updated_at=? WHERE id=?',[hash,now,now,user.id]);
    if(!this.vault.get('adminInitializedAt'))await this.bootstrap.markInitialized(user.username);
    await this.sessions.destroyAll(user.id);const token=await this.sessions.create(user.id,'completo',userAgent);
    await this.audit({username:user.username,action:'senha_alterada',detail:{via:session.scope}});
    return {token,user:{username:user.username,mustChangePassword:false}};
  }
  async changeUsername(session,{username,password}){
    const user=await this.confirm(session,password);const name=checkUsername(username);
    const other=await this.user(name);if(other&&other.id!==user.id)throw httpError(400,'Já existe um administrador com esse usuário.');
    await this.store.run('UPDATE admin_users SET username=?,updated_at=? WHERE id=?',[name,new Date(this.clock()).toISOString(),user.id]);
    await this.vault.update({adminUsername:name});
    await this.audit({username:name,action:'usuario_alterado',detail:{anterior:user.username}});
    return {username:name};
  }
  // A new emergency code replaces the previous one. It is shown once; only its hash stays (here and in the vault).
  async newRecoveryCode(session,{password}){
    const user=await this.confirm(session,password);const code=newRecoveryCode();const hash=await hashPassword(normalizeCode(code));const now=new Date(this.clock()).toISOString();
    await this.store.run('UPDATE admin_users SET recovery_hash=?,recovery_created_at=? WHERE id=?',[hash,now,user.id]);
    await this.vault.update({adminRecoveryHash:hash,adminRecoveryCreatedAt:now});
    await this.audit({username:user.username,action:'codigo_recuperacao_gerado'});
    return {code,createdAt:now};
  }
  // Forgotten password: the emergency code opens a session that can only set a new password. The code is used up.
  async recover({username,code,userAgent=''}){
    const key=String(username||'').trim().toLowerCase().slice(0,64);const user=await this.user(key);
    if(this.locked(user,key))throw httpError(429,'Muitas tentativas incorretas. Aguarde 5 minutos e tente de novo.');
    const ok=user?.recovery_hash?await verifyPassword(user.recovery_hash,normalizeCode(code)):(await verifyPassword(null,code),false);
    if(!ok){const l=await this.failed(user,key,'recuperacao_falhou');throw httpError(l?429:401,l?'Muitas tentativas incorretas. Aguarde 5 minutos.':'Usuário ou código de recuperação incorretos.');}
    await this.store.run('UPDATE admin_users SET recovery_hash=NULL,recovery_created_at=NULL,must_change=1,failed_count=0,locked_until=NULL WHERE id=?',[user.id]);
    await this.vault.update({adminRecoveryHash:null,adminRecoveryCreatedAt:null});
    await this.sessions.destroyAll(user.id);const token=await this.sessions.create(user.id,'recuperacao',userAgent);
    await this.audit({username:user.username,action:'recuperacao_usada'});
    return {token,user:{username:user.username,mustChangePassword:true}};
  }
  async status(session){
    const state=await this.bootstrap.state();const u=session?await this.userById(session.userId):null;
    return {state,authenticated:!!session,user:session?{username:session.username,scope:session.scope,mustChangePassword:session.scope!=='completo',
      hasRecoveryCode:!!u?.recovery_hash,recoveryCreatedAt:u?.recovery_created_at||null,passwordChangedAt:u?.password_changed_at||null}:null};
  }
  recentAccess(limit=30){return this.store.recentAudit(limit,ACCESS);}
  // Emergency reset from the command line (needs access to this computer's config folder): a temporary password
  // that must be changed at the next sign-in. Never the initial password.
  async resetWithTemporaryPassword(){
    const user=await this.store.get('SELECT * FROM admin_users ORDER BY id LIMIT 1');if(!user)throw Error('Nenhum administrador cadastrado.');
    const temp=crypto.randomBytes(12).toString('base64url');const now=new Date(this.clock()).toISOString();
    await this.store.run('UPDATE admin_users SET password_hash=?,initial=0,must_change=1,failed_count=0,locked_until=NULL,updated_at=? WHERE id=?',[await hashPassword(temp),now,user.id]);
    if(!this.vault.get('adminInitializedAt'))await this.bootstrap.markInitialized(user.username);
    await this.sessions.destroyAll(user.id);await this.audit({username:user.username,action:'senha_redefinida_local'});
    return {username:user.username,temporaryPassword:temp};
  }
}
module.exports={AdminAuthService,httpError};
