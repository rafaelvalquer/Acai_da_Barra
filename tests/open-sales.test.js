'use strict';
// Simultaneous sales (one tab per customer being served): cases T01–T18 of the plan.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');const {randomUUID}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const {Store}=require('../src/db');const {ScaleDriver}=require('../src/scale');const {createServer}=require('../src/server');

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=2000){const start=Date.now();while(!check()){if(Date.now()-start>ms)throw Error('Tempo esgotado aguardando a balança');await wait(5);}}
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'luminor-abas-'));
const count=(s,table)=>s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

// Store with an operator and the shift open: it starts with one empty sale, "Venda 01", on the scale.
function shop(){const dir=tmp();const s=new Store(path.join(dir,'abas.sqlite'));s.openShift('100,00',s.saveEmployee({name:'Ana'}).id);
  return {s,clean(){s.close();fs.rmSync(dir,{recursive:true,force:true});}};}
// Real HTTP server on a random port, with the demo scale, used the way the screen uses it.
async function boot(){
  const dir=tmp();const db=new Store(path.join(dir,'http.sqlite'));const scale=new ScaleDriver();
  const server=createServer({db,scale});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=async p=>(await fetch(base+p)).json();const {token}=await get('/api/session');
  const post=async(p,body={})=>{const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  db.openShift('0',db.saveEmployee({name:'Carla'}).id);
  return {db,scale,post,state:()=>get('/api/state'),
    async weigh(grams){await post('/api/scale/demo-weight',{grams});await post('/api/scale/demo-weight',{grams:0});},
    async close(){scale.disconnect();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
const frame=payload=>Buffer.from([0x02,...Buffer.from(payload,'ascii'),0x03]);
// Fake Toledo port answering every ENQ with the current reading. FakePort.initial is what a new connection reads first.
class FakePort extends EventEmitter{
  constructor(options){super();this.options=options;this.isOpen=false;this.enq=0;this.reading=FakePort.initial;FakePort.last=this;}
  open(cb){this.isOpen=true;cb();}
  close(cb){this.isOpen=false;if(cb)cb();}
  write(bytes,cb){if(bytes[0]===0x05&&this.isOpen){this.enq++;const r=this.reading;setImmediate(()=>this.emit('data',frame(r)));}if(cb)cb();}
  static list(){return Promise.resolve([]);}
}
FakePort.initial='00000';

test('T01 each open sale keeps its own items and total',()=>{
  const {s,clean}=shop();try{
    const a=s.activeSaleId();s.addManualWeight(a,'0,500');
    const b=s.createDraftSale();assert.equal(s.activeSaleId(),b.id);assert.equal(b.label,'Venda 02');
    s.addManualValue(b.id,'12,00');
    const p=s.product({name:'Água',price:'5,00',stock:10}).id;s.addUnit(a,p,2);
    assert.deepEqual(s.getDraftSale(a).items.map(x=>x.totalCents),[3245,1000]);assert.equal(s.getDraftSale(a).totalCents,4245);
    assert.deepEqual(s.getDraftSale(b.id).items.map(x=>x.totalCents),[1200]);
    assert.deepEqual(s.listDraftSales().map(d=>[d.label,d.item_count,d.total_cents]),[['Venda 01',2,4245],['Venda 02',1,1200]]);
    // An item can only be changed through the sale it belongs to.
    const [cup,water]=s.getDraftSale(a).items;
    assert.throws(()=>s.removeDraftSaleItem(b.id,cup.key),/não pertence a esta venda/);
    assert.throws(()=>s.setQuantity(b.id,water.key,1),/não pertence a esta venda/);
    assert.equal(s.getDraftSale(a).items.length,2);
  }finally{clean();}
});

test('T02 a new sale opens selected with an automatic name, and can be renamed',()=>{
  const {s,clean}=shop();try{
    const first=s.activeSaleId();const two=s.createDraftSale(),three=s.createDraftSale();
    assert.deepEqual([two.label,three.label],['Venda 02','Venda 03']);assert.equal(s.activeSaleId(),three.id);
    s.renameDraftSale(first,'Família Souza');
    assert.throws(()=>s.renameDraftSale(two.id,'família souza'),/Já existe uma venda aberta/);
    assert.throws(()=>s.renameDraftSale(two.id,'   '),/1 a 30/);
    assert.throws(()=>s.renameDraftSale(two.id,'x'.repeat(31)),/1 a 30/);
    assert.equal(s.renameDraftSale(two.id,'  Mesa   2 ').label,'Mesa 2');
    // A typed name that looks automatic is skipped by the next automatic name.
    s.renameDraftSale(three.id,'Venda 04');assert.equal(s.createDraftSale().label,'Venda 05');
    s.selectDraftSale(first);assert.equal(s.activeSaleId(),first);
    assert.deepEqual(s.listDraftSales().map(d=>d.label),['Família Souza','Mesa 2','Venda 04','Venda 05']);
  }finally{clean();}
});

test('T03 the scale captures only into the sale selected for weighing',async()=>{
  const t=await boot();try{
    await t.post('/api/scale/demo');const a=(await t.state()).activeSaleId;
    await t.weigh(500);
    const b=(await t.post('/api/open-sales/create')).body.result.id;await t.weigh(300);
    const grams=id=>t.db.getDraftSale(id).items.map(x=>x.grams);
    assert.deepEqual([grams(a),grams(b)],[[500],[300]]);
    await t.post('/api/open-sales/select',{saleId:a});await t.weigh(250);
    assert.deepEqual([grams(a),grams(b)],[[500,250],[300]]);
    assert.equal((await t.state()).activeSale.label,'Venda 01');
  }finally{await t.close();}
});

test('T04 three customers weighed in turns are never mixed, whatever order they pay in',async()=>{
  const t=await boot();try{
    await t.post('/api/scale/demo');
    const ids=[(await t.state()).activeSaleId];await t.weigh(410);
    ids.push((await t.post('/api/open-sales/create')).body.result.id);await t.weigh(380);
    ids.push((await t.post('/api/open-sales/create')).body.result.id);await t.weigh(520);
    for(const [i,g] of [[0,150],[2,90],[1,200]]){assert.equal((await t.post('/api/open-sales/select',{saleId:ids[i]})).status,200);await t.weigh(g);}
    assert.deepEqual(ids.map(id=>t.db.getDraftSale(id).items.map(x=>x.grams)),[[410,150],[380,200],[520,90]]);
    const totals=ids.map(id=>t.db.getDraftSale(id).totalCents);
    for(const [i,method] of [[1,'pix'],[2,'cash'],[0,'debit']])assert.equal((await t.post('/api/checkout',{saleId:ids[i],method,uuid:randomUUID()})).status,200);
    const sales=t.db.db.prepare('SELECT draft_sale_id,total_cents FROM sales ORDER BY id').all().map(x=>[x.draft_sale_id,x.total_cents]);
    assert.deepEqual(sales,[[ids[1],totals[1]],[ids[2],totals[2]],[ids[0],totals[0]]]);
    assert.equal(count(t.db,'sale_items'),6);
  }finally{await t.close();}
});

test('T05 a weighing is added by hand only to the sale on the scale, and closed sales take nothing',async()=>{
  const t=await boot();try{
    t.db.updateConfig({autoCapture:false});await t.post('/api/scale/demo');
    const a=(await t.state()).activeSaleId;const b=(await t.post('/api/open-sales/create')).body.result.id;
    await t.post('/api/scale/demo-weight',{grams:330});
    const wrong=await t.post('/api/cart/weight',{saleId:a});assert.equal(wrong.status,400);assert.match(wrong.body.error,/pesando para outra venda/);
    const ok=await t.post('/api/cart/weight',{saleId:b});assert.equal(ok.status,200);assert.equal(ok.body.result.items[0].grams,330);
    assert.equal(t.db.getDraftSale(a).items.length,0);
    // The same reading is not added a second time.
    assert.equal((await t.post('/api/cart/weight',{saleId:b})).status,400);assert.equal(t.db.getDraftSale(b).items.length,1);
    await t.post('/api/scale/demo-weight',{grams:0});
    await t.post('/api/checkout',{saleId:b,method:'pix',uuid:randomUUID()});
    assert.match((await t.post('/api/cart/manual-value',{saleId:b,amount:'5,00'})).body.error,/já foi cobrada/);
    await t.post('/api/open-sales/discard',{saleId:a});
    assert.match((await t.post('/api/cart/manual-value',{saleId:a,amount:'5,00'})).body.error,/foi descartada/);
    assert.match((await t.post('/api/cart/manual-value',{saleId:'nao-existe',amount:'5,00'})).body.error,/não encontrada/);
  }finally{await t.close();}
});

test('T06 the sale on the scale cannot change while there is weight on the plate',async()=>{
  const t=await boot();try{
    t.db.updateConfig({autoCapture:false});await t.post('/api/scale/demo');
    const a=(await t.state()).activeSaleId;const b=(await t.post('/api/open-sales/create')).body.result.id;
    await t.post('/api/scale/demo-weight',{grams:450});assert.equal((await t.state()).canSwitch,false);
    for(const [p,body] of [['/api/open-sales/select',{saleId:a}],['/api/open-sales/create',{}]]){
      const r=await t.post(p,body);assert.equal(r.status,400);assert.equal(r.body.error,'Retire o produto da balança para trocar de venda.');
    }
    assert.equal((await t.state()).activeSaleId,b);assert.equal(t.db.listDraftSales().length,2);
    // Selecting the sale that is already on the scale is harmless.
    assert.equal((await t.post('/api/open-sales/select',{saleId:b})).status,200);
    // Still blocked after the weighing is added, until the cup leaves the plate.
    await t.post('/api/cart/weight',{saleId:b});assert.equal((await t.post('/api/open-sales/select',{saleId:a})).status,400);
    t.scale.sample({status:'unstable',grams:120});assert.equal(t.scale.idle(),false);
    await t.post('/api/scale/demo-weight',{grams:0});assert.equal((await t.state()).canSwitch,true);
    assert.equal((await t.post('/api/open-sales/select',{saleId:a})).status,200);assert.equal((await t.state()).activeSaleId,a);
    assert.deepEqual([a,b].map(id=>t.db.getDraftSale(id).items.length),[0,1]);
  }finally{await t.close();}
});

test('T07 one weighing cycle becomes one item, even if offered again',()=>{
  const {s,clean}=shop();try{
    const a=s.activeSaleId();const id=randomUUID();
    assert.equal(s.addWeighed(a,500,id).duplicate,false);assert.equal(s.addWeighed(a,500,id).duplicate,true);
    // Not into another sale either.
    const b=s.createDraftSale().id;assert.equal(s.addWeighed(b,500,id).duplicate,true);
    assert.deepEqual([a,b].map(x=>s.getDraftSale(x).items.length),[1,0]);
    assert.throws(()=>s.addWeighed(a,500,'x y'),/Identificador de pesagem/);
    // The database itself refuses a second row for the same cycle.
    assert.throws(()=>s.db.prepare("INSERT INTO draft_sale_items(id,draft_sale_id,kind,label,unit_cents,total_cents,scale_capture_id,created_at) VALUES('z',?,'weight','x',1,1,?,'t')").run(a,id),/UNIQUE/);
  }finally{clean();}
});

test('T07 a reconnected scale does not capture the same cup again',async()=>{
  const dir=tmp();const db=new Store(path.join(dir,'s.sqlite'));db.openShift('0',db.saveEmployee({name:'Ana'}).id);
  const scale=new ScaleDriver({SerialPort:FakePort,pollMs:10});createServer({db,scale});
  try{
    FakePort.initial='00000';await scale.connect('COM9',2400);await until(()=>scale.snapshot().status==='stable');
    const sale=db.activeSaleId();const items=()=>db.getDraftSale(sale).items;
    FakePort.last.reading='00840';await until(()=>items().length===1);const first=items()[0].captureId;
    // Cable pulled and plugged back with the same cup still on the plate.
    scale.disconnect();FakePort.initial='00840';await scale.connect('COM9',2400);const port=FakePort.last;
    const polls=port.enq;await until(()=>port.enq>=polls+15);assert.equal(items().length,1);
    port.reading='00000';await until(()=>scale.snapshot().armed);port.reading='00420';
    await until(()=>items().length===2);assert.equal(items()[1].grams,420);assert.notEqual(items()[1].captureId,first);
  }finally{FakePort.initial='00000';scale.disconnect();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('T08 an item moves to another sale only by a recorded transfer',()=>{
  const {s,clean}=shop();try{
    const a=s.activeSaleId();s.renameDraftSale(a,'Família Souza');const p=s.product({name:'Água',price:'5,00',stock:5}).id;
    s.addManualWeight(a,'0,400');s.addUnit(a,p,1);
    const b=s.createDraftSale().id;s.addManualValue(b,'10,00');
    const water=s.getDraftSale(a).items[1];const r=s.transferDraftSaleItem(a,water.key,b);
    assert.deepEqual(r.from.items.map(x=>x.label),['Açaí por peso (digitado)']);assert.deepEqual(r.to.items.map(x=>x.label),['Água','Açaí (valor digitado)']);
    assert.equal(r.to.totalCents,1500);assert.equal(s.activeSaleId(),b);
    const out=s.draftEvents(a).find(e=>e.kind==='transfer_out'),into=s.draftEvents(b).find(e=>e.kind==='transfer_in');
    assert.equal(out.detail.to.id,b);assert.equal(into.detail.from.label,'Família Souza');assert.equal(into.detail.totalCents,500);assert.equal(out.operator_name,'Ana');
    // To a new sale: it opens with only that item, and the scale keeps weighing where it was.
    const cup=s.getDraftSale(a).items[0];const moved=s.transferDraftSaleItem(a,cup.key,'new');
    assert.equal(moved.to.label,'Venda 03');assert.deepEqual(moved.to.items.map(x=>x.key),[cup.key]);assert.equal(s.activeSaleId(),b);
    assert.throws(()=>s.transferDraftSaleItem(b,water.key,b),/outra venda/);
    assert.throws(()=>s.transferDraftSaleItem(a,water.key,b),/não pertence a esta venda/);
    s.checkoutDraftSale(moved.to.id,'pix',randomUUID());
    assert.throws(()=>s.transferDraftSaleItem(b,water.key,moved.to.id),/já foi cobrada/);
    // The reservation follows the item; it is not counted twice.
    assert.equal(s.listProducts()[0].reserved,1);
  }finally{clean();}
});

test('T09 charging one sale leaves the others as they were and never puts another customer on the scale',()=>{
  const {s,clean}=shop();try{
    const a=s.activeSaleId();s.addManualValue(a,'10,00');
    const b=s.createDraftSale().id;s.addManualValue(b,'20,00');
    const c=s.createDraftSale().id;s.addManualValue(c,'30,00');
    s.selectDraftSale(b);const r=s.checkoutDraftSale(b,'pix',randomUUID());
    assert.equal(r.sale.total_cents,2000);assert.ok(![a,c].includes(r.activeSaleId));assert.equal(s.getDraftSale(r.activeSaleId).items.length,0);
    assert.deepEqual(s.listDraftSales().map(d=>[d.label,d.total_cents]),[['Venda 01',1000],['Venda 03',3000],['Venda 04',0]]);
    assert.equal(s.getDraftSale(b).status,'completed');assert.equal(s.getDraftSale(b).sale_id,r.sale.id);
    // Paying a sale that is not on the scale leaves the scale where it is.
    const onScale=s.activeSaleId();s.checkoutDraftSale(a,'cash',randomUUID());assert.equal(s.activeSaleId(),onScale);
    assert.equal(s.getDraftSale(c).totalCents,3000);assert.equal(s.saleDetail(r.sale.id).draft_label,'Venda 02');
  }finally{clean();}
});

test('T10 open sales come back after a restart, with the same sale on the scale',()=>{
  const dir=tmp(),file=path.join(dir,'r.sqlite');let s=new Store(file);
  try{
    s.openShift('0',s.saveEmployee({name:'Ana'}).id);const a=s.activeSaleId();s.renameDraftSale(a,'Família Souza');s.addManualWeight(a,'0,350');
    const b=s.createDraftSale().id;s.addManualValue(b,'7,50');s.selectDraftSale(a);
    const before=s.listDraftSales();s.close();
    s=new Store(file);
    assert.deepEqual(s.listDraftSales(),before);assert.equal(s.activeSaleId(),a);assert.equal(s.getDraftSale(a).items[0].grams,350);
    // A missing pointer (old data, manual edit) is repaired with an empty sale, never another customer's.
    s.db.prepare('UPDATE shifts SET active_draft_id=NULL').run();s.close();s=new Store(file);
    const fresh=s.activeSaleId();assert.ok(![a,b].includes(fresh));assert.equal(s.getDraftSale(fresh).items.length,0);
    assert.deepEqual(s.listDraftSales().map(d=>d.label),['Família Souza','Venda 02','Venda 03']);
  }finally{s.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('T11 discarding one sale leaves the others unchanged',()=>{
  const {s,clean}=shop();try{
    const a=s.activeSaleId();s.addManualValue(a,'10,00');const b=s.createDraftSale().id;s.addManualValue(b,'20,00');
    const p=s.product({name:'Água',price:'5,00',stock:3}).id;s.addUnit(b,p,2);assert.equal(s.listProducts()[0].available,1);
    const r=s.discardDraftSale(b);
    assert.equal(r.discarded,b);assert.ok(![a,b].includes(r.activeSaleId));
    assert.equal(s.listProducts()[0].available,3);
    assert.deepEqual(s.listDraftSales().map(d=>[d.label,d.total_cents]),[['Venda 01',1000],['Venda 03',0]]);
    const [ev]=s.draftEvents(b);assert.equal(ev.kind,'discard');assert.equal(ev.detail.totalCents,3000);assert.equal(ev.detail.items,2);
    assert.throws(()=>s.discardDraftSale(b),/foi descartada/);assert.equal(count(s,'sales'),0);
  }finally{clean();}
});

test('T12 the shift only closes with no sale waiting to be charged, and empty tabs close with it',()=>{
  const {s,clean}=shop();try{
    const a=s.activeSaleId();s.addManualValue(a,'10,00');const b=s.createDraftSale().id;s.addManualValue(b,'5,00');s.createDraftSale();
    assert.throws(()=>s.closeShift('100,00'),{message:'Existem 2 vendas em aberto. Finalize ou descarte essas vendas para fechar o caixa.'});
    s.checkoutDraftSale(a,'cash',randomUUID());
    assert.throws(()=>s.closeShift('110,00'),{message:'Existe 1 venda em aberto (Venda 02). Finalize ou descarte essa venda para fechar o caixa.'});
    s.discardDraftSale(b);const empty=s.listDraftSales().map(d=>d.id);assert.equal(empty.length,1);
    assert.equal(s.closeShift('110,00').differenceCents,0);
    assert.equal(s.listDraftSales().length,0);assert.equal(s.activeSaleId(),null);assert.equal(s.getDraftSale(empty[0]).status,'discarded');
  }finally{clean();}
});

test('T13 a sale is charged once, whatever arrives twice',()=>{
  const {s,clean}=shop();try{
    const a=s.activeSaleId();s.addManualValue(a,'10,00');
    const one=s.checkoutDraftSale(a,'pix',randomUUID(),undefined,s.getDraftSale(a).revision);
    const two=s.checkoutDraftSale(a,'cash',randomUUID());
    assert.equal(two.duplicate,true);assert.equal(two.sale.id,one.sale.id);assert.equal(two.sale.method,'pix');assert.equal(count(s,'sales'),1);
    // Even past the code checks, the database keeps one sale per open sale.
    assert.throws(()=>s.db.prepare('INSERT INTO sales(uuid,shift_id,created_at,method,total_cents,draft_sale_id) VALUES(?,?,?,?,?,?)').run(randomUUID(),s.shift().id,new Date().toISOString(),'pix',1000,a),/UNIQUE/);
    // A total confirmed before another item arrived is not charged.
    const b=s.activeSaleId();s.addManualValue(b,'5,00');const seen=s.getDraftSale(b).revision;s.addManualValue(b,'3,00');
    assert.throws(()=>s.checkoutDraftSale(b,'pix',randomUUID(),undefined,seen),/mudou depois da conferência/);
    assert.equal(count(s,'sales'),1);
    assert.equal(s.checkoutDraftSale(b,'pix',randomUUID(),undefined,s.getDraftSale(b).revision).sale.total_cents,800);
  }finally{clean();}
});

test('T14 units in open sales are reserved until paid or removed',()=>{
  const {s,clean}=shop();try{
    const p=s.product({name:'Água',price:'5,00',stock:3}).id;const a=s.activeSaleId();s.addUnit(a,p,2);
    const b=s.createDraftSale().id;
    assert.throws(()=>s.addUnit(b,p,2),{message:'Estoque insuficiente para Água (disponível: 1)'});
    s.addUnit(b,p,1);const water=()=>{const w=s.listProducts()[0];return [w.stock,w.reserved,w.available];};
    assert.deepEqual(water(),[3,3,0]);
    assert.throws(()=>s.setQuantity(a,s.getDraftSale(a).items[0].key,3),/disponível: 2/);
    assert.throws(()=>s.deleteProduct(p),/vendas abertas/);
    s.checkoutDraftSale(a,'pix',randomUUID());assert.deepEqual(water(),[1,1,0]);
    s.removeDraftSaleItem(b,s.getDraftSale(b).items[0].key);assert.deepEqual(water(),[1,0,1]);
    assert.equal(s.deleteProduct(p),true);
  }finally{clean();}
});

test('T15 a failure while charging writes nothing and keeps the open sale',()=>{
  const {s,clean}=shop();try{
    const p=s.product({name:'Água',price:'5,00',stock:5}).id;const a=s.activeSaleId();s.addManualWeight(a,'0,300');s.addUnit(a,p,2);
    const prepare=s.db.prepare.bind(s.db);
    s.db.prepare=sql=>{if(/INSERT INTO sale_items/.test(sql))throw Error('disco cheio');return prepare(sql);};
    try{assert.throws(()=>s.checkoutDraftSale(a,'pix',randomUUID()),/disco cheio/);}finally{delete s.db.prepare;}
    assert.equal(count(s,'sales'),0);assert.equal(count(s,'sale_items'),0);assert.equal(s.listProducts()[0].stock,5);
    const d=s.getDraftSale(a);assert.equal(d.status,'open');assert.equal(d.items.length,2);assert.equal(s.activeSaleId(),a);
    assert.equal(s.checkoutDraftSale(a,'pix',randomUUID()).sale.total_cents,d.totalCents);assert.equal(s.listProducts()[0].stock,3);
  }finally{clean();}
});

test('T16 correcting a paid sale opens a separate sale and leaves the others alone',async()=>{
  const t=await boot();try{
    t.db.updateConfig({autoCapture:false});await t.post('/api/scale/demo');
    const a=(await t.state()).activeSaleId;await t.post('/api/cart/manual-value',{saleId:a,amount:'12,00'});
    const sale=(await t.post('/api/checkout',{saleId:a,method:'pix',uuid:randomUUID()})).body.result.sale;
    const serving=(await t.state()).activeSaleId;await t.post('/api/cart/manual-value',{saleId:serving,amount:'4,00'});
    // A cup is on the plate for the customer being served: the correction waits in its own tab.
    await t.post('/api/scale/demo-weight',{grams:300});
    const r=(await t.post('/api/sales/correct',{id:sale.id,reason:'Valor errado'})).body.result;
    assert.equal(r.selected,false);assert.equal(r.draft.label,`Correção #${sale.id}`);assert.deepEqual(r.draft.items.map(x=>x.totalCents),[1200]);
    const st=await t.state();assert.equal(st.activeSaleId,serving);assert.deepEqual(st.cart.map(x=>x.totalCents),[400]);
    assert.deepEqual(st.openSales.map(d=>d.label),['Venda 02',`Correção #${sale.id}`]);
    assert.equal(t.db.draftEvents(r.draft.id)[0].kind,'correction');assert.equal(t.db.saleDetail(sale.id).status,'canceled');
    // With the plate empty, the correction is selected right away.
    await t.post('/api/scale/demo-weight',{grams:0});
    await t.post('/api/checkout',{saleId:serving,method:'cash',uuid:randomUUID()});
    const paid=t.db.db.prepare('SELECT id FROM sales WHERE draft_sale_id=?').get(serving).id;
    const again=(await t.post('/api/sales/correct',{id:paid,reason:'Cliente trocou'})).body.result;
    assert.equal(again.selected,true);assert.equal((await t.state()).activeSaleId,again.draft.id);
  }finally{await t.close();}
});

test('T17 with the scale disconnected, typing and switching sales keep working',async()=>{
  const t=await boot();try{
    let st=await t.state();assert.equal(st.scale.mode,'offline');assert.equal(st.canSwitch,true);
    const a=st.activeSaleId;const b=(await t.post('/api/open-sales/create')).body.result.id;
    assert.equal((await t.post('/api/open-sales/select',{saleId:a})).status,200);
    assert.equal((await t.post('/api/cart/manual-weight',{saleId:a,weight:'0,420'})).status,200);
    assert.equal((await t.post('/api/cart/manual-value',{saleId:b,amount:'9,90'})).status,200);
    const w=await t.post('/api/cart/weight',{saleId:a});assert.equal(w.status,400);assert.match(w.body.error,/peso estável/);
    st=await t.state();assert.deepEqual(st.openSales.map(d=>d.total_cents),[2726,990]);
    // The scale drops in the middle of a weighing: switching is allowed again.
    await t.post('/api/scale/demo');t.db.updateConfig({autoCapture:false});await t.post('/api/scale/demo-weight',{grams:300});
    assert.equal((await t.state()).canSwitch,false);
    await t.post('/api/scale/disconnect');assert.equal((await t.state()).canSwitch,true);
    assert.equal((await t.post('/api/open-sales/select',{saleId:b})).status,200);
  }finally{await t.close();}
});

test('T18 a database from the previous version gets the open-sale tables and keeps its data',()=>{
  const dir=tmp(),file=path.join(dir,'v2.sqlite');
  // Schema written by the previous release (troco), which did not number its migrations.
  const old=new DatabaseSync(file);
  old.exec(`CREATE TABLE settings(k TEXT PRIMARY KEY,v TEXT NOT NULL);
    CREATE TABLE products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,price_cents INTEGER NOT NULL,stock INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE shifts(id INTEGER PRIMARY KEY AUTOINCREMENT,opened_at TEXT NOT NULL,opening_cents INTEGER NOT NULL,closed_at TEXT,counted_cents INTEGER,expected_cents INTEGER,difference_cents INTEGER,opened_by INTEGER,closed_by INTEGER);
    CREATE UNIQUE INDEX one_shift ON shifts((closed_at IS NULL)) WHERE closed_at IS NULL;
    CREATE TABLE cash_events(id INTEGER PRIMARY KEY AUTOINCREMENT,shift_id INTEGER NOT NULL,kind TEXT NOT NULL,amount_cents INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,operator_id INTEGER);
    CREATE TABLE sales(id INTEGER PRIMARY KEY AUTOINCREMENT,uuid TEXT UNIQUE NOT NULL,shift_id INTEGER NOT NULL,created_at TEXT NOT NULL,method TEXT NOT NULL,total_cents INTEGER NOT NULL,operator_id INTEGER,status TEXT NOT NULL DEFAULT 'done',canceled_at TEXT,canceled_by INTEGER,cancel_reason TEXT,received_cents INTEGER,change_cents INTEGER);
    CREATE TABLE sale_items(id INTEGER PRIMARY KEY AUTOINCREMENT,sale_id INTEGER NOT NULL,product_id INTEGER,kind TEXT NOT NULL,label TEXT NOT NULL,grams INTEGER,quantity INTEGER,unit_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,manual INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE employees(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    INSERT INTO settings VALUES('price_kg_cents','6490'),('auto_capture','1'),('operator_id','1');`);
  const at=new Date().toISOString();
  old.prepare("INSERT INTO employees(name,created_at) VALUES('Ana',?)").run(at);
  old.prepare('INSERT INTO shifts(opened_at,opening_cents,opened_by) VALUES(?,5000,1)').run(at);
  old.prepare("INSERT INTO sales(uuid,shift_id,created_at,method,total_cents,operator_id,received_cents,change_cents) VALUES('troco-sale-0001',1,?,'cash',3154,1,5000,1846)").run(at);
  old.prepare("INSERT INTO sale_items(sale_id,kind,label,grams,unit_cents,total_cents) VALUES(1,'weight','Açaí por peso',486,6490,3154)").run();
  old.close();
  let s=new Store(file);
  try{
    assert.equal(s.schemaVersion(),3);
    const tables=s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
    for(const name of ['draft_sales','draft_sale_items','draft_sale_events'])assert.ok(tables.includes(name),name);
    assert.ok(s.db.prepare('PRAGMA table_info(shifts)').all().some(c=>c.name==='active_draft_id'));
    assert.ok(s.db.prepare('PRAGMA index_list(sales)').all().some(i=>i.name==='sales_draft'&&i.unique));
    const sale=s.saleDetail(1);assert.equal(sale.total_cents,3154);assert.equal(sale.change_cents,1846);assert.equal(sale.draft_sale_id,null);assert.equal(sale.items.length,1);
    assert.deepEqual(s.listDraftSales().map(d=>[d.label,d.item_count]),[['Venda 01',0]]);assert.equal(s.cashSummary().expectedCents,5000+3154);
    // Opening it again changes nothing.
    s.close();s=new Store(file);assert.equal(s.schemaVersion(),3);assert.equal(s.listDraftSales().length,1);
    s.addManualValue(s.activeSaleId(),'10,00');assert.equal(s.checkoutDraftSale(s.activeSaleId(),'pix',randomUUID()).sale.id,2);
  }finally{s.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('T18 a weighing that could not be stored waits as a pending item until retried or discarded',async()=>{
  const t=await boot();try{
    await t.post('/api/scale/demo');const a=(await t.state()).activeSaleId;
    const real=t.db.addWeighed.bind(t.db);let fail=true;
    t.db.addWeighed=(...args)=>{if(fail)throw Error('Banco ocupado');return real(...args);};
    await t.post('/api/scale/demo-weight',{grams:480});
    let st=await t.state();assert.equal(st.cart.length,0);assert.equal(st.lastAutoError,'Banco ocupado');
    const [p]=st.pendingCaptures;assert.deepEqual([st.pendingCaptures.length,p.grams,p.saleId,p.label,p.error],[1,480,a,'Venda 01','Banco ocupado']);
    // The same cup is not offered again while it stays on the plate.
    await t.post('/api/scale/demo-weight',{grams:480});assert.equal((await t.state()).pendingCaptures.length,1);
    fail=false;
    assert.equal((await t.post('/api/scale/pending/retry',{captureId:p.captureId})).status,200);
    st=await t.state();assert.equal(st.pendingCaptures.length,0);assert.deepEqual(st.cart.map(x=>[x.grams,x.captureId]),[[480,p.captureId]]);
    assert.equal((await t.post('/api/scale/pending/retry',{captureId:p.captureId})).status,400);
    // Another failure, this time discarded on purpose: it is logged, never dropped silently.
    fail=true;await t.post('/api/scale/demo-weight',{grams:0});await t.post('/api/scale/demo-weight',{grams:250});
    const [q]=(await t.state()).pendingCaptures;assert.notEqual(q.captureId,p.captureId);
    const warn=console.warn;let logged='';console.warn=m=>{logged=m;};
    try{assert.equal((await t.post('/api/scale/pending/discard',{captureId:q.captureId})).status,200);}finally{console.warn=warn;}
    assert.match(logged,/250 g/);st=await t.state();assert.equal(st.pendingCaptures.length,0);assert.equal(st.cart.length,1);
  }finally{await t.close();}
});
