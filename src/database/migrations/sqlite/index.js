'use strict';
// SQLite schema. The v0.1 tables come first; PRAGMA user_version records how many numbered steps ran. Each step is
// idempotent, so a database that already got some of these columns before the numbering existed converges to the
// same schema, and existing rows are always kept.
const {randomUUID}=require('node:crypto');const {classifyProducts}=require('../../catalog');
const BASE=`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,price_cents INTEGER NOT NULL,stock INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY AUTOINCREMENT,opened_at TEXT NOT NULL,opening_cents INTEGER NOT NULL,closed_at TEXT, counted_cents INTEGER,expected_cents INTEGER, difference_cents INTEGER);
  CREATE UNIQUE INDEX IF NOT EXISTS one_shift ON shifts((closed_at IS NULL)) WHERE closed_at IS NULL;
  CREATE TABLE IF NOT EXISTS cash_events(id INTEGER PRIMARY KEY AUTOINCREMENT,shift_id INTEGER NOT NULL,kind TEXT NOT NULL,amount_cents INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,FOREIGN KEY (shift_id) REFERENCES shifts(id));
  CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE NOT NULL,shift_id INTEGER NOT NULL,created_at TEXT NOT NULL,method TEXT NOT NULL,total_cents INTEGER NOT NULL,FOREIGN KEY (shift_id) REFERENCES shifts(id));
  CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL,product_id INTEGER,kind TEXT NOT NULL,label TEXT NOT NULL,grams INTEGER,quantity INTEGER,unit_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,FOREIGN KEY (sale_id) REFERENCES sales(id));
  CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);`;
async function addColumn(q,table,column,def){
  if(!(await q.all(`PRAGMA table_info(${table})`)).some(c=>c.name===column))await q.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
const STEPS=[
  // 1: operators, cancellation and typed entries.
  async q=>{for(const [table,column,def] of [['shifts','opened_by','INTEGER'],['shifts','closed_by','INTEGER'],['sales','operator_id','INTEGER'],['sales','status',"TEXT NOT NULL DEFAULT 'done'"],['sales','canceled_at','TEXT'],['sales','canceled_by','INTEGER'],['sales','cancel_reason','TEXT'],['sale_items','manual','INTEGER NOT NULL DEFAULT 0'],['cash_events','operator_id','INTEGER']])await addColumn(q,table,column,def);
    await q.exec('CREATE INDEX IF NOT EXISTS sales_created ON sales(created_at); CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);');},
  // 2: amount received and change on cash sales.
  async q=>{await addColumn(q,'sales','received_cents','INTEGER');await addColumn(q,'sales','change_cents','INTEGER');},
  // 3: open sales (one per customer being served), stored instead of kept in memory so a restart loses nothing.
  async q=>{await q.exec(`CREATE TABLE IF NOT EXISTS draft_sales(id TEXT PRIMARY KEY,shift_id INTEGER NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',operator_id INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,revision INTEGER NOT NULL DEFAULT 0,sale_id INTEGER,FOREIGN KEY (shift_id) REFERENCES shifts(id));
      CREATE INDEX IF NOT EXISTS draft_sales_open ON draft_sales(status,shift_id);
      CREATE TABLE IF NOT EXISTS draft_sale_items(id TEXT PRIMARY KEY,draft_sale_id TEXT NOT NULL,product_id INTEGER,kind TEXT NOT NULL,label TEXT NOT NULL,grams INTEGER,quantity INTEGER,unit_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,manual INTEGER NOT NULL DEFAULT 0,scale_capture_id TEXT UNIQUE,created_at TEXT NOT NULL,FOREIGN KEY (draft_sale_id) REFERENCES draft_sales(id));
      CREATE INDEX IF NOT EXISTS draft_items_sale ON draft_sale_items(draft_sale_id);
      CREATE TABLE IF NOT EXISTS draft_sale_events(id INTEGER PRIMARY KEY AUTOINCREMENT,draft_sale_id TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',operator_id INTEGER,created_at TEXT NOT NULL);`);
    await addColumn(q,'shifts','active_draft_id','TEXT');await addColumn(q,'sales','draft_sale_id','TEXT');
    // One open sale can become at most one finished sale, whatever reaches checkout twice.
    await q.exec('CREATE UNIQUE INDEX IF NOT EXISTS sales_draft ON sales(draft_sale_id) WHERE draft_sale_id IS NOT NULL');},
  // 4: ready for PostgreSQL and for production: UUIDs on records, an explicit order for open sales and their items
  // (no rowid in PostgreSQL) and indexes for the reports. Administrator accounts live apart, in config/admin.sqlite.
  async q=>{
    for(const table of ['draft_sales','draft_sale_items']){await addColumn(q,table,'seq','INTEGER');await q.exec(`UPDATE ${table} SET seq=rowid WHERE seq IS NULL`);}
    for(const table of ['employees','products','shifts','cash_events','draft_sale_events']){
      await addColumn(q,table,'uuid','TEXT');
      for(const r of await q.all(`SELECT id FROM ${table} WHERE uuid IS NULL`))await q.run(`UPDATE ${table} SET uuid=? WHERE id=?`,[randomUUID(),r.id]);
      await q.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_uuid ON ${table}(uuid)`);
    }
    await q.exec(`CREATE INDEX IF NOT EXISTS sales_shift ON sales(shift_id); CREATE INDEX IF NOT EXISTS cash_events_shift ON cash_events(shift_id);
      CREATE INDEX IF NOT EXISTS draft_events_sale ON draft_sale_events(draft_sale_id); CREATE INDEX IF NOT EXISTS draft_items_seq ON draft_sale_items(seq);`);
  },
  // 5: category, sales channel (shop counter or delivery) and favorite, for finding products fast at the till. Names,
  // prices and stock stay as they are; the first classification comes from the name (src/database/catalog.js).
  async q=>{
    await addColumn(q,'products','category',"TEXT NOT NULL DEFAULT 'Outros'");
    await addColumn(q,'products','channel',"TEXT NOT NULL DEFAULT 'loja' CHECK (channel IN ('loja','delivery'))");
    await addColumn(q,'products','is_favorite','INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1))');
    await classifyProducts(q);
  }
];
// until: stops at that version (tests and old backups rebuilt at the version they were made in).
async function migrateSqlite(adapter,{until=STEPS.length}={}){
  await adapter.exec(BASE);
  for(let v=await adapter.schemaVersion();v<Math.min(until,STEPS.length);v++)
    await adapter.transaction(async q=>{await STEPS[v](q);await q.exec(`PRAGMA user_version=${v+1}`);});
}
module.exports={migrateSqlite,SQLITE_VERSION:STEPS.length};
