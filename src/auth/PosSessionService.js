'use strict';
// Sessions of the till (config/admin.sqlite, table pos_sessions). The browser holds only a random token in an
// HttpOnly, SameSite=Strict cookie limited to /api: page scripts cannot read it and other sites cannot send it. Only
// the token's SHA-256 is stored.
//   operator      ends after 30 minutes without use, or 12 hours after signing in
//   administrator ends after 15 minutes without use, or 8 hours after signing in (as in the Admin area)
// One identity per terminal: signing in replaces whatever session the terminal had. The screen asking for its state
// every second is not "use": only what the person does keeps the session alive.
const crypto=require('node:crypto');
const COOKIE='luminor_pos';
const LIMITS={operador:{idle:30*60*1000,max:12*3600*1000},admin:{idle:15*60*1000,max:8*3600*1000}};
const TOUCH_EVERY_MS=15*1000;
const hash=t=>crypto.createHash('sha256').update(String(t)).digest('hex');
const iso=ms=>new Date(ms).toISOString();
class PosSessionService {
  constructor(store,{clock=()=>Date.now(),terminal='este-computador'}={}){this.store=store;this.clock=clock;this.terminal=String(terminal).slice(0,120);}
  // kind: 'operador' (accountId: operator_accounts.id) or 'admin' (accountId: admin_users.id). adminToken: the Admin
  // area session opened in the same sign-in, which ends together with this one.
  async create({kind,accountId,adminToken=null}){
    if(!LIMITS[kind])throw Error('Tipo de sessão inválido');
    const token=crypto.randomBytes(32).toString('base64url');const now=this.clock();
    const replaced=await this.store.all('SELECT admin_token_hash FROM pos_sessions WHERE terminal=? AND admin_token_hash IS NOT NULL',[this.terminal]);
    await this.store.run('DELETE FROM pos_sessions WHERE terminal=?',[this.terminal]);
    for(const r of replaced)await this.store.run('DELETE FROM admin_sessions WHERE token_hash=?',[r.admin_token_hash]);
    await this.store.run('INSERT INTO pos_sessions(token_hash,kind,account_id,admin_token_hash,terminal,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      [hash(token),kind,accountId,adminToken?hash(adminToken):null,this.terminal,iso(now),iso(now),iso(now+LIMITS[kind].max)]);
    return token;
  }
  expired(s,now=this.clock()){const l=LIMITS[s.kind];return !l||Date.parse(s.expires_at)<=now||Date.parse(s.last_seen_at)+l.idle<=now;}
  // The session of this token, or null (missing, expired). touch: counts as use (refreshes the idle time, at most
  // every few seconds so that a busy till is not writing all the time). A locked session is returned with locked.
  async get(token,{touch=true}={}){
    if(!token)return null;const now=this.clock();
    const s=await this.store.get('SELECT * FROM pos_sessions WHERE token_hash=?',[hash(token)]);
    if(!s||this.expired(s,now))return null;
    if(touch&&!s.locked_at&&Date.parse(s.last_seen_at)+TOUCH_EVERY_MS<=now){await this.store.run('UPDATE pos_sessions SET last_seen_at=? WHERE token_hash=?',[iso(now),s.token_hash]);s.last_seen_at=iso(now);}
    return {...s,token,locked:!!s.locked_at};
  }
  // The session the terminal is working with now (for the scale's automatic capture): valid and not locked.
  async current(){
    const s=await this.store.get('SELECT * FROM pos_sessions WHERE terminal=? ORDER BY created_at DESC LIMIT 1',[this.terminal]);
    return s&&!s.locked_at&&!this.expired(s)?s:null;
  }
  // Who was last signed in at this terminal, even if that session expired or is locked: the same person may come
  // back with weight on the scale, another one may not.
  async lastIdentity(){
    const s=await this.store.get('SELECT kind,account_id FROM pos_sessions WHERE terminal=? ORDER BY created_at DESC LIMIT 1',[this.terminal]);
    return s?`${s.kind}:${s.account_id}`:null;
  }
  async lock(token){await this.store.run('UPDATE pos_sessions SET locked_at=? WHERE token_hash=?',[iso(this.clock()),hash(token)]);await this.endAdminArea(hash(token));}
  destroy(token){return this.destroyHash(hash(token));}
  async destroyHash(tokenHash){await this.endAdminArea(tokenHash);await this.store.run('DELETE FROM pos_sessions WHERE token_hash=?',[tokenHash]);}
  // The Admin area session opened together with this one ends with it (lock, sign-out, another person signing in).
  async endAdminArea(tokenHash){
    const s=await this.store.get('SELECT admin_token_hash FROM pos_sessions WHERE token_hash=?',[tokenHash]);
    if(s?.admin_token_hash)await this.store.run('DELETE FROM admin_sessions WHERE token_hash=?',[s.admin_token_hash]);
  }
  // Every session of one account (PIN reset, access blocked, a critical permission removed, password changed).
  async destroyFor(kind,accountId){
    const rows=await this.store.all('SELECT admin_token_hash FROM pos_sessions WHERE kind=? AND account_id=? AND admin_token_hash IS NOT NULL',[kind,accountId]);
    for(const r of rows)await this.store.run('DELETE FROM admin_sessions WHERE token_hash=?',[r.admin_token_hash]);
    return this.store.run('DELETE FROM pos_sessions WHERE kind=? AND account_id=?',[kind,accountId]);
  }
  static cookie(token){return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${LIMITS.operador.max/1000}`;}
  static clearCookie(){return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`;}
  static read(req){
    for(const part of String(req.headers.cookie||'').split(';')){const [k,...v]=part.trim().split('=');if(k===COOKIE)return v.join('=');}
    return null;
  }
}
module.exports={PosSessionService,COOKIE,LIMITS};
