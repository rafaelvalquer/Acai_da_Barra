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
    // Databases created by v0.1 receive the new columns in place; existing rows are kept.
    for(const [table,column,def] of [['shifts','opened_by','INTEGER'],['shifts','closed_by','INTEGER'],['sales','operator_id','INTEGER'],['sales','status',"TEXT NOT NULL DEFAULT 'done'"],['sales','canceled_at','TEXT'],['sales','canceled_by','INTEGER'],['sales','cancel_reason','TEXT'],['sale_items','manual','INTEGER NOT NULL DEFAULT 0'],['cash_events','operator_id','INTEGER'],['sales','received_cents','INTEGER'],['sales','change_cents','INTEGER']])this.addColumn(table,column,def);
    this.db.exec('CREATE INDEX IF NOT EXISTS sales_created ON sales(created_at); CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);');
    this.db.prepare('INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)').run('price_kg_cents','6490');
    this.db.prepare('INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)').run('auto_capture','1');
    this.db.prepare('INSERT OR IGNORE INTO settings(k,v) VALUES(?,?)').run('operator_id','');
    this.cart=[];
  }
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
    this.db.prepare('INSERT INTO shifts(opened_at,opening_cents,opened_by) VALUES(?,?,?)').run(now(),cents,op.id);return this.shift();}
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
  closeShift(counted){const s=this.cashSummary();assert(s.shift,'Não há caixa aberto');assert(this.cart.length===0,'Conclua ou limpe a venda antes do fechamento');const c=readMoney(counted);
    this.db.prepare('UPDATE shifts SET closed_at=?,counted_cents=?,expected_cents=?,difference_cents=?,closed_by=? WHERE id=?').run(now(),c,s.expectedCents,c-s.expectedCents,this.operatorId(),s.shift.id);
    return {shiftId:s.shift.id,openingCents:s.shift.opening_cents,expectedCents:s.expectedCents,countedCents:c,differenceCents:c-s.expectedCents,methods:s.methods,totalCents:s.totalCents,salesCount:s.salesCount,canceledCount:s.canceledCount,suppliesCents:s.suppliesCents,withdrawalsCents:s.withdrawalsCents};}
  listProducts(){return this.db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name,id').all();}
  product(input){
    const name=String(input.name||'').trim();assert(name.length>=2&&name.length<=80,'Nome deve ter 2 a 80 caracteres');
    const price=readMoney(input.price);assert(price>0,'Preço deve ser maior que zero');
    const stock=integer(input.stock,'Estoque',0,999999);
    if(input.id){const id=integer(input.id,'ID',1);assert(this.db.prepare('SELECT id FROM products WHERE id=?').get(id),'Produto não encontrado');this.db.prepare('UPDATE products SET name=?,price_cents=?,stock=?,active=1 WHERE id=?').run(name,price,stock,id);return {id};}
    return {id:Number(this.db.prepare('INSERT INTO products(name,price_cents,stock) VALUES(?,?,?)').run(name,price,stock).lastInsertRowid)};
  }
  deleteProduct(id){const n=integer(id,'ID',1);this.db.prepare('UPDATE products SET active=0 WHERE id=?').run(n);this.cart=this.cart.filter(x=>x.productId!==n);return true;}
  inCart(productId,exceptKey){return this.cart.filter(x=>x.kind==='unit'&&x.productId===productId&&x.key!==exceptKey).reduce((s,x)=>s+x.quantity,0);}
  addManual(id,quantity=1){assert(this.shift(),'Abra o caixa antes da venda');const n=integer(id,'Produto',1),qty=integer(quantity,'Quantidade',1,999);
    const p=this.db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(n);assert(p,'Produto não encontrado');
    assert(p.stock>=this.inCart(n)+qty,'Estoque insuficiente');
    // Repeated taps on the same product grow one line instead of stacking duplicates.
    const line=this.cart.find(x=>x.kind==='unit'&&x.productId===n);
    if(line){line.quantity+=qty;line.totalCents=line.unitCents*line.quantity;}
    else this.cart.push({key:randomUUID(),kind:'unit',productId:n,label:p.name,quantity:qty,unitCents:p.price_cents,totalCents:p.price_cents*qty});
    return this.cart;
  }
  setQuantity(key,quantity){const item=this.cart.find(x=>x.key===key);assert(item&&item.kind==='unit','Item não encontrado');const qty=integer(quantity,'Quantidade',1,999);
    const p=this.db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(item.productId);assert(p,'Produto não encontrado');
    assert(p.stock>=this.inCart(item.productId,key)+qty,'Estoque insuficiente');
    item.quantity=qty;item.totalCents=item.unitCents*qty;return this.cart;}
  addWeighed(grams){assert(this.shift(),'Abra o caixa antes da pesagem');const g=integer(grams,'Peso',1,15000);const price=this.getConfig().priceKgCents;
    this.cart.push({key:randomUUID(),kind:'weight',grams:g,label:'Açaí por peso',unitCents:price,totalCents:calcTotal(g,price)});
    return this.cart;
  }
  addManualWeight(weight){assert(this.shift(),'Abra o caixa antes da pesagem');const g=readWeight(weight);const price=this.getConfig().priceKgCents;
    this.cart.push({key:randomUUID(),kind:'weight',grams:g,label:'Açaí por peso (digitado)',unitCents:price,totalCents:calcTotal(g,price),manual:true});
    return this.cart;
  }
  addManualValue(amount){assert(this.shift(),'Abra o caixa antes da venda');const cents=readMoney(amount);assert(cents>0&&cents<=100000,'Valor deve estar entre R$ 0,01 e R$ 1.000,00');
    this.cart.push({key:randomUUID(),kind:'value',label:'Açaí (valor digitado)',quantity:1,unitCents:cents,totalCents:cents,manual:true});
    return this.cart;
  }
  removeCart(key){this.cart=this.cart.filter(x=>x.key!==key);return this.cart;}
  clearCart(){this.cart=[];return this.cart;}
  cartTotal(){return this.cart.reduce((s,x)=>s+x.totalCents,0);}
  checkout(method,requestId,received){assert(['cash','pix','debit','credit'].includes(method),'Forma de pagamento inválida');const shift=this.shift();assert(shift,'Abra o caixa primeiro');
    const uuid=String(requestId||'');assert(/^[0-9a-zA-Z-]{12,80}$/.test(uuid),'Identificador de venda inválido');
    const existing=this.db.prepare('SELECT * FROM sales WHERE uuid=?').get(uuid);
    if(existing)return {sale:existing,duplicate:true};
    assert(this.cart.length>0,'Carrinho vazio');const op=this.requireOperator();
    const snapshot=this.cart.map(x=>({...x}));const total=this.cartTotal();assert(total>0,'Venda com total inválido');
    // Amount handed over by the customer, optional and only for cash; the drawer still counts the sale total.
    let receivedCents=null;
    if(method==='cash'&&received!==undefined&&received!==null&&received!==''){receivedCents=readMoney(received);assert(receivedCents>=total,'Valor recebido menor que o total da venda');}
    this.db.exec('BEGIN IMMEDIATE');
    try{
      // Recheck stock and decrement atomically before storing the sale.
      for(const item of snapshot.filter(x=>x.kind==='unit')){
        const result=this.db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND active=1 AND stock>=?').run(item.quantity,item.productId,item.quantity);
        assert(result.changes===1,`Estoque insuficiente para ${item.label}`);
      }
      const result=this.db.prepare('INSERT INTO sales(uuid,shift_id,created_at,method,total_cents,operator_id,received_cents,change_cents) VALUES(?,?,?,?,?,?,?,?)').run(uuid,shift.id,now(),method,total,op.id,receivedCents,receivedCents===null?null:receivedCents-total);
      const saleId=Number(result.lastInsertRowid);
      const stmt=this.db.prepare('INSERT INTO sale_items(sale_id,product_id,kind,label,grams,quantity,unit_cents,total_cents,manual) VALUES(?,?,?,?,?,?,?,?,?)');
      for(const item of snapshot)stmt.run(saleId,item.productId||null,item.kind,item.label,item.grams||null,item.quantity||null,item.unitCents,item.totalCents,item.manual?1:0);
      this.db.exec('COMMIT');this.cart=[];
      return {sale:this.db.prepare('SELECT * FROM sales WHERE id=?').get(saleId),duplicate:false};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  cancelSale(id,reason){
    const n=integer(id,'Venda',1);const why=String(reason||'').trim();assert(why.length>=3&&why.length<=180,'Informe o motivo do cancelamento');
    const sale=this.db.prepare('SELECT * FROM sales WHERE id=?').get(n);assert(sale,'Venda não encontrada');assert(sale.status==='done','Venda já cancelada');
    // A closed shift was already counted; changing its sales would silently break that closing.
    const shift=this.shift();assert(shift&&sale.shift_id===shift.id,'Só é possível cancelar vendas do caixa aberto');
    const op=this.requireOperator();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const changed=this.db.prepare("UPDATE sales SET status='canceled',canceled_at=?,canceled_by=?,cancel_reason=? WHERE id=? AND status='done'").run(now(),op.id,why,n);
      assert(changed.changes===1,'Venda já cancelada');
      for(const item of this.db.prepare("SELECT product_id,quantity FROM sale_items WHERE sale_id=? AND kind='unit' AND product_id IS NOT NULL").all(n))
        this.db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity,item.product_id);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.saleDetail(n);
  }
  correctSale(id,reason){assert(this.cart.length===0,'Finalize ou limpe a venda atual antes de corrigir outra');
    const sale=this.cancelSale(id,reason);
    this.cart=sale.items.map(x=>({key:randomUUID(),kind:x.kind,productId:x.product_id??undefined,label:x.label,grams:x.grams??undefined,quantity:x.quantity??undefined,unitCents:x.unit_cents,totalCents:x.total_cents,manual:!!x.manual}));
    return {sale,cart:this.cart};
  }
  salesQuery(where,params){
    return this.db.prepare(`SELECT s.*,e.name AS operator_name,(SELECT COUNT(*) FROM sale_items i WHERE i.sale_id=s.id) AS item_count,(SELECT COALESCE(MAX(manual),0) FROM sale_items i WHERE i.sale_id=s.id) AS has_manual
      FROM sales s LEFT JOIN employees e ON e.id=s.operator_id WHERE ${where} ORDER BY s.id DESC`).all(...params);
  }
  salesBetween(from,to){return inRange(this.salesQuery('s.created_at>=? AND s.created_at<?',[addDays(from,-1),addDays(to,2)]),from,to);}
  saleDetail(id){const n=integer(id,'Venda',1);
    const sale=this.db.prepare('SELECT s.*,e.name AS operator_name,c.name AS canceled_by_name FROM sales s LEFT JOIN employees e ON e.id=s.operator_id LEFT JOIN employees c ON c.id=s.canceled_by WHERE s.id=?').get(n);assert(sale,'Venda não encontrada');
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
  getState(scale){return {config:this.getConfig(),cash:this.cashSummary(),cart:this.cart,cartTotalCents:this.cartTotal(),products:this.listProducts(),employees:this.listEmployees(),operator:this.operator(),scale:scale.snapshot()};}
  close(){this.db.close();}
}
module.exports={Store,integer,periodRange};
