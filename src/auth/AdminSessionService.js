'use strict';
// Administrator sessions, kept on the server (config/admin.sqlite). The browser holds only a random token in an
// HttpOnly, SameSite=Strict cookie limited to /api/admin: page scripts cannot read it and other sites cannot send it.
// Only the token's SHA-256 is stored. A session ends after 15 minutes without use or 8 hours after sign-in, and a new
// one is issued at every sign-in and password change (the old ones are removed).
const crypto=require('node:crypto');
const COOKIE='luminor_admin';const IDLE_MS=15*60*1000,MAX_MS=8*3600*1000;
const hash=t=>crypto.createHash('sha256').update(String(t)).digest('hex');
class AdminSessionService {
  constructor(store,{clock=()=>Date.now()}={}){this.store=store;this.clock=clock;}
  // scope: "completo" (the Admin area) or "troca-senha" (only to set a new password: first access, reset).
  async create(userId,scope,userAgent=''){
    const token=crypto.randomBytes(32).toString('base64url');const now=this.clock();
    await this.store.run('DELETE FROM admin_sessions WHERE expires_at<?',[new Date(now).toISOString()]);
    await this.store.run('INSERT INTO admin_sessions(token_hash,user_id,scope,created_at,last_seen_at,expires_at,user_agent) VALUES(?,?,?,?,?,?,?)',
      [hash(token),userId,scope,new Date(now).toISOString(),new Date(now).toISOString(),new Date(now+MAX_MS).toISOString(),String(userAgent).slice(0,200)]);
    return token;
  }
  // The session and its user, refreshed; null when missing or expired.
  async get(token){
    if(!token)return null;const now=this.clock();
    const s=await this.store.get('SELECT s.*,u.username FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=?',[hash(token)]);
    if(!s)return null;
    if(Date.parse(s.expires_at)<now||Date.parse(s.last_seen_at)+IDLE_MS<now){await this.destroy(token);return null;}
    await this.store.run('UPDATE admin_sessions SET last_seen_at=? WHERE token_hash=?',[new Date(now).toISOString(),s.token_hash]);
    return {userId:s.user_id,username:s.username,scope:s.scope,createdAt:s.created_at,token};
  }
  destroy(token){return this.store.run('DELETE FROM admin_sessions WHERE token_hash=?',[hash(token)]);}
  destroyAll(userId){return this.store.run('DELETE FROM admin_sessions WHERE user_id=?',[userId]);}
  static cookie(token){return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${MAX_MS/1000}`;}
  static clearCookie(){return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0`;}
  static read(req){
    for(const part of String(req.headers.cookie||'').split(';')){const [k,...v]=part.trim().split('=');if(k===COOKIE)return v.join('=');}
    return null;
  }
}
module.exports={AdminSessionService,COOKIE,IDLE_MS,MAX_MS};
