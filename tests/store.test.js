'use strict';
const {SCHEMA_VERSION}=require('../src/database/schema');
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const {ScaleDriver}=require('../src/scale');const {PdvStore}=require('../src/store');const {SQLiteAdapter}=require('../src/database/adapters/SQLiteAdapter');
const {tempStore,count,isPostgres}=require('./helpers');
// A store with one employee, Ana. `legacy` first writes a database from an older version (SQLite only).
async function fixture(legacy){
  if(legacy){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-test-'));const full=path.join(dir,'sample.sqlite');legacy(full);const db=await PdvStore.open(SQLiteAdapter.open(full));
    return {db,op:(await db.saveEmployee({name:'Ana'})).id,async clean(){await db.close();fs.rmSync(dir,{recursive:true,force:true});}};}
  const box=await tempStore();return {db:box.s,op:(await box.s.saveEmployee({name:'Ana'})).id,clean:()=>box.clean()};
}
const A=s=>s.activeSaleId();
const items=async s=>(await s.getDraftSale(await A(s))).items;
const pay=async(s,method,key=randomUUID(),received)=>s.checkoutDraftSale(await A(s),method,key,received);
const sell=async(s,method='pix',value='10,00')=>{await s.addManualValue(await A(s),value);return (await pay(s,method)).sale;};
const backdate=(s,id,iso)=>s.adapter.run('UPDATE sales SET created_at=? WHERE id=?',[iso,id]);

test('checkout weight, product stock, change and daily reports',async()=>{
 const f=await fixture();const s=f.db;
 try{
  assert.equal((await s.getConfig()).priceKgCents,6490);
  await assert.rejects(async()=>await s.addWeighed(await A(s),300),/caixa/);
  await s.openShift('100,00',f.op);
  const {id}=await s.product({name:'Água sem gás',price:'5,00',stock:3});
  await s.addWeighed(await A(s),840);await s.addUnit(await A(s),id,2);
  assert.equal((await s.getDraftSale(await A(s))).totalCents,6452);
  const key=randomUUID();const a=await pay(s,'cash',key);assert.equal(a.sale.total_cents,6452);
  assert.equal((await pay(s,'cash',key)).duplicate,true);
  assert.equal((await s.listProducts())[0].stock,1);
  assert.equal((await s.cashSummary()).expectedCents,16452);
  await s.moveCash('withdrawal','20,00','retirada');
  assert.equal((await s.cashSummary()).expectedCents,14452);
  const closed=await s.closeShift('144,52');assert.equal(closed.differenceCents,0);
  assert.equal((await s.report()).count,1);assert.equal((await s.report()).methods.cash,6452);
 }finally{await f.clean();}
});
test('stock rejects overselling and rolls back sale',async()=>{
 const f=await fixture();try{
 const s=f.db;await s.openShift('0',f.op);const p=await s.product({name:'Água',price:'5',stock:1});await s.addUnit(await A(s),p.id,1);
 // Another stock adjustment after the item enters the cart.
 await s.product({id:p.id,name:'Água',price:'5',stock:0});
 await assert.rejects(async()=>await pay(s,'pix',randomUUID()),/Estoque insuficiente/);
 assert.equal((await s.report()).sales.length,0);assert.equal((await s.listProducts())[0].stock,0);
 // Nothing was written: the open sale keeps its item to be fixed and charged again.
 assert.equal((await items(s)).length,1);assert.equal((await s.listDraftSales()).length,1);
 }finally{await f.clean();}
});
test('demo scale disarms and rearms only at zero',async()=>{
 const scale=new ScaleDriver();scale.demo();scale.setDemoGrams(840);
 assert.equal(scale.snapshot().ready,true);assert.equal(scale.consume(),840);assert.equal(scale.snapshot().ready,false);
 scale.setDemoGrams(840);assert.equal(scale.snapshot().ready,false);
 scale.setDemoGrams(0);assert.equal(scale.snapshot().armed,true);scale.setDemoGrams(420);
 assert.equal(scale.snapshot().ready,true);scale.disconnect();
});

test('the same sale id is recorded only once',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('50,00',f.op);const p=await s.product({name:'Água',price:'5,00',stock:5});
  await s.addUnit(await A(s),p.id,2);await s.addWeighed(await A(s),500);const key=randomUUID();
  const first=await pay(s,'cash',key);const again=await pay(s,'cash',key);
  assert.equal(first.duplicate,false);assert.equal(again.duplicate,true);assert.equal(again.sale.id,first.sale.id);
  assert.equal(await count(s,'sales'),1);
  assert.equal(await count(s,'sale_items'),2);
  assert.equal((await s.listProducts())[0].stock,3);
  assert.equal((await s.cashSummary()).expectedCents,5000+first.sale.total_cents);
  await assert.rejects(async()=>await pay(s,'cash',randomUUID()),/não tem itens/);
  await assert.rejects(async()=>await pay(s,'cash','curto'),/Identificador/);
  await assert.rejects(async()=>await pay(s,'cheque',randomUUID()),/Forma de pagamento/);
 }finally{await f.clean();}
});
test('each payment method is totaled and only cash goes into the drawer',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('100,00',f.op);
  await sell(s,'pix','10,00');await sell(s,'cash','20,00');await sell(s,'debit','30,00');await sell(s,'credit','40,00');await sell(s,'cash','5,50');
  const c=await s.cashSummary();
  assert.deepEqual(c.methods,{cash:2550,pix:1000,debit:3000,credit:4000});
  assert.equal(c.totalCents,10550);assert.equal(c.salesCount,5);
  assert.equal(c.expectedCents,10000+2550);
  assert.deepEqual((await s.report()).methods,{cash:2550,pix:1000,debit:3000,credit:4000});
 }finally{await f.clean();}
});
test('cash payment records the amount received and the change',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('100,00',f.op);
  await s.addManualValue(await A(s),'31,54');const key=randomUUID();
  const sale=(await pay(s,'cash',key,'50,00')).sale;
  assert.equal(sale.received_cents,5000);assert.equal(sale.change_cents,1846);
  // The drawer keeps the sale total: the change left with the customer.
  assert.equal((await s.cashSummary()).expectedCents,10000+3154);
  assert.equal((await pay(s,'cash',key,'100,00')).sale.change_cents,1846);
  const detail=await s.saleDetail(sale.id);assert.equal(detail.received_cents,5000);assert.equal(detail.change_cents,1846);
  await s.addManualValue(await A(s),'31,54');
  await assert.rejects(async()=>await pay(s,'cash',randomUUID(),'30,00'),/Valor recebido menor/);
  await assert.rejects(async()=>await pay(s,'cash',randomUUID(),'cinquenta'),/Use valor/);
  assert.equal((await items(s)).length,1);assert.equal(await count(s,'sales'),1);
  assert.equal((await pay(s,'cash',randomUUID(),'R$ 31,54')).sale.change_cents,0);
  await s.addManualValue(await A(s),'12,00');const blank=(await pay(s,'cash',randomUUID(),'')).sale;assert.equal(blank.received_cents,null);assert.equal(blank.change_cents,null);
  await s.addManualValue(await A(s),'12,00');const pix=(await pay(s,'pix',randomUUID(),'50,00')).sale;assert.equal(pix.received_cents,null);assert.equal(pix.change_cents,null);
  assert.equal((await s.cashSummary()).expectedCents,10000+3154+3154+1200);
 }finally{await f.clean();}
});
test('closing the shift checks open sales, computes the difference and blocks new sales',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('100,00',f.op);await sell(s,'cash','30,00');await sell(s,'pix','12,00');await s.moveCash('supply','10,00','troco');
  await s.addManualValue(await A(s),'8,00');
  await assert.rejects(async()=>await s.closeShift('140,00'),/Existe 1 venda em aberto \(Venda 03\)/);
  await s.discardDraftSale(await A(s));
  const short=await s.closeShift('135,00');
  assert.equal(short.expectedCents,14000);assert.equal(short.differenceCents,-500);
  assert.deepEqual(short.methods,{cash:3000,pix:1200,debit:0,credit:0});assert.equal(short.salesCount,2);
  await assert.rejects(async()=>await s.addManualValue(await A(s),'1,00'),/caixa/);await assert.rejects(async()=>await s.addWeighed(await A(s),300),/caixa/);
  await assert.rejects(async()=>await pay(s,'cash',randomUUID()),/caixa/);
  await assert.rejects(async()=>await s.closeShift('0'),/Não há caixa/);
  await s.openShift('0',f.op);await sell(s,'cash','10,00');
  assert.equal((await s.closeShift('12,00')).differenceCents,200);
  const shifts=(await s.report()).shifts;assert.equal(shifts.length,2);assert.equal(shifts[1].difference_cents,-500);assert.equal(shifts[1].closed_by_name,'Ana');
 }finally{await f.clean();}
});
test('withdrawal cannot exceed the cash in the drawer',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('20,00',f.op);
  await assert.rejects(async()=>await s.moveCash('withdrawal','20,01','cofre'),/maior que o dinheiro/);
  await s.moveCash('withdrawal','20,00','cofre');assert.equal((await s.cashSummary()).expectedCents,0);
  const ev=(await s.cashSummary()).events[0];assert.equal(ev.operator_name,'Ana');
 }finally{await f.clean();}
});
test('operator is required, recorded and can be switched',async()=>{
 const box=await tempStore();const s=box.s;
 try{
  await assert.rejects(async()=>await s.openShift('0'),/operador/);
  const ana=(await s.saveEmployee({name:'Ana'})).id,bia=(await s.saveEmployee({name:'Bia'})).id;
  await assert.rejects(async()=>await s.saveEmployee({name:' ana '}),/Já existe/);
  await assert.rejects(async()=>await s.saveEmployee({name:'A'}),/2 a 40/);
  await s.openShift('0',ana);assert.equal((await s.shift()).opened_by,ana);assert.equal((await s.operator()).name,'Ana');
  assert.equal((await sell(s)).operator_id,ana);
  await s.setOperator(bia);assert.equal((await sell(s)).operator_id,bia);
  await assert.rejects(async()=>await s.removeEmployee(bia),/Troque o operador/);
  await s.removeEmployee(ana);await assert.rejects(async()=>await s.setOperator(ana),/não encontrado/);
  assert.deepEqual((await s.listEmployees()).map(e=>e.name),['Bia']);
  const byOp=(await s.report()).byOperator;assert.deepEqual(byOp.map(x=>[x.name,x.count]).sort(),[['Ana',1],['Bia',1]]);
 }finally{await box.clean();}
});
test('manual weight and value entries keep service going without the scale',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('0',f.op);
  await s.addManualWeight(await A(s),'0,450');await s.addManualValue(await A(s),'25,00');
  const [w,v]=await items(s);
  assert.equal(w.grams,450);assert.equal(w.totalCents,2921);assert.equal(w.manual,true);assert.match(w.label,/digitado/);
  assert.equal(v.totalCents,2500);assert.equal(v.kind,'value');
  for(const bad of ['0','16','abc','0,0001','-1',''])await assert.rejects(async()=>await s.addManualWeight(await A(s),bad),/Peso|peso/);
  for(const bad of ['0','abc','1000,01'])await assert.rejects(async()=>await s.addManualValue(await A(s),bad));
  const sale=(await pay(s,'pix',randomUUID())).sale;
  const saved=(await s.saleDetail(sale.id)).items;assert.deepEqual(saved.map(x=>x.manual),[1,1]);
  const r=await s.report();assert.equal(r.manual.count,2);assert.equal(r.manual.totalCents,5421);assert.equal(r.grams,450);
 }finally{await f.clean();}
});
test('cart corrections merge repeated products and respect stock',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('0',f.op);const p=await s.product({name:'Água',price:'5,00',stock:3});
  await s.addUnit(await A(s),p.id);await s.addUnit(await A(s),p.id);assert.equal((await items(s)).length,1);assert.equal((await items(s))[0].quantity,2);assert.equal((await items(s))[0].totalCents,1000);
  const key=(await items(s))[0].key;
  await assert.rejects(async()=>await s.setQuantity(await A(s),key,4),/Estoque insuficiente/);
  await s.setQuantity(await A(s),key,1);assert.equal((await s.getDraftSale(await A(s))).totalCents,500);
  await s.addWeighed(await A(s),300);await assert.rejects(async()=>await s.setQuantity(await A(s),(await items(s))[1].key,2),/Só produtos avulsos/);
  await assert.rejects(async()=>await s.setQuantity(await A(s),'nao-existe',2),/Item não encontrado/);
  await s.removeDraftSaleItem(await A(s),key);assert.equal((await items(s)).length,1);
 }finally{await f.clean();}
});
test('canceling a sale returns stock and removes it from totals and the drawer',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('10,00',f.op);const p=await s.product({name:'Água',price:'5,00',stock:5});
  await s.addUnit(await A(s),p.id,2);await s.addWeighed(await A(s),500);const sale=(await pay(s,'cash',randomUUID())).sale;
  assert.equal((await s.listProducts())[0].stock,3);
  await assert.rejects(async()=>await s.cancelSale(sale.id,''),/motivo/);
  const canceled=await s.cancelSale(sale.id,'Peso errado');
  assert.equal(canceled.status,'canceled');assert.equal(canceled.cancel_reason,'Peso errado');assert.equal(canceled.canceled_by_name,'Ana');assert.equal(canceled.cancelable,false);
  assert.equal((await s.listProducts())[0].stock,5);
  const c=await s.cashSummary();assert.equal(c.expectedCents,1000);assert.equal(c.salesCount,0);assert.equal(c.canceledCount,1);
  const r=await s.report();assert.equal(r.count,0);assert.equal(r.totalCents,0);assert.equal(r.canceled.count,1);assert.equal(r.canceled.totalCents,sale.total_cents);
  await assert.rejects(async()=>await s.cancelSale(sale.id,'de novo'),/já cancelada/);
  await assert.rejects(async()=>await s.cancelSale(999,'inexistente'),/não encontrada/);
  assert.equal((await s.salesHistory({status:'canceled'})).sales.length,1);assert.equal((await s.salesHistory({status:'done'})).sales.length,0);
 }finally{await f.clean();}
});
test('cancel and correct moves the items to a new open sale of their own',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('0',f.op);const p=await s.product({name:'Água',price:'5,00',stock:5});
  await s.addWeighed(await A(s),840);await s.addUnit(await A(s),p.id,1);const sale=(await pay(s,'debit')).sale;
  // Another customer is already being served on the scale: the correction does not touch that sale.
  await s.addManualValue(await A(s),'1,00');const serving=await A(s);
  const {draft,selected}=await s.correctSale(sale.id,'Peso errado');
  assert.equal(selected,false);assert.equal(await A(s),serving);assert.equal(draft.label,`Correção #${sale.id}`);
  assert.deepEqual(draft.items.map(x=>[x.kind,x.grams,x.quantity,x.totalCents]),[['weight',840,undefined,5452],['unit',undefined,1,500]]);
  assert.deepEqual((await items(s)).map(x=>x.totalCents),[100]);
  await s.removeDraftSaleItem(draft.id,draft.items[0].key);await s.addManualWeight(draft.id,'0,800');
  const fixed=(await s.checkoutDraftSale(draft.id,'debit',randomUUID())).sale;assert.equal(fixed.total_cents,500+5192);
  assert.equal((await s.listProducts())[0].stock,4);
  const r=await s.report();assert.equal(r.count,1);assert.equal(r.canceled.count,1);
  assert.equal(await A(s),serving);assert.deepEqual((await items(s)).map(x=>x.totalCents),[100]);
 }finally{await f.clean();}
});
test('sales from a closed shift cannot be canceled',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('0',f.op);const sale=await sell(s);await s.closeShift('0');
  await assert.rejects(async()=>await s.cancelSale(sale.id,'tarde demais'),/caixa aberto/);
  await s.openShift('0',f.op);await assert.rejects(async()=>await s.cancelSale(sale.id,'tarde demais'),/caixa aberto/);
  assert.equal((await s.saleDetail(sale.id)).cancelable,false);
 }finally{await f.clean();}
});
test('reports by day, week and month follow the local calendar',async()=>{
 const f=await fixture();const s=f.db;try{
  await s.openShift('0',f.op);
  const at=[['2026-03-11T15:00:00.000Z','pix','10,00'],['2026-03-12T02:30:00.000Z','cash','20,00'],['2026-03-09T13:00:00.000Z','debit','30,00'],['2026-03-02T13:00:00.000Z','credit','40,00'],['2026-02-28T13:00:00.000Z','pix','50,00'],['2026-03-16T13:00:00.000Z','pix','60,00']];
  for(const [iso,method,value] of at)await backdate(s,(await sell(s,method,value)).id,iso);
  // 2026-03-12T02:30Z is still 11/03 in São Paulo (UTC-3).
  const day=await s.report({period:'day',date:'2026-03-11'});assert.equal(day.count,2);assert.equal(day.totalCents,3000);assert.equal(day.avgTicketCents,1500);
  const week=await s.report({period:'week',date:'2026-03-11'});assert.equal(week.from,'2026-03-09');assert.equal(week.to,'2026-03-15');assert.equal(week.count,3);assert.equal(week.byDay.length,7);assert.equal(week.byDay[2].totalCents,3000);
  const month=await s.report({period:'month',date:'2026-03-11'});assert.equal(month.from,'2026-03-01');assert.equal(month.to,'2026-03-31');assert.equal(month.count,5);assert.equal(month.byDay.length,31);
  assert.deepEqual(month.methods,{cash:2000,pix:7000,debit:3000,credit:4000});
  assert.equal((await s.report({period:'month',date:'2026-02-10'})).count,1);
  assert.equal((await s.salesHistory({from:'2026-03-09',to:'2026-03-11'})).sales.length,3);
  assert.equal((await s.salesHistory({q:'#1'})).sales.length,1);
  await assert.rejects(async()=>await s.report({period:'year',date:'2026-03-11'}),/Período/);
  await assert.rejects(async()=>await s.report({period:'day',date:'2026-02-30'}),/Data inválida/);
  await assert.rejects(async()=>await s.salesHistory({from:'2026-03-10',to:'2026-03-01'}),/inicial depois/);
 }finally{await f.clean();}
});
test('a v0.1 database is migrated without losing sales',{skip:isPostgres&&'arquivo SQLite da versão 0.1'},async()=>{
 const f=await fixture(file=>{
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
  assert.equal((await s.getConfig()).priceKgCents,5990);
  const sale=await s.saleDetail(1);assert.equal(sale.status,'done');assert.equal(sale.operator_name,null);assert.equal(sale.items[0].manual,0);
  assert.equal(sale.received_cents,null);assert.equal(sale.change_cents,null);
  const r=await s.report();assert.equal(r.count,1);assert.equal(r.totalCents,1234);assert.equal(r.byOperator[0].name,'Não identificado');
  assert.equal((await s.cashSummary()).shift.id,1);
  // The shift that was open gets an empty sale, ready for the scale.
  assert.equal(await s.schemaVersion(),SCHEMA_VERSION);assert.deepEqual((await s.listDraftSales()).map(d=>[d.label,d.item_count]),[['Venda 01',0]]);assert.equal(await A(s),(await s.listDraftSales())[0].id);
 }finally{await f.clean();}
});
