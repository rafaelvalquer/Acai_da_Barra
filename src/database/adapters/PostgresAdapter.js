'use strict';
// Persistence over PostgreSQL (Supabase in the future; PGlite in the tests). Same contract as SQLiteAdapter, so the
// services and their financial rules run unchanged: SQL is written with "?" placeholders and turned into $1, $2…
const fs=require('node:fs');
const INT8=20,NUMERIC=1700,TIMESTAMPTZ=1184;
const toPg=sql=>{let i=0;return sql.replace(/\?/g,()=>'$'+(++i));};
const bind=params=>params.map(v=>v===undefined?null:typeof v==='boolean'?(v?1:0):v);
// Only a plain SELECT is sure not to write; anything else (INSERT … RETURNING through get, …) counts as a write.
const READ_ONLY=/^\s*select\b/i;
// Values come back exactly as SQLite returns them: counts and sums as numbers, timestamps as ISO strings in UTC.
const asNumber=v=>v===null||v===undefined?v:Number(v);
const asIso=v=>{if(v===null||v===undefined)return v;const d=new Date(String(v).replace(' ','T').replace(/([+-]\d\d)$/,'$1:00'));return Number.isNaN(d.getTime())?String(v):d.toISOString();};
const PARSERS={[INT8]:asNumber,[NUMERIC]:asNumber,[TIMESTAMPTZ]:asIso};

// Database URL without sslmode: TLS is configured here, always on, verifying the server certificate.
function cleanUrl(url){try{const u=new URL(url);u.searchParams.delete('sslmode');return u.toString();}catch(_){throw Error('DATABASE_URL inválida');}}

function pgDriver(pool){
  const wrap=r=>({rows:r.rows||[],count:r.rowCount??0});
  return {
    query:async(text,params)=>wrap(await pool.query(text,params)),
    exec:async sql=>{await pool.query(sql);},
    transaction:async fn=>{
      const client=await pool.connect();let broken=false;
      try{await client.query('BEGIN');const result=await fn({query:async(t,p)=>wrap(await client.query(t,p)),exec:async sql=>{await client.query(sql);}});await client.query('COMMIT');return result;}
      // A connection whose ROLLBACK did not go through (timeout, dropped network) is closed, never reused.
      catch(e){try{await client.query('ROLLBACK');}catch(_){broken=true;}throw e;}
      finally{client.release(broken||undefined);}
    },
    close:()=>pool.end()
  };
}
function pgliteDriver(db){
  const wrap=r=>({rows:r.rows||[],count:r.affectedRows??0});
  return {
    query:async(text,params)=>wrap(await db.query(text,params)),
    exec:async sql=>{await db.exec(sql);},
    transaction:fn=>db.transaction(tx=>fn({query:async(t,p)=>wrap(await tx.query(t,p)),exec:async sql=>{await tx.exec(sql);}})),
    close:()=>db.close()
  };
}

class PostgresAdapter {
  constructor(driver,{label='PostgreSQL'}={}){
    this.driver=driver;this.dialect='postgres';this.provider='postgres';this.label=label;this.inTransaction=false;this.onQuery=null;this.filename=null;
    // Goes up before and after every statement that may write (anything but a SELECT, and every transaction): the
    // store keeps the screen state while it stays the same.
    this.writes=0;
  }
  track(sql){if(!READ_ONLY.test(sql))this.writes++;}
  // Connection to a real server (Supabase): TLS required and the server certificate verified; the CA can be given as
  // PEM text (ca, saved from the admin screen) or as a file (PDV_DATABASE_CA_FILE).
  // Every query crosses the internet, so connections are kept open (a new one costs several round trips: network,
  // TLS and password) with TCP keep-alive, so a connection dropped by the router is noticed instead of hanging. A
  // query that gets no answer in 30 s fails: the PDV runs one operation at a time and must never stay stuck.
  static async connect({connectionString,caFile=null,ca=null,ssl=true,max=6,timeoutMs=10000,queryTimeoutMs=30000}){
    if(!connectionString)throw Error('Configure DATABASE_URL para usar o PostgreSQL');
    const {Pool,types}=require('pg');
    const pool=new Pool({connectionString:cleanUrl(connectionString),max,
      ssl:ssl?{rejectUnauthorized:true,...(ca||caFile?{ca:ca||fs.readFileSync(caFile,'utf8')}:{})}:false,connectionTimeoutMillis:timeoutMs,
      idleTimeoutMillis:10*60*1000,keepAlive:true,keepAliveInitialDelayMillis:30000,query_timeout:queryTimeoutMs,
      types:{getTypeParser:(oid,format)=>PARSERS[oid]||types.getTypeParser(oid,format)}});
    pool.on('connect',client=>{client.query("SET TIME ZONE 'UTC'").catch(()=>{});});
    pool.on('error',e=>console.error('PostgreSQL:',e.message));
    const adapter=new PostgresAdapter(pgDriver(pool));
    try{await adapter.get('SELECT 1 AS ok');}catch(e){await pool.end().catch(()=>{});throw e;}
    return adapter;
  }
  // In-process PostgreSQL (PGlite): used by the tests and by the migration rehearsal, no server needed.
  static async pglite(instance=null){
    let db=instance;
    if(!db){const {PGlite}=require('@electric-sql/pglite');db=new PGlite({parsers:PARSERS});await db.waitReady;}
    await db.exec("SET TIME ZONE 'UTC'");
    return new PostgresAdapter(pgliteDriver(db),{label:'PGlite'});
  }
  hook(sql){if(this.onQuery)this.onQuery(sql);}
  guard(){if(this.inTransaction)throw Error('Consulta fora da transação em andamento');}
  async all(sql,params=[]){this.guard();this.hook(sql);this.track(sql);try{return (await this.driver.query(toPg(sql),bind(params))).rows;}finally{this.track(sql);}}
  async get(sql,params=[]){return (await this.all(sql,params))[0]||null;}
  async run(sql,params=[]){this.guard();this.hook(sql);this.track(sql);try{return {changes:(await this.driver.query(toPg(sql),bind(params))).count};}finally{this.track(sql);}}
  async exec(sql){this.guard();this.hook(sql);this.writes++;try{await this.driver.exec(sql);}finally{this.writes++;}}
  async transaction(fn){
    if(this.inTransaction)throw Error('Transação já em andamento');
    this.inTransaction=true;this.writes++;
    try{
      return await this.driver.transaction(q=>fn({dialect:'postgres',
        all:async(sql,p=[])=>{this.hook(sql);return (await q.query(toPg(sql),bind(p))).rows;},
        get:async(sql,p=[])=>{this.hook(sql);return (await q.query(toPg(sql),bind(p))).rows[0]||null;},
        run:async(sql,p=[])=>{this.hook(sql);return {changes:(await q.query(toPg(sql),bind(p))).count};},
        exec:async sql=>{this.hook(sql);await q.exec(sql);}}));
    }finally{this.inTransaction=false;this.writes++;}
  }
  async schemaVersion(){
    const t=await this.get("SELECT to_regclass('schema_migrations') AS t");if(!t||!t.t)return 0;
    return (await this.get('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations')).v;
  }
  async tableNames(){return (await this.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).map(r=>r.name);}
  async close(){try{await this.driver.close();}catch(_){}}
}
module.exports={PostgresAdapter,PARSERS,toPg};
