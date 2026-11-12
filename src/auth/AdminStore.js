'use strict';
// config/admin.sqlite: administrator accounts, their sessions, protected (non-secret) settings and the log of
// administrative access. Separate from the commercial database on purpose: restoring a sales backup, moving the sales
// to Supabase or updating the program never changes who can enter the Admin area, and the Admin area keeps working
// when the cloud database is out of reach.
const {SQLiteAdapter}=require('../database/adapters/SQLiteAdapter');
const STEPS=[
  async q=>{await q.exec(`
    CREATE TABLE admin_users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT,
      initial INTEGER NOT NULL DEFAULT 0,must_change INTEGER NOT NULL DEFAULT 0,failed_count INTEGER NOT NULL DEFAULT 0,locked_until TEXT,
      recovery_hash TEXT,recovery_created_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,password_changed_at TEXT);
    CREATE TABLE admin_sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,scope TEXT NOT NULL,
      created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,expires_at TEXT NOT NULL,user_agent TEXT);
    CREATE TABLE admin_settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
    CREATE TABLE admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,username TEXT,action TEXT NOT NULL,ok INTEGER NOT NULL DEFAULT 1,detail TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX admin_audit_at ON admin_audit(at);`);},
  // 2: the employees' individual sign-in at the till. An account belongs to an employee of the commercial database
  // by its uuid (ids are not stable across databases). No account is created here: nobody gets a PIN by default.
  // permissions_digest seals the permissions the administrator saved (see src/auth/OperatorAuthService.js), so
  // permissions that come back from a restored or replaced commercial database are never trusted by themselves.
  // pos_sessions: the till's sessions (an operator's, or the administrator's at the till), one per terminal.
  async q=>{await q.exec(`
    CREATE TABLE operator_accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,employee_uuid TEXT NOT NULL UNIQUE,pin_hash TEXT,active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      failed_count INTEGER NOT NULL DEFAULT 0,locked_until TEXT,permissions_digest TEXT,pin_changed_at TEXT,permissions_changed_at TEXT,permissions_changed_by TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE pos_sessions(token_hash TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK (kind IN ('operador','admin')),account_id INTEGER NOT NULL,admin_token_hash TEXT,
      terminal TEXT NOT NULL,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,expires_at TEXT NOT NULL,locked_at TEXT);
    CREATE INDEX pos_sessions_account ON pos_sessions(kind,account_id);`);}
];
class AdminStore {
  constructor(adapter){this.db=adapter;}
  static async open(file){
    const a=SQLiteAdapter.open(file);const found=await a.schemaVersion();
    if(found>STEPS.length){await a.close();throw Object.assign(Error(`config/admin.sqlite é de uma versão mais nova do PDV (versão ${found}; este programa conhece até a ${STEPS.length}). Instale a versão mais nova ou restaure o backup feito antes da atualização.`),{code:'banco_mais_novo'});}
    for(let v=found;v<STEPS.length;v++)await a.transaction(async q=>{await STEPS[v](q);await q.exec(`PRAGMA user_version=${v+1}`);});
    return new AdminStore(a);
  }
  all(sql,p){return this.db.all(sql,p);}
  get(sql,p){return this.db.get(sql,p);}
  run(sql,p){return this.db.run(sql,p);}
  async setting(k,fallback=null){const r=await this.db.get('SELECT v FROM admin_settings WHERE k=?',[k]);if(!r)return fallback;try{return JSON.parse(r.v);}catch(_){return fallback;}}
  setSetting(k,v){return v===null||v===undefined?this.db.run('DELETE FROM admin_settings WHERE k=?',[k]):this.db.run('INSERT INTO admin_settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',[k,JSON.stringify(v)]);}
  async audit({username=null,action,ok=true,detail={}}){await this.db.run('INSERT INTO admin_audit(at,username,action,ok,detail) VALUES(?,?,?,?,?)',[new Date().toISOString(),username,action,ok?1:0,JSON.stringify(detail)]);}
  async recentAudit(limit=50,actions=null){
    const rows=actions?await this.db.all(`SELECT * FROM admin_audit WHERE action IN (${actions.map(()=>'?').join(',')}) ORDER BY id DESC LIMIT ?`,[...actions,limit])
      :await this.db.all('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?',[limit]);
    return rows.map(r=>({...r,ok:!!r.ok,detail:JSON.parse(r.detail||'{}')}));
  }
  // The administrative log keeps two years; older entries go at start (logs/auditoria.log keeps its own copy).
  pruneAudit(days=730,now=Date.now()){return this.db.run('DELETE FROM admin_audit WHERE at<?',[new Date(now-days*86400000).toISOString()]);}
  close(){return this.db.close();}
}
module.exports={AdminStore,ADMIN_STORE_VERSION:STEPS.length};
