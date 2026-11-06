'use strict';
const fs=require('node:fs');const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {randomUUID}=require('node:crypto');
const {readMoney,readWeight,calcTotal}=require('./protocol');
const ROOT=path.resolve(__dirname,'..');
const DAY_MS=86400000;
function now(){return new Date().toISOString();}
function assert(condition,msg){if(!condition)throw Error(msg);}
function integer(v,name,min=0,max=1000000){const n=Number(v);assert(Number.isSafeInteger(n)&&n>=min&&n<=max,`${name} inválido`);return n;}
const localDay = d => new Intl.DateTimeFormat('en-CA',{timeZone:process.env.LUMINOR_TIMEZONE||'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
function dateRangeToday(){return localDay(new Date());}
// Calendar math on YYYY-MM-DD strings, independent of the server timezone.
function parseDay(s){const t=/^\d{4}-\d{2}-\d{2}$/.test(String(s))?Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10)):NaN;assert(!Number.isNaN(t)&&new Date(t).toISOString().slice(0,10)===s,'Data inválida');return t;}
function fmtDay(t){return new Date(t).toISOString().slice(0,10);}
function addDays(s,n){return fmtDay(parseDay(s)+n*DAY_MS);}
function periodRange(period,date){
  const t=parseDay(date),d=new Date(t);
  if(period==='day')return {from:date,to:date};
  if(period==='week'){const from=fmtDay(t-((d.getUTCDay()+6)%7)*DAY_MS);return {from,to:addDays(from,6)};}
  if(period==='month')return {from:fmtDay(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)),to:fmtDay(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0))};
  throw Error('Período inválido');
}
// UTC timestamps are fetched with a one-day margin and then filtered by local calendar day.
function inRange(rows,from,to,field='created_at'){return rows.filter(x=>{const d=localDay(new Date(x[field]));return d>=from&&d<=to;});}
const emptyMethods=()=>({cash:0,pix:0,debit:0,credit:0});
const pad2=n=>String(n).padStart(2,'0');
const sameName=(a,b)=>a.toLocaleLowerCase('pt-BR')===b.toLocaleLowerCase('pt-BR');
// Schema steps after the v0.1 tables. PRAGMA user_version records how many ran. Each step is idempotent, so a database
// that already got some of these columns before the numbering existed converges to the same schema.
const MIGRATIONS=[
  // 1: operators, cancellation and typed entries.
  s=>{for(const [table,column,def] of [['shifts','opened_by','INTEGER'],['shifts','closed_by','INTEGER'],['sales','operator_id','INTEGER'],['sales','status',"TEXT NOT NULL DEFAULT 'done'"],['sales','canceled_at','TEXT'],['sales','canceled_by','INTEGER'],['sales','cancel_reason','TEXT'],['sale_items','manual','INTEGER NOT NULL DEFAULT 0'],['cash_events','operator_id','INTEGER']])s.addColumn(table,column,def);
    s.db.exec('CREATE INDEX IF NOT EXISTS sales_created ON sales(created_at); CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);');},
  // 2: amount received and change on cash sales.
  s=>{s.addColumn('sales','received_cents','INTEGER');s.addColumn('sales','change_cents','INTEGER');},
  // 3: open sales (one per customer being served), stored instead of kept in memory so a restart loses nothing.
  s=>{s.db.exec(`CREATE TABLE IF NOT EXISTS draft_sales(id TEXT PRIMARY KEY,shift_id INTEGER NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',operator_id INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,revision INTEGER NOT NULL DEFAULT 0,sale_id INTEGER,FOREIGN KEY (shift_id) REFERENCES shifts(id));
      CREATE INDEX IF NOT EXISTS draft_sales_open ON draft_sales(status,shift_id);
      CREATE TABLE IF NOT EXISTS draft_sale_items(id TEXT PRIMARY KEY,draft_sale_id TEXT NOT NULL,product_id INTEGER,kind TEXT NOT NULL,label TEXT NOT NULL,grams INTEGER,quantity INTEGER,unit_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,manual INTEGER NOT NULL DEFAULT 0,scale_capture_id TEXT UNIQUE,created_at TEXT NOT NULL,FOREIGN KEY (draft_sale_id) REFERENCES draft_sales(id));
      CREATE INDEX IF NOT EXISTS draft_items_sale ON draft_sale_items(draft_sale_id);
      CREATE TABLE IF NOT EXISTS draft_sale_events(id INTEGER PRIMARY KEY AUTOINCREMENT,draft_sale_id TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '',operator_id INTEGER,created_at TEXT NOT NULL);`);
    s.addColumn('shifts','active_draft_id','TEXT');s.addColumn('sales','draft_sale_id','TEXT');
    // One open sale can become at most one finished sale, whatever reaches checkout twice.
    s.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sales_draft ON sales(draft_sale_id) WHERE draft_sale_id IS NOT NULL');}
];
const itemView=r=>({key:r.id,kind:r.kind,productId:r.product_id??undefined,label:r.label,grams:r.grams??undefined,quantity:r.quantity??undefined,unitCents:r.unit_cents,totalCents:r.total_cents,manual:!!r.manual,captureId:r.scale_capture_id??undefined});
class Store {
  constructor(filename=path.join(ROOT,'data','luminor-pdv.sqlite')){
    fs.mkdirSync(path.dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,price_cents INTEGER NOT NULL,stock INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY AUTOINCREMENT,opened_at TEXT NOT NULL,opening_cents INTEGER NOT NULL,closed_at TEXT, counted_cents INTEGER,expected_cents INTEGER, difference_cents INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS one_shift ON shifts((closed_at IS NULL)) WHERE closed_at IS NULL;
      CREATE TABLE IF NOT EXISTS cash_events(id INTEGER PRIMARY KEY AUTOINCREMENT,shift_id INTEGER NOT NULL,kind TEXT NOT NULL,amount_cents INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,FOREIGN KEY (shift_id) REFERENCES shifts(id));
      CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE NOT NULL,shift_id INTEGER NOT NULL,created_at TEXT NOT NULL,method TEXT NOT NULL,total_cents INTEGER NOT NULL,FOREIGN KEY (shift_id) REFERENCES shifts(id));
      CREATE TABLE IF NOT EXISTS sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL,product_id INTEGER,kind TEXT NOT NULL,label TEXT NOT NULL,grams INTEGER,quantity INTEGER,unit_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,FOREIGN KEY (sale_id) REFERENCES sales(id));
      CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    `);
    // Older databases receive the new tables and columns in place; existing rows are kept.
    this.migrate();
    this.db.prepare('INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)').run('price_kg_cents','6490');
    this.db.prepare('INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)').run('auto_capture','1');
    this.db.prepare('INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)').run('operator_id','');
    this.restoreOpenDraftSales();
  }
  migrate(){
    for(let v=this.db.prepare('PRAGMA user_version').get().user_version;v<MIGRATIONS.length;v++)
      this.tx(()=>{MIGRATIONS[v](this);this.db.exec(`PRAGMA user_version=${v+1}`);});
  }
  schemaVersion(){return this.db.prepare('PRAGMA user_version').get().user_version;}
  // Everything fn writes is kept, or nothing is.
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  addColumn(table,column,def){if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);}
  setting(k){return this.db.prepare('SELECT v FROM settings WHERE k=?').get(k).v;}
  setSetting(k,v){this.db.prepare('UPDATE settings SET v=? WHERE k=?').run(v,k);}
  getConfig(){return {priceKgCents:Number(this.setting('price_kg_cents')),autoCapture:this.setting('auto_capture')==='1'};}
  updateConfig(input){
    if(input.priceKg!==undefined){const cents=readMoney(input.priceKg);assert(cents>0&&cents<=1000000,'Preço/kg fora do limite');this.setSetting('price_kg_cents',String(cents));}
    if(input.autoCapture!==undefined){assert(typeof input.autoCapture==='boolean','Opção inválida');this.setSetting('auto_capture',input.autoCapture?'1':'0');}
    return this.getConfig();
  }
  listEmployees(){return this.db.prepare('SELECT id,name FROM employees WHERE active=1 ORDER BY name COLLATE NOCASE,id').all();}
  employee(id){return this.db.prepare('SELECT id,name FROM employees WHERE id=? AND active=1').get(id)||null;}
  saveEmployee(input){
    const name=String(input.name||'').trim().replace(/\s+/g,' ');assert(name.length>=2&&name.length<=40,'Nome deve ter 2 a 40 caracteres');
    const id=input.id?integer(input.id,'ID',1):0;
    assert(!this.listEmployees().some(e=>e.id!==id&&e.name.toLocaleLowerCase('pt-BR')===name.toLocaleLowerCase('pt-BR')),'Já existe um funcionário com esse nome');
    if(id){assert(this.employee(id),'Funcionário não encontrado');this.db.prepare('UPDATE employees SET name=? WHERE id=?').run(name,id);return {id};}
    return {id:Number(this.db.prepare('INSERT INTO employees(name,created_at) VALUES(?,?)').run(name,now()).lastInsertRowid)};
  }
  removeEmployee(id){const n=integer(id,'ID',1);assert(!(this.shift()&&this.operatorId()===n),'Troque o operador antes de desativar quem está no caixa');
    this.db.prepare('UPDATE employees SET active=0 WHERE id=?').run(n);if(this.operatorId()===n)this.setSetting('operator_id','');return true;}
  operatorId(){const v=this.setting('operator_id');return v?Number(v):null;}
  operator(){const id=this.operatorId();return id?this.employee(id):null;}
  setOperator(id){const e=this.employee(integer(id,'Funcionário',1));assert(e,'Funcionário não encontrado');this.setSetting('operator_id',String(e.id));return e;}
  requireOperator(){const op=this.operator();assert(op,'Selecione o operador do caixa');return op;}
  shift(){return this.db.prepare('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get()||null;}
  openShift(opening,operatorId){assert(!this.shift(),'Já existe um caixa aberto');const cents=readMoney(opening);
    const op=operatorId!==undefined&&operatorId!==null&&operatorId!==''?this.setOperator(operatorId):this.requireOperator();
    // The shift starts with one open sale, so the first weighing already has a destination.
    this.tx(()=>{this.db.prepare('INSERT INTO shifts(opened_at,opening_cents,opened_by) VALUES(?,?,?)').run(now(),cents,op.id);this.insertDraft(this.shift());});
    return this.shift();}
  moveCash(kind,amount,note=''){
    const shift=this.shift();assert(shift,'Abra o caixa antes de realizar movimentações');const op=this.requireOperator();
    assert(['supply','withdrawal'].includes(kind),'Movimentação inválida');
    const cents=readMoney(amount);assert(cents>0,'Valor deve ser positivo');
    if(kind==='withdrawal')assert(cents<=this.cashSummary().expectedCents,'Sangria maior que o dinheiro em caixa');
    this.db.prepare('INSERT INTO cash_events(shift_id,kind,amount_cents,note,created_at,operator_id) VALUES(?,?,?,?,?,?)').run(shift.id,kind,cents,String(note).slice(0,180),now(),op.id);
    return this.cashSummary();
  }
  shiftTotals(shiftId){
    const methods=emptyMethods();let salesCount=0,canceledCount=0;
    for(const r of this.db.prepare('SELECT method,status,COUNT(*) AS n,COALESCE(SUM(total_cents),0) AS amount FROM sales WHERE shift_id=? GROUP BY method,status').all(shiftId)){
      if(r.status==='done'){methods[r.method]+=r.amount;salesCount+=r.n;}else canceledCount+=r.n;
    }
    const moved=kind=>this.db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM cash_events WHERE shift_id=? AND kind=?').get(shiftId,kind).amount;
    return {methods,totalCents:Object.values(methods).reduce((a,b)=>a+b,0),salesCount,canceledCount,suppliesCents:moved('supply'),withdrawalsCents:moved('withdrawal')};
  }
  cashSummary(){
    const shift=this.shift();if(!shift)return {shift:null,expectedCents:0,events:[],methods:emptyMethods()};
    const t=this.shiftTotals(shift.id);
    const events=this.db.prepare('SELECT c.*,e.name AS operator_name FROM cash_events c LEFT JOIN employees e ON e.id=c.operator_id WHERE c.shift_id=? ORDER BY c.id DESC LIMIT 80').all(shift.id);
    const opener=shift.opened_by?this.db.prepare('SELECT name FROM employees WHERE id=?').get(shift.opened_by):null;
    return {shift:{...shift,opened_by_name:opener?.name||null},expectedCents:shift.opening_cents+t.methods.cash+t.suppliesCents-t.withdrawalsCents,cashSalesCents:t.methods.cash,...t,events};
  }
  closeShift(counted){const s=this.cashSummary();assert(s.shift,'Não há caixa aberto');
    const pending=this.listDraftSales().filter(d=>d.item_count>0);
    assert(!pending.length,pending.length===1?`Existe 1 venda em aberto (${pending[0].label}). Finalize ou descarte essa venda para fechar o caixa.`:`Existem ${pending.length} vendas em aberto. Finalize ou descarte essas vendas para fechar o caixa.`);
    const c=readMoney(counted);
    this.tx(()=>{
      // Sales left without items are just empty tabs: they close with the shift.
      this.db.prepare("UPDATE draft_sales SET status='discarded',completed_at=?,updated_at=? WHERE shift_id=? AND status='open'").run(now(),now(),s.shift.id);
      this.db.prepare('UPDATE shifts SET closed_at=?,counted_cents=?,expected_cents=?,difference_cents=?,closed_by=?,active_draft_id=NULL WHERE id=?').run(now(),c,s.expectedCents,c-s.expectedCents,this.operatorId(),s.shift.id);
    });
    return {shiftId:s.shift.id,openingCents:s.shift.opening_cents,expectedCents:s.expectedCents,countedCents:c,differenceCents:c-s.expectedCents,methods:s.methods,totalCents:s.totalCents,salesCount:s.salesCount,canceledCount:s.canceledCount,suppliesCents:s.suppliesCents,withdrawalsCents:s.withdrawalsCents};}
  // available = stock minus the units already in open sales (reserved until paid or removed).
  listProducts(){return this.db.prepare("SELECT p.*,(SELECT COALESCE(SUM(i.quantity),0) FROM draft_sale_items i JOIN draft_sales d ON d.id=i.draft_sale_id WHERE d.status='open' AND i.kind='unit' AND i.product_id=p.id) AS reserved FROM products p WHERE p.active=1 ORDER BY p.name,p.id").all().map(p=>({...p,available:p.stock-p.reserved}));}
  product(input){
    const name=String(input.name||'').trim();assert(name.length>=2&&name.length<=80,'Nome deve ter 2 a 80 caracteres');
    const price=readMoney(input.price);assert(price>0,'Preço deve ser maior que zero');
    const stock=integer(input.stock,'Estoque',0,999999);
    if(input.id){const id=integer(input.id,'ID',1);assert(this.db.prepare('SELECT id FROM products WHERE id=?').get(id),'Produto não encontrado');this.db.prepare('UPDATE products SET name=?,price_cents=?,stock=?,active=1 WHERE id=?').run(name,price,stock,id);return {id};}
    return {id:Number(this.db.prepare('INSERT INTO products(name,price_cents,stock) VALUES(?,?,?)').run(name,price,stock).lastInsertRowid)};
  }
  deleteProduct(id){const n=integer(id,'ID',1);
    assert(this.reserved(n)===0,'Este produto está em vendas abertas. Tire das vendas antes de excluir.');
    this.db.prepare('UPDATE products SET active=0 WHERE id=?').run(n);return true;}
  // —— Open sales: one per customer being served, each with its own items, until it is paid or discarded ——
  draftRow(id){return this.db.prepare('SELECT * FROM draft_sales WHERE id=?').get(String(id??''))||null;}
  requireOpenSale(id){const shift=this.shift();assert(shift,'Abra o caixa primeiro');const d=this.draftRow(id);assert(d,'Venda não encontrada');
    assert(d.status==='open',d.status==='completed'?`A venda ${d.label} já foi cobrada`:`A venda ${d.label} foi descartada`);
    assert(shift.id===d.shift_id,'Esta venda não pertence ao caixa aberto');return d;}
  draftItems(id){return this.db.prepare('SELECT * FROM draft_sale_items WHERE draft_sale_id=? ORDER BY created_at,rowid').all(id).map(itemView);}
  itemOf(saleId,itemId){const i=this.db.prepare('SELECT * FROM draft_sale_items WHERE id=?').get(String(itemId??''));assert(i,'Item não encontrado');assert(i.draft_sale_id===saleId,'Este item não pertence a esta venda');return i;}
  touch(id){this.db.prepare('UPDATE draft_sales SET revision=revision+1,updated_at=? WHERE id=?').run(now(),id);}
  logDraft(id,kind,detail){this.db.prepare('INSERT INTO draft_sale_events(draft_sale_id,kind,detail,operator_id,created_at) VALUES(?,?,?,?,?)').run(id,kind,JSON.stringify(detail),this.operatorId(),now());}
  // Callers hold the transaction. Automatic names count the shift's sales and skip names already on an open tab.
  insertDraft(shift,{select=true,label=''}={}){
    let name=label;
    if(!name){const used=this.listDraftSales().map(d=>d.label);let n=this.db.prepare('SELECT COUNT(*) AS n FROM draft_sales WHERE shift_id=?').get(shift.id).n+1;
      do name=`Venda ${pad2(n++)}`;while(used.some(u=>sameName(u,name)));}
    const id=randomUUID(),t=now();
    this.db.prepare('INSERT INTO draft_sales(id,shift_id,label,operator_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,shift.id,name,this.operatorId(),t,t);
    if(select)this.db.prepare('UPDATE shifts SET active_draft_id=? WHERE id=?').run(id,shift.id);
    return id;
  }
  // When the sale receiving the weighings closes, the scale needs a destination that can't be another customer's:
  // a sale nobody has touched yet, or a new one. A sale that ever had items is never picked automatically.
  chooseActive(shift){
    const fresh=this.db.prepare("SELECT id FROM draft_sales WHERE shift_id=? AND status='open' AND revision=0 ORDER BY created_at DESC,rowid DESC LIMIT 1").get(shift.id);
    if(fresh)this.db.prepare('UPDATE shifts SET active_draft_id=? WHERE id=?').run(fresh.id,shift.id);else this.insertDraft(shift);
    return this.shift().active_draft_id;
  }
  // At startup open sales come back as they were, and the weighing destination stays the one chosen before.
  restoreOpenDraftSales(){
    this.db.prepare("UPDATE draft_sales SET status='discarded',completed_at=? WHERE status='open' AND shift_id NOT IN (SELECT id FROM shifts WHERE closed_at IS NULL) AND NOT EXISTS (SELECT 1 FROM draft_sale_items i WHERE i.draft_sale_id=draft_sales.id)").run(now());
    const shift=this.shift();if(!shift)return [];
    const active=this.draftRow(shift.active_draft_id);
    if(!(active&&active.status==='open'&&active.shift_id===shift.id))this.tx(()=>this.chooseActive(shift));
    return this.listDraftSales();
  }
  activeSaleId(){return this.shift()?.active_draft_id||null;}
  listDraftSales(){const shift=this.shift();if(!shift)return [];
    return this.db.prepare(`SELECT d.id,d.label,d.revision,d.created_at,d.updated_at,d.operator_id,e.name AS operator_name,
      (SELECT COUNT(*) FROM draft_sale_items i WHERE i.draft_sale_id=d.id) AS item_count,(SELECT COALESCE(SUM(total_cents),0) FROM draft_sale_items i WHERE i.draft_sale_id=d.id) AS total_cents
      FROM draft_sales d LEFT JOIN employees e ON e.id=d.operator_id WHERE d.status='open' AND d.shift_id=? ORDER BY d.created_at,d.rowid`).all(shift.id);}
  getDraftSale(id){const d=this.draftRow(id);assert(d,'Venda não encontrada');const items=this.draftItems(d.id);return {...d,items,totalCents:items.reduce((s,x)=>s+x.totalCents,0)};}
  createDraftSale(){const shift=this.shift();assert(shift,'Abra o caixa antes da venda');return this.getDraftSale(this.tx(()=>this.insertDraft(shift)));}
  selectDraftSale(id){const d=this.requireOpenSale(id);this.db.prepare('UPDATE shifts SET active_draft_id=? WHERE id=?').run(d.id,d.shift_id);return this.getDraftSale(d.id);}
  renameDraftSale(id,label){const d=this.requireOpenSale(id);const name=String(label??'').trim().replace(/\s+/g,' ');
    assert(name.length>=1&&name.length<=30,'O nome da venda deve ter de 1 a 30 caracteres');
    assert(!this.listDraftSales().some(x=>x.id!==d.id&&sameName(x.label,name)),'Já existe uma venda aberta com esse nome');
    this.tx(()=>{this.db.prepare('UPDATE draft_sales SET label=? WHERE id=?').run(name,d.id);this.touch(d.id);});return this.getDraftSale(d.id);}
  // Units sitting in open sales are reserved: the stock itself only drops when a sale is paid.
  reserved(productId,exceptItem=''){return this.db.prepare("SELECT COALESCE(SUM(i.quantity),0) AS n FROM draft_sale_items i JOIN draft_sales d ON d.id=i.draft_sale_id WHERE d.status='open' AND i.kind='unit' AND i.product_id=? AND i.id<>?").get(productId,exceptItem).n;}
  checkStock(productId,quantity,exceptItem){const p=this.db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(productId);assert(p,'Produto não encontrado');
    const free=p.stock-this.reserved(productId,exceptItem);assert(free>=quantity,`Estoque insuficiente para ${p.name} (disponível: ${Math.max(free,0)})`);return p;}
  insertItem(saleId,x){
    this.db.prepare('INSERT INTO draft_sale_items(id,draft_sale_id,product_id,kind,label,grams,quantity,unit_cents,total_cents,manual,scale_capture_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),saleId,x.productId??null,x.kind,x.label,x.grams??null,x.quantity??null,x.unitCents,x.totalCents,x.manual?1:0,x.captureId??null,now());
    this.touch(saleId);
  }
  addUnit(saleId,productId,quantity=1){const d=this.requireOpenSale(saleId);const n=integer(productId,'Produto',1),qty=integer(quantity,'Quantidade',1,999);
    // Repeated taps on the same product grow one line instead of stacking duplicates.
    const line=this.db.prepare("SELECT * FROM draft_sale_items WHERE draft_sale_id=? AND kind='unit' AND product_id=?").get(d.id,n);
    const p=this.checkStock(n,qty+(line?line.quantity:0),line?line.id:'');
    this.tx(()=>{
      if(line){this.db.prepare('UPDATE draft_sale_items SET quantity=?,total_cents=? WHERE id=?').run(line.quantity+qty,line.unit_cents*(line.quantity+qty),line.id);this.touch(d.id);}
      else this.insertItem(d.id,{kind:'unit',productId:n,label:p.name,quantity:qty,unitCents:p.price_cents,totalCents:p.price_cents*qty});
    });
    return this.getDraftSale(d.id);
  }
  setQuantity(saleId,itemId,quantity){const d=this.requireOpenSale(saleId);const item=this.itemOf(d.id,itemId);assert(item.kind==='unit','Só produtos avulsos têm quantidade');
    const qty=integer(quantity,'Quantidade',1,999);this.checkStock(item.product_id,qty,item.id);
    this.tx(()=>{this.db.prepare('UPDATE draft_sale_items SET quantity=?,total_cents=? WHERE id=?').run(qty,item.unit_cents*qty,item.id);this.touch(d.id);});
    return this.getDraftSale(d.id);}
  // captureId identifies one scale cycle: offered again (retry, reconnection, repeated request), it is stored only once.
  addWeighed(saleId,grams,captureId=null){const d=this.requireOpenSale(saleId);const g=integer(grams,'Peso',1,15000);
    if(captureId!==null){assert(/^[0-9a-zA-Z-]{8,80}$/.test(String(captureId)),'Identificador de pesagem inválido');
      if(this.db.prepare('SELECT 1 AS x FROM draft_sale_items WHERE scale_capture_id=?').get(String(captureId)))return {...this.getDraftSale(d.id),duplicate:true};}
    const price=this.getConfig().priceKgCents;
    this.tx(()=>this.insertItem(d.id,{kind:'weight',grams:g,label:'Açaí por peso',unitCents:price,totalCents:calcTotal(g,price),captureId:captureId===null?null:String(captureId)}));
    return {...this.getDraftSale(d.id),duplicate:false};
  }
  addManualWeight(saleId,weight){const d=this.requireOpenSale(saleId);const g=readWeight(weight);const price=this.getConfig().priceKgCents;
    this.tx(()=>this.insertItem(d.id,{kind:'weight',grams:g,label:'Açaí por peso (digitado)',unitCents:price,totalCents:calcTotal(g,price),manual:true}));
    return this.getDraftSale(d.id);}
  addManualValue(saleId,amount){const d=this.requireOpenSale(saleId);const cents=readMoney(amount);assert(cents>0&&cents<=100000,'Valor deve estar entre R$ 0,01 e R$ 1.000,00');
    this.tx(()=>this.insertItem(d.id,{kind:'value',label:'Açaí (valor digitado)',quantity:1,unitCents:cents,totalCents:cents,manual:true}));
    return this.getDraftSale(d.id);}
  removeDraftSaleItem(saleId,itemId){const d=this.requireOpenSale(saleId);const item=this.itemOf(d.id,itemId);
    this.tx(()=>{this.db.prepare('DELETE FROM draft_sale_items WHERE id=?').run(item.id);this.touch(d.id);});return this.getDraftSale(d.id);}
  // Moves one line to another open sale ('new' creates one), both totals follow, and the move is recorded on both sales.
  transferDraftSaleItem(fromId,itemId,toId){const from=this.requireOpenSale(fromId);const item=this.itemOf(from.id,itemId);
    if(toId!=='new'){const to=this.requireOpenSale(toId);assert(to.id!==from.id,'Escolha outra venda de destino');}
    return this.tx(()=>{
      const to=toId==='new'?this.draftRow(this.insertDraft(this.shift(),{select:false})):this.draftRow(toId);
      this.db.prepare('UPDATE draft_sale_items SET draft_sale_id=? WHERE id=?').run(to.id,item.id);this.touch(from.id);this.touch(to.id);
      const detail={itemId:item.id,label:item.label,grams:item.grams,quantity:item.quantity,totalCents:item.total_cents,from:{id:from.id,label:from.label},to:{id:to.id,label:to.label}};
      this.logDraft(from.id,'transfer_out',detail);this.logDraft(to.id,'transfer_in',detail);
      return {from:this.getDraftSale(from.id),to:this.getDraftSale(to.id)};
    });
  }
  draftEvents(id){return this.db.prepare('SELECT e.*,o.name AS operator_name FROM draft_sale_events e LEFT JOIN employees o ON o.id=e.operator_id WHERE e.draft_sale_id=? ORDER BY e.id').all(String(id??'')).map(e=>({...e,detail:JSON.parse(e.detail||'{}')}));}
  discardDraftSale(id){const d=this.requireOpenSale(id);const items=this.draftItems(d.id);
    return this.tx(()=>{
      this.db.prepare("UPDATE draft_sales SET status='discarded',completed_at=?,updated_at=? WHERE id=?").run(now(),now(),d.id);
      this.logDraft(d.id,'discard',{label:d.label,items:items.length,totalCents:items.reduce((s,x)=>s+x.totalCents,0)});
      const shift=this.shift();if(shift.active_draft_id===d.id)this.chooseActive(shift);
      return {discarded:d.id,activeSaleId:this.activeSaleId()};
    });
  }
  // Pays one open sale. The finished sale, its items, the stock and the end of the open sale are one transaction:
  // on any failure nothing is written and the open sale keeps its items. Asking twice returns the first sale.
  checkoutDraftSale(saleId,method,requestId,received,revision){assert(['cash','pix','debit','credit'].includes(method),'Forma de pagamento inválida');const shift=this.shift();assert(shift,'Abra o caixa primeiro');
    const uuid=String(requestId||'');assert(/^[0-9a-zA-Z-]{12,80}$/.test(uuid),'Identificador de venda inválido');
    const again=this.db.prepare('SELECT * FROM sales WHERE uuid=?').get(uuid)||this.db.prepare('SELECT * FROM sales WHERE draft_sale_id=?').get(String(saleId??''));
    if(again)return {sale:again,duplicate:true,activeSaleId:this.activeSaleId()};
    const d=this.requireOpenSale(saleId);
    // The total the operator confirmed must still be the total: a weighing that arrived meanwhile stops the charge.
    if(revision!==undefined&&revision!==null&&revision!=='')assert(integer(revision,'Revisão',0,1e9)===d.revision,`A venda ${d.label} mudou depois da conferência. Confira o total e cobre de novo.`);
    const items=this.draftItems(d.id);assert(items.length>0,`A venda ${d.label} não tem itens`);const op=this.requireOperator();
    const total=items.reduce((s,x)=>s+x.totalCents,0);assert(total>0,'Venda com total inválido');
    // Amount handed over by the customer, optional and only for cash; the drawer still counts the sale total.
    let receivedCents=null;
    if(method==='cash'&&received!==undefined&&received!==null&&received!==''){receivedCents=readMoney(received);assert(receivedCents>=total,'Valor recebido menor que o total da venda');}
    const saleId2=this.tx(()=>{
      for(const item of items.filter(x=>x.kind==='unit')){
        const result=this.db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND active=1 AND stock>=?').run(item.quantity,item.productId,item.quantity);
        assert(result.changes===1,`Estoque insuficiente para ${item.label}`);
      }
      const result=this.db.prepare('INSERT INTO sales(uuid,shift_id,created_at,method,total_cents,operator_id,received_cents,change_cents,draft_sale_id) VALUES(?,?,?,?,?,?,?,?,?)').run(uuid,shift.id,now(),method,total,op.id,receivedCents,receivedCents===null?null:receivedCents-total,d.id);
      const id=Number(result.lastInsertRowid);
      const stmt=this.db.prepare('INSERT INTO sale_items(sale_id,product_id,kind,label,grams,quantity,unit_cents,total_cents,manual) VALUES(?,?,?,?,?,?,?,?,?)');
      for(const item of items)stmt.run(id,item.productId??null,item.kind,item.label,item.grams??null,item.quantity??null,item.unitCents,item.totalCents,item.manual?1:0);
      const closed=this.db.prepare("UPDATE draft_sales SET status='completed',completed_at=?,updated_at=?,sale_id=? WHERE id=? AND status='open'").run(now(),now(),id,d.id);
      assert(closed.changes===1,`A venda ${d.label} já foi cobrada`);
      if(this.shift().active_draft_id===d.id)this.chooseActive(shift);
      return id;
    });
    return {sale:this.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId2),duplicate:false,activeSaleId:this.activeSaleId()};
  }
  cancelCheck(id,reason){
    const n=integer(id,'Venda',1);const why=String(reason||'').trim();assert(why.length>=3&&why.length<=180,'Informe o motivo do cancelamento');
    const sale=this.db.prepare('SELECT * FROM sales WHERE id=?').get(n);assert(sale,'Venda não encontrada');assert(sale.status==='done','Venda já cancelada');
    // A closed shift was already counted; changing its sales would silently break that closing.
    const shift=this.shift();assert(shift&&sale.shift_id===shift.id,'Só é possível cancelar vendas do caixa aberto');
    return {n,why,op:this.requireOperator(),shift};
  }
  markCanceled(n,why,op){
    const changed=this.db.prepare("UPDATE sales SET status='canceled',canceled_at=?,canceled_by=?,cancel_reason=? WHERE id=? AND status='done'").run(now(),op.id,why,n);
    assert(changed.changes===1,'Venda já cancelada');
    for(const item of this.db.prepare("SELECT product_id,quantity FROM sale_items WHERE sale_id=? AND kind='unit' AND product_id IS NOT NULL").all(n))
      this.db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity,item.product_id);
  }
  cancelSale(id,reason){const {n,why,op}=this.cancelCheck(id,reason);this.tx(()=>this.markCanceled(n,why,op));return this.saleDetail(n);}
  // The canceled sale's items go to a new open sale of their own, so no other customer's sale is touched.
  // select is decided by the caller (the server only allows it with the scale empty).
  correctSale(id,reason,{select=false}={}){const {n,why,op,shift}=this.cancelCheck(id,reason);
    const draftId=this.tx(()=>{
      this.markCanceled(n,why,op);
      const draftId=this.insertDraft(shift,{select,label:`Correção #${n}`});
      for(const x of this.db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(n))
        this.insertItem(draftId,{kind:x.kind,productId:x.product_id,label:x.label,grams:x.grams,quantity:x.quantity,unitCents:x.unit_cents,totalCents:x.total_cents,manual:!!x.manual});
      this.logDraft(draftId,'correction',{saleId:n,reason:why});
      return draftId;
    });
    return {sale:this.saleDetail(n),draft:this.getDraftSale(draftId),selected:select};
  }
  salesQuery(where,params){
    return this.db.prepare(`SELECT s.*,e.name AS operator_name,(SELECT COUNT(*) FROM sale_items i WHERE i.sale_id=s.id) AS item_count,(SELECT COALESCE(MAX(manual),0) FROM sale_items i WHERE i.sale_id=s.id) AS has_manual
      FROM sales s LEFT JOIN employees e ON e.id=s.operator_id WHERE ${where} ORDER BY s.id DESC`).all(...params);
  }
  salesBetween(from,to){return inRange(this.salesQuery('s.created_at>=? AND s.created_at<?',[addDays(from,-1),addDays(to,2)]),from,to);}
  saleDetail(id){const n=integer(id,'Venda',1);
    const sale=this.db.prepare('SELECT s.*,e.name AS operator_name,c.name AS canceled_by_name,d.label AS draft_label FROM sales s LEFT JOIN employees e ON e.id=s.operator_id LEFT JOIN employees c ON c.id=s.canceled_by LEFT JOIN draft_sales d ON d.id=s.draft_sale_id WHERE s.id=?').get(n);assert(sale,'Venda não encontrada');
    const shift=this.shift();
    return {...sale,items:this.db.prepare('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id').all(n),cancelable:sale.status==='done'&&!!shift&&shift.id===sale.shift_id};
  }
  salesHistory(filter={}){
    if(filter.q){const n=Number(String(filter.q).trim().replace(/^#/,''));assert(Number.isSafeInteger(n)&&n>0,'Número da venda inválido');return {q:n,sales:this.salesQuery('s.id=?',[n])};}
    const from=filter.from||dateRangeToday(),to=filter.to||from;
    assert(parseDay(from)<=parseDay(to),'Data inicial depois da final');assert(parseDay(to)-parseDay(from)<=366*DAY_MS,'Período máximo de um ano');
    let sales=this.salesBetween(from,to);
    if(filter.status==='done'||filter.status==='canceled')sales=sales.filter(x=>x.status===filter.status);
    return {from,to,sales:sales.slice(0,500)};
  }
  report(options={}){
    const period=options.period||'day',date=options.date||dateRangeToday();const {from,to}=periodRange(period,date);
    const sales=this.salesBetween(from,to);const done=sales.filter(x=>x.status==='done'),canceled=sales.filter(x=>x.status!=='done');
    const sum=rows=>rows.reduce((s,x)=>s+x.total_cents,0);
    const methods=emptyMethods();for(const x of done)methods[x.method]+=x.total_cents;
    const doneIds=new Set(done.map(x=>x.id));
    const items=this.db.prepare("SELECT i.sale_id,i.kind,i.grams,i.manual,i.total_cents FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status='done' AND s.created_at>=? AND s.created_at<?").all(addDays(from,-1),addDays(to,2)).filter(x=>doneIds.has(x.sale_id));
    const manual=items.filter(x=>x.manual);
    const byDay=new Map();for(let t=parseDay(from);t<=parseDay(to);t+=DAY_MS)byDay.set(fmtDay(t),{day:fmtDay(t),totalCents:0,count:0});
    const byOperator=new Map();
    for(const x of done){
      const day=byDay.get(localDay(new Date(x.created_at)));day.totalCents+=x.total_cents;day.count++;
      const name=x.operator_name||'Não identificado';const op=byOperator.get(name)||{name,totalCents:0,count:0};op.totalCents+=x.total_cents;op.count++;byOperator.set(name,op);
    }
    const shifts=inRange(this.db.prepare('SELECT sh.*,o.name AS opened_by_name,c.name AS closed_by_name FROM shifts sh LEFT JOIN employees o ON o.id=sh.opened_by LEFT JOIN employees c ON c.id=sh.closed_by WHERE sh.opened_at>=? AND sh.opened_at<? ORDER BY sh.id DESC').all(addDays(from,-1),addDays(to,2)),from,to,'opened_at');
    const totalCents=sum(done);
    return {period,date,from,to,today:dateRangeToday(),totalCents,count:done.length,avgTicketCents:done.length?Math.round(totalCents/done.length):0,
      grams:items.filter(x=>x.kind==='weight').reduce((s,x)=>s+(x.grams||0),0),methods,
      canceled:{count:canceled.length,totalCents:sum(canceled)},manual:{count:manual.length,totalCents:sum(manual)},
      byDay:[...byDay.values()],byOperator:[...byOperator.values()].sort((a,b)=>b.totalCents-a.totalCents),sales,shifts};
  }
  // cart/cartTotalCents are the active open sale: the one the scale is weighing for.
  getState(scale){const activeSaleId=this.activeSaleId();const active=activeSaleId?this.getDraftSale(activeSaleId):null;
    return {config:this.getConfig(),cash:this.cashSummary(),openSales:this.listDraftSales(),activeSaleId,
      activeSale:active&&{id:active.id,label:active.label,revision:active.revision,created_at:active.created_at,updated_at:active.updated_at,operator_id:active.operator_id},
      cart:active?active.items:[],cartTotalCents:active?active.totalCents:0,products:this.listProducts(),employees:this.listEmployees(),operator:this.operator(),scale:scale.snapshot()};}
  close(){this.db.close();}
}
module.exports={Store,integer,periodRange};
