'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const {Store}=require('../src/db');const {ScaleDriver}=require('../src/scale');
function fixture(file){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-test-'));const full=path.join(dir,'sample.sqlite');if(file)file(full);const db=new Store(full);return {db,op:db.saveEmployee({name:'Ana'}).id,clean(){db.close();fs.rmSync(dir,{recursive:true,force:true});}};}
const sell=(s,method='pix',value='10,00')=>{s.addManualValue(value);return s.checkout(method,randomUUID()).sale;};
const backdate=(s,id,iso)=>s.db.prepare('UPDATE sales SET created_at=? WHERE id=?').run(iso,id);

test('checkout weight, product stock, change and daily reports',()=>{
 const f=fixture();const s=f.db;
 try{
  assert.equal(s.getConfig().priceKgCents,6490);
  assert.throws(()=>s.addWeighed(300),/caixa/);
  s.openShift('100,00',f.op);
  const {id}=s.product({name:'Água sem gás',price:'5,00',stock:3});
  s.addWeighed(840);s.addManual(id,2);
  assert.equal(s.cartTotal(),6452);
  const key=randomUUID();const a=s.checkout('cash',key);assert.equal(a.sale.total_cents,6452);
  assert.equal(s.checkout('cash',key).duplicate,true);
  assert.equal(s.listProducts()[0].stock,1);
  assert.equal(s.cashSummary().expectedCents,16452);
  s.moveCash('withdrawal','20,00','retirada');
  assert.equal(s.cashSummary().expectedCents,14452);
  const closed=s.closeShift('144,52');assert.equal(closed.differenceCents,0);
  assert.equal(s.report().count,1);assert.equal(s.report().methods.cash,6452);
 }finally{f.clean();}
});
test('stock rejects overselling and rolls back sale',()=>{
 const f=fixture();try{
 const s=f.db;s.openShift('0',f.op);const p=s.product({name:'Água',price:'5',stock:1});s.addManual(p.id,1);
 // Another stock adjustment after the item enters the cart.
 s.product({id:p.id,name:'Água',price:'5',stock:0});
 assert.throws(()=>s.checkout('pix',randomUUID()),/Estoque insuficiente/);
 assert.equal(s.report().sales.length,0);assert.equal(s.listProducts()[0].stock,0);
 }finally{f.clean();}
});
test('demo scale disarms and rearms only at zero',()=>{
 const scale=new ScaleDriver();scale.demo();scale.setDemoGrams(840);
 assert.equal(scale.snapshot().ready,true);assert.equal(scale.consume(),840);assert.equal(scale.snapshot().ready,false);
 scale.setDemoGrams(840);assert.equal(scale.snapshot().ready,false);
 scale.setDemoGrams(0);assert.equal(scale.snapshot().armed,true);scale.setDemoGrams(420);
 assert.equal(scale.snapshot().ready,true);scale.disconnect();
});

test('the same sale id is recorded only once',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('50,00',f.op);const p=s.product({name:'Água',price:'5,00',stock:5});
  s.addManual(p.id,2);s.addWeighed(500);const key=randomUUID();
  const first=s.checkout('cash',key);const again=s.checkout('cash',key);
  assert.equal(first.duplicate,false);assert.equal(again.duplicate,true);assert.equal(again.sale.id,first.sale.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sale_items').get().n,2);
  assert.equal(s.listProducts()[0].stock,3);
  assert.equal(s.cashSummary().expectedCents,5000+first.sale.total_cents);
  assert.throws(()=>s.checkout('cash',randomUUID()),/Carrinho vazio/);
  assert.throws(()=>s.checkout('cash','curto'),/Identificador/);
  assert.throws(()=>s.checkout('cheque',randomUUID()),/Forma de pagamento/);
 }finally{f.clean();}
});
test('each payment method is totaled and only cash goes into the drawer',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('100,00',f.op);
  sell(s,'pix','10,00');sell(s,'cash','20,00');sell(s,'debit','30,00');sell(s,'credit','40,00');sell(s,'cash','5,50');
  const c=s.cashSummary();
  assert.deepEqual(c.methods,{cash:2550,pix:1000,debit:3000,credit:4000});
  assert.equal(c.totalCents,10550);assert.equal(c.salesCount,5);
  assert.equal(c.expectedCents,10000+2550);
  assert.deepEqual(s.report().methods,{cash:2550,pix:1000,debit:3000,credit:4000});
 }finally{f.clean();}
});
test('cash payment records the amount received and the change',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('100,00',f.op);
  s.addManualValue('31,54');const key=randomUUID();
  const sale=s.checkout('cash',key,'50,00').sale;
  assert.equal(sale.received_cents,5000);assert.equal(sale.change_cents,1846);
  // The drawer keeps the sale total: the change left with the customer.
  assert.equal(s.cashSummary().expectedCents,10000+3154);
  assert.equal(s.checkout('cash',key,'100,00').sale.change_cents,1846);
  const detail=s.saleDetail(sale.id);assert.equal(detail.received_cents,5000);assert.equal(detail.change_cents,1846);
  s.addManualValue('31,54');
  assert.throws(()=>s.checkout('cash',randomUUID(),'30,00'),/Valor recebido menor/);
  assert.throws(()=>s.checkout('cash',randomUUID(),'cinquenta'),/Use valor/);
  assert.equal(s.cart.length,1);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,1);
  assert.equal(s.checkout('cash',randomUUID(),'R$ 31,54').sale.change_cents,0);
  s.addManualValue('12,00');const blank=s.checkout('cash',randomUUID(),'').sale;assert.equal(blank.received_cents,null);assert.equal(blank.change_cents,null);
  s.addManualValue('12,00');const pix=s.checkout('pix',randomUUID(),'50,00').sale;assert.equal(pix.received_cents,null);assert.equal(pix.change_cents,null);
  assert.equal(s.cashSummary().expectedCents,10000+3154+3154+1200);
 }finally{f.clean();}
});
test('closing the shift checks the cart, computes the difference and blocks new sales',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('100,00',f.op);sell(s,'cash','30,00');sell(s,'pix','12,00');s.moveCash('supply','10,00','troco');
  s.addManualValue('8,00');
  assert.throws(()=>s.closeShift('140,00'),/Conclua ou limpe/);
  s.clearCart();
  const short=s.closeShift('135,00');
  assert.equal(short.expectedCents,14000);assert.equal(short.differenceCents,-500);
  assert.deepEqual(short.methods,{cash:3000,pix:1200,debit:0,credit:0});assert.equal(short.salesCount,2);
  assert.throws(()=>s.addManualValue('1,00'),/caixa/);assert.throws(()=>s.addWeighed(300),/caixa/);
  assert.throws(()=>s.checkout('cash',randomUUID()),/caixa/);
  assert.throws(()=>s.closeShift('0'),/Não há caixa/);
  s.openShift('0',f.op);sell(s,'cash','10,00');
  assert.equal(s.closeShift('12,00').differenceCents,200);
  const shifts=s.report().shifts;assert.equal(shifts.length,2);assert.equal(shifts[1].difference_cents,-500);assert.equal(shifts[1].closed_by_name,'Ana');
 }finally{f.clean();}
});
test('withdrawal cannot exceed the cash in the drawer',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('20,00',f.op);
  assert.throws(()=>s.moveCash('withdrawal','20,01','cofre'),/maior que o dinheiro/);
  s.moveCash('withdrawal','20,00','cofre');assert.equal(s.cashSummary().expectedCents,0);
  const ev=s.cashSummary().events[0];assert.equal(ev.operator_name,'Ana');
 }finally{f.clean();}
});
test('operator is required, recorded and can be switched',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-test-'));const s=new Store(path.join(dir,'x.sqlite'));
 try{
  assert.throws(()=>s.openShift('0'),/operador/);
  const ana=s.saveEmployee({name:'Ana'}).id,bia=s.saveEmployee({name:'Bia'}).id;
  assert.throws(()=>s.saveEmployee({name:' ana '}),/Já existe/);
  assert.throws(()=>s.saveEmployee({name:'A'}),/2 a 40/);
  s.openShift('0',ana);assert.equal(s.shift().opened_by,ana);assert.equal(s.operator().name,'Ana');
  assert.equal(sell(s).operator_id,ana);
  s.setOperator(bia);assert.equal(sell(s).operator_id,bia);
  assert.throws(()=>s.removeEmployee(bia),/Troque o operador/);
  s.removeEmployee(ana);assert.throws(()=>s.setOperator(ana),/não encontrado/);
  assert.deepEqual(s.listEmployees().map(e=>e.name),['Bia']);
  const byOp=s.report().byOperator;assert.deepEqual(byOp.map(x=>[x.name,x.count]).sort(),[['Ana',1],['Bia',1]]);
 }finally{s.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('manual weight and value entries keep service going without the scale',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('0',f.op);
  s.addManualWeight('0,450');s.addManualValue('25,00');
  const [w,v]=s.cart;
  assert.equal(w.grams,450);assert.equal(w.totalCents,2921);assert.equal(w.manual,true);assert.match(w.label,/digitado/);
  assert.equal(v.totalCents,2500);assert.equal(v.kind,'value');
  for(const bad of ['0','16','abc','0,0001','-1',''])assert.throws(()=>s.addManualWeight(bad),/Peso|peso/);
  for(const bad of ['0','abc','1000,01'])assert.throws(()=>s.addManualValue(bad));
  const sale=s.checkout('pix',randomUUID()).sale;
  const items=s.saleDetail(sale.id).items;assert.deepEqual(items.map(x=>x.manual),[1,1]);
  const r=s.report();assert.equal(r.manual.count,2);assert.equal(r.manual.totalCents,5421);assert.equal(r.grams,450);
 }finally{f.clean();}
});
test('cart corrections merge repeated products and respect stock',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('0',f.op);const p=s.product({name:'Água',price:'5,00',stock:3});
  s.addManual(p.id);s.addManual(p.id);assert.equal(s.cart.length,1);assert.equal(s.cart[0].quantity,2);assert.equal(s.cart[0].totalCents,1000);
  const key=s.cart[0].key;
  assert.throws(()=>s.setQuantity(key,4),/Estoque insuficiente/);
  s.setQuantity(key,1);assert.equal(s.cartTotal(),500);
  s.addWeighed(300);assert.throws(()=>s.setQuantity(s.cart[1].key,2),/Item não encontrado/);
  s.removeCart(key);assert.equal(s.cart.length,1);
 }finally{f.clean();}
});
test('canceling a sale returns stock and removes it from totals and the drawer',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('10,00',f.op);const p=s.product({name:'Água',price:'5,00',stock:5});
  s.addManual(p.id,2);s.addWeighed(500);const sale=s.checkout('cash',randomUUID()).sale;
  assert.equal(s.listProducts()[0].stock,3);
  assert.throws(()=>s.cancelSale(sale.id,''),/motivo/);
  const canceled=s.cancelSale(sale.id,'Peso errado');
  assert.equal(canceled.status,'canceled');assert.equal(canceled.cancel_reason,'Peso errado');assert.equal(canceled.canceled_by_name,'Ana');assert.equal(canceled.cancelable,false);
  assert.equal(s.listProducts()[0].stock,5);
  const c=s.cashSummary();assert.equal(c.expectedCents,1000);assert.equal(c.salesCount,0);assert.equal(c.canceledCount,1);
  const r=s.report();assert.equal(r.count,0);assert.equal(r.totalCents,0);assert.equal(r.canceled.count,1);assert.equal(r.canceled.totalCents,sale.total_cents);
  assert.throws(()=>s.cancelSale(sale.id,'de novo'),/já cancelada/);
  assert.throws(()=>s.cancelSale(999,'inexistente'),/não encontrada/);
  assert.equal(s.salesHistory({status:'canceled'}).sales.length,1);assert.equal(s.salesHistory({status:'done'}).sales.length,0);
 }finally{f.clean();}
});
test('cancel and correct puts the items back in the cart',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('0',f.op);const p=s.product({name:'Água',price:'5,00',stock:5});
  s.addWeighed(840);s.addManual(p.id,1);const sale=s.checkout('debit',randomUUID()).sale;
  s.addManualValue('1,00');assert.throws(()=>s.correctSale(sale.id,'Peso errado'),/Finalize ou limpe/);s.clearCart();
  const {cart}=s.correctSale(sale.id,'Peso errado');
  assert.deepEqual(cart.map(x=>[x.kind,x.grams,x.quantity,x.totalCents]),[['weight',840,undefined,5452],['unit',undefined,1,500]]);
  s.removeCart(cart[0].key);s.addManualWeight('0,800');
  const fixed=s.checkout('debit',randomUUID()).sale;assert.equal(fixed.total_cents,500+5192);
  assert.equal(s.listProducts()[0].stock,4);
  const r=s.report();assert.equal(r.count,1);assert.equal(r.canceled.count,1);
 }finally{f.clean();}
});
test('sales from a closed shift cannot be canceled',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('0',f.op);const sale=sell(s);s.closeShift('0');
  assert.throws(()=>s.cancelSale(sale.id,'tarde demais'),/caixa aberto/);
  s.openShift('0',f.op);assert.throws(()=>s.cancelSale(sale.id,'tarde demais'),/caixa aberto/);
  assert.equal(s.saleDetail(sale.id).cancelable,false);
 }finally{f.clean();}
});
test('reports by day, week and month follow the local calendar',()=>{
 const f=fixture();const s=f.db;try{
  s.openShift('0',f.op);
  const at=[['2026-03-11T15:00:00.000Z','pix','10,00'],['2026-03-12T02:30:00.000Z','cash','20,00'],['2026-03-09T13:00:00.000Z','debit','30,00'],['2026-03-02T13:00:00.000Z','credit','40,00'],['2026-02-28T13:00:00.000Z','pix','50,00'],['2026-03-16T13:00:00.000Z','pix','60,00']];
  for(const [iso,method,value] of at)backdate(s,sell(s,method,value).id,iso);
  // 2026-03-12T02:30Z is still 11/03 in São Paulo (UTC-3).
  const day=s.report({period:'day',date:'2026-03-11'});assert.equal(day.count,2);assert.equal(day.totalCents,3000);assert.equal(day.avgTicketCents,1500);
  const week=s.report({period:'week',date:'2026-03-11'});assert.equal(week.from,'2026-03-09');assert.equal(week.to,'2026-03-15');assert.equal(week.count,3);assert.equal(week.byDay.length,7);assert.equal(week.byDay[2].totalCents,3000);
  const month=s.report({period:'month',date:'2026-03-11'});assert.equal(month.from,'2026-03-01');assert.equal(month.to,'2026-03-31');assert.equal(month.count,5);assert.equal(month.byDay.length,31);
  assert.deepEqual(month.methods,{cash:2000,pix:7000,debit:3000,credit:4000});
  assert.equal(s.report({period:'month',date:'2026-02-10'}).count,1);
  assert.equal(s.salesHistory({from:'2026-03-09',to:'2026-03-11'}).sales.length,3);
  assert.equal(s.salesHistory({q:'#1'}).sales.length,1);
  assert.throws(()=>s.report({period:'year',date:'2026-03-11'}),/Período/);
  assert.throws(()=>s.report({period:'day',date:'2026-02-30'}),/Data inválida/);
  assert.throws(()=>s.salesHistory({from:'2026-03-10',to:'2026-03-01'}),/inicial depois/);
 }finally{f.clean();}
});
test('a v0.1 database is migrated without losing sales',()=>{
 const f=fixture(file=>{
  const old=new DatabaseSync(file);
  old.exec(`CREATE TABLE settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
   CREATE TABLE products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,price_cents INTEGER NOT NULL,stock INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE shifts(id INTEGER PRIMARY KEY AUTOINCREMENT,opened_at TEXT NOT NULL,opening_cents INTEGER NOT NULL,closed_at TEXT, counted_cents INTEGER,expected_cents INTEGER, difference_cents INTEGER);
   CREATE TABLE cash_events(id INTEGER PRIMARY KEY AUTOINCREMENT,shift_id INTEGER NOT NULL,kind TEXT NOT NULL,amount_cents INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
   CREATE TABLE sales(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE NOT NULL,shift_id INTEGER NOT NULL,created_at TEXT NOT NULL,method TEXT NOT NULL,total_cents INTEGER NOT NULL);
   CREATE TABLE sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL,product_id INTEGER,kind TEXT NOT NULL,label TEXT NOT NULL,grams INTEGER,quantity INTEGER,unit_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL);
   INSERT INTO settings VALUES('price_kg_cents','5990');`);
  const t=new Date().toISOString();
  old.prepare('INSERT INTO shifts(opened_at,opening_cents) VALUES(?,0)').run(t);
  old.prepare("INSERT INTO sales(uuid,shift_id,created_at,method,total_cents) VALUES('legacy-sale-0001',1,?,'pix',1234)").run(t);
  old.prepare("INSERT INTO sale_items(sale_id,kind,label,grams,unit_cents,total_cents) VALUES(1,'weight','Sorvete por peso',206,5990,1234)").run();
  old.close();
 });
 const s=f.db;try{
  assert.equal(s.getConfig().priceKgCents,5990);
  const sale=s.saleDetail(1);assert.equal(sale.status,'done');assert.equal(sale.operator_name,null);assert.equal(sale.items[0].manual,0);
  assert.equal(sale.received_cents,null);assert.equal(sale.change_cents,null);
  const r=s.report();assert.equal(r.count,1);assert.equal(r.totalCents,1234);assert.equal(r.byOperator[0].name,'Não identificado');
  assert.equal(s.cashSummary().shift.id,1);
 }finally{f.clean();}
});
