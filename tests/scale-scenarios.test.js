'use strict';
// Consecutive weighings (the numbers are the scenarios of docs/diagnostico-performance-balanca.md). Where timing
// matters the driver runs with its production values; the long series use a faster poll or feed readings directly.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {scaleRig}=require('./scale-rig');const {scaleSimulator,frame}=require('./serial-sim');const {until,wait}=require('./helpers');
const {ScaleDriver}=require('../src/scale');const {scaleLog}=require('../src/scaleLog');const {loadConfig}=require('../src/config');
const {calcTotal}=require('../src/protocol');

const FAST={pollMs:5,timeoutMs:100,reconnectMs:[30]};
const grams=items=>items.map(i=>i.grams);
const unique=items=>new Set(items.map(i=>i.captureId)).size;
const armed=r=>until(()=>r.scale.snapshot().armed,3000);
// A cup placed and then taken away, waiting for the PDV to see each step.
async function cup(r,g,n){await r.sim.place(g);await r.waitItems(n);await r.sim.remove();await armed(r);}
// Readings fed straight into the driver, as the serial port would deliver them (no timers involved).
const feed=(scale,...values)=>{for(const v of values)scale.sample(typeof v==='number'?{status:'stable',grams:v}:{status:v,grams:null});};
async function demoRig(){const r=await scaleRig();r.scale.mode='demo';return r;}
const logged=r=>r.scale.diagnostics().events;

test('01 the first weighing after opening the till: a cup already waiting goes in once',async()=>{
  const r=await scaleRig({open:false,options:FAST});try{
    await r.connect();await r.sim.place(480);await until(()=>r.scale.snapshot().ready);await wait(150);assert.equal(r.scale.snapshot().ready,true,'waits on the scale while the till is closed');
    await r.db.openShift('0',r.operator);assert.deepEqual(grams(await r.waitItems(1)),[480]);
    await wait(150);assert.equal((await r.items()).length,1);
  }finally{await r.clean();}
});
test('02/05/06 consecutive cups right after each other, with different and with identical weights (production timing)',async()=>{
  const r=await scaleRig();try{
    await r.connect();let n=0;
    for(const g of [420,515,515,515,300]){await r.sim.place(g,200);await r.waitItems(++n);await wait(60);await r.sim.remove(150);await wait(250);}
    const items=await r.items();assert.deepEqual(grams(items),[420,515,515,515,300]);assert.equal(unique(items),5);
  }finally{await r.clean();}
});
test('03/25 a hundred weighings in a row over the serial port: all of them, once, with the right total',async()=>{
  const r=await scaleRig({options:FAST,sim:scaleSimulator({latencyMs:2})});try{
    await r.connect();const expected=[];
    for(let n=1;n<=100;n++){const g=200+(n%7)*10;expected.push(g);await cup(r,g,n);}
    const sale=await r.db.getDraftSale(await r.db.activeSaleId());
    assert.deepEqual(grams(sale.items),expected);assert.equal(unique(sale.items),100);
    const price=(await r.db.getConfig()).priceKgCents;
    assert.equal(sale.totalCents,expected.reduce((s,g)=>s+calcTotal(g,price),0));
  }finally{await r.clean();}
});
test('04 endurance: a thousand weighings, none lost and none twice',async()=>{
  const r=await demoRig();try{
    for(let n=0;n<1000;n++){feed(r.scale,300,300,300,0);if(n%50===49)await r.server.settle(10000);}
    await until(async()=>(await r.items()).length>=1000,20000);
    const items=await r.items();assert.equal(items.length,1000);assert.equal(unique(items),1000);
    assert.equal(r.scale.diagnostics().counters.rearms,1000);
  }finally{await r.clean();}
});
test('07 the plate empty for 200, 300, 500 and 1000 ms frees the next weighing; 100 ms may be too short to see',async()=>{
  const r=await scaleRig();try{
    await r.connect();let n=1;await r.sim.place(350);await r.waitItems(1);
    for(const ms of [200,300,500,1000]){
      await wait(200);await r.sim.remove();await wait(ms);await r.sim.place(350);
      assert.equal((await r.waitItems(++n,2000)).length,n,`removal of ${ms} ms`);
    }
    // Shorter than the interval between two ENQs: the scale may never be asked while the plate is empty. Then there is
    // no way to know it was another cup, and nothing is invented; it is never charged more than once.
    await wait(200);await r.sim.remove();await wait(100);await r.sim.place(350);await wait(600);
    const total=(await r.items()).length;assert.ok(total===n||total===n+1,String(total));
  }finally{await r.clean();}
});
test('08/09 a residue of 4 g and of exactly 10 g is the empty plate; 11 g is not',async()=>{
  const r=await demoRig();try{
    feed(r.scale,4,4,4,10,10);await r.server.settle();assert.equal((await r.items()).length,0);
    feed(r.scale,400,400);await r.waitItems(1);
    feed(r.scale,11,11,11);assert.equal(r.scale.snapshot().armed,false,'11 g does not free the next weighing');
    feed(r.scale,4,400,400);await r.waitItems(2);
    feed(r.scale,10,400,400);await r.waitItems(3);
    await r.server.settle();assert.deepEqual(grams(await r.items()),[400,400,400]);
  }finally{await r.clean();}
});
test('10 with a tare on the scale one negative reading is the empty plate',async()=>{
  const r=await demoRig();try{
    feed(r.scale,126,126,'negative',300,300);await r.waitItems(2);assert.deepEqual(grams(await r.items()),[126,300]);
  }finally{await r.clean();}
});
test('11 a weight still oscillating is never captured, and unstable or overload do not free a taken cup',async()=>{
  const r=await demoRig();try{
    feed(r.scale,500,510,500,510,'unstable',500,'unstable',500,'overload',500,'invalid',500);await r.server.settle();
    assert.equal((await r.items()).length,0);
    feed(r.scale,505,505);await r.waitItems(1);
    feed(r.scale,'unstable','unstable',505,505,'overload',505,505,'invalid',505,505);await r.server.settle();
    assert.deepEqual(grams(await r.items()),[505]);
  }finally{await r.clean();}
});
test('12/13 a cup left on the plate for 30 s of readings, or with more put into it, is charged once',async()=>{
  const r=await demoRig();try{
    for(let i=0;i<200;i++)feed(r.scale,400);        // 30 s at one reading every 150 ms
    await r.waitItems(1);
    feed(r.scale,'unstable',520,520,520,'unstable',610,610);await r.server.settle();
    assert.deepEqual(grams(await r.items()),[400]);assert.match(r.scale.blockReason(),/prato ficar vazio/);
  }finally{await r.clean();}
});
for(const delay of [100,500,1000,2000]){
  test(`14 database taking ${delay} ms: the next cup, placed during the write, is not lost and not mixed up`,async()=>{
    const r=await scaleRig({options:FAST});try{
      r.slowDatabase(delay);await r.connect();
      await r.sim.place(480);await until(()=>!r.scale.snapshot().armed);
      await r.sim.remove();await armed(r);await r.sim.place(350);await until(()=>!r.scale.snapshot().armed,delay+3000);
      await r.sim.remove();await armed(r);await r.sim.place(350);
      const items=await r.waitItems(3,delay*3+3000);assert.deepEqual(grams(items),[480,350,350]);assert.equal(unique(items),3);
      await wait(100);assert.equal((await r.items()).length,3);
    }finally{await r.clean();}
  });
}
test('15 the cup taken away while it is being written is stored once and the plate is free again',async()=>{
  const r=await scaleRig({options:FAST});try{
    r.slowDatabase(400);await r.connect();await r.sim.place(480);await until(()=>!r.scale.snapshot().armed);
    await r.sim.remove();await armed(r);assert.equal(r.scale.diagnostics().state.blockReason,'Prato vazio','the plate is free while the write goes on');
    assert.deepEqual(grams(await r.waitItems(1)),[480]);await wait(150);assert.equal((await r.items()).length,1);
  }finally{await r.clean();}
});
test('16 late, split and missing answers: the reading goes on and each cup goes in once (production timing)',async()=>{
  const sim=scaleSimulator({faults:{delay:n=>n%11===0?800:0,drop:n=>n%7===0,fragment:n=>n%3===0}});
  const r=await scaleRig({sim});try{
    await r.connect();
    for(let n=1;n<=4;n++){await r.sim.place(300+n);await r.waitItems(n,6000);await wait(100);await r.sim.remove();await until(()=>r.scale.snapshot().armed,5000);}
    assert.deepEqual(grams(await r.items()),[301,302,303,304]);
    const d=r.scale.diagnostics();assert.ok(d.counters.timeouts>0);assert.ok(d.serial.count>0);
  }finally{await r.clean();}
});
test('16 one request at a time: nothing piles up on a slow scale, and a repeated frame is not a second confirmation',async()=>{
  const r=await scaleRig({options:{pollMs:5,timeoutMs:1000},sim:scaleSimulator({latencyMs:120})});try{
    await r.connect();const before=r.sim.enq;await wait(600);
    assert.ok(r.sim.enq-before<=6,`${r.sim.enq-before} requests in 600 ms with a 120 ms answer`);
    // Two frames for one request: the second one has no request waiting.
    r.sim.faults.drop=()=>true;await wait(300);
    r.sim.port.emit('data',Buffer.concat([frame('00700'),frame('00700')]));
    assert.equal(r.scale.snapshot().ready,false);assert.ok(r.scale.diagnostics().counters.unsolicited>=1);
    assert.equal((await r.items()).length,0);
  }finally{await r.clean();}
});
test('17 the port falls and comes back by itself: a captured cup is not captured again',async()=>{
  const r=await scaleRig({options:FAST});try{
    await r.connect();await r.sim.place(480);await r.waitItems(1);
    r.sim.unplug();assert.equal(r.scale.snapshot().mode,'offline');assert.equal(r.scale.snapshot().lastError,'Porta serial fechada');
    await wait(150);r.sim.plug();await until(()=>r.scale.snapshot().mode==='serial'&&r.scale.snapshot().status==='stable',2000);
    await wait(100);assert.equal((await r.items()).length,1);assert.equal(r.scale.diagnostics().counters.reconnects,1);
    await r.sim.remove();await armed(r);await r.sim.place(350);assert.deepEqual(grams(await r.waitItems(2)),[480,350]);
    // Disconnecting on purpose stops the retries.
    const opens=r.sim.opens;r.scale.disconnect();await wait(150);assert.equal(r.sim.opens,opens);assert.equal(r.scale.snapshot().mode,'offline');
    // Falling again while a retry is waiting, and then disconnecting: the retry is cancelled.
    await r.connect();r.sim.unplug();r.scale.disconnect();r.sim.plug();await wait(150);assert.equal(r.scale.snapshot().mode,'offline');
  }finally{await r.clean();}
});
test('18 the weighing stays with the sale that was on the scale, even if the tab changes while it is written',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    const a=await r.db.activeSaleId();const b=(await r.db.createDraftSale()).id;await r.db.selectDraftSale(a);
    r.slowDatabase(400);await r.connect();await r.sim.place(480);await until(()=>!r.scale.snapshot().armed);
    // With the cup still on the plate the screen cannot switch.
    assert.equal((await r.post('/api/open-sales/select',{saleId:b})).status,400);
    await r.sim.remove();await armed(r);
    assert.equal((await r.post('/api/open-sales/select',{saleId:b})).status,200);
    assert.deepEqual(grams(await r.items(a)),[480]);assert.equal((await r.items(b)).length,0);
    // Even a switch made behind the screen's back, right after the cup: the destination was read with the weighing.
    await r.sim.place(350);await until(()=>!r.scale.snapshot().armed);await r.db.selectDraftSale(a);
    await until(async()=>(await r.items(b)).length===1);assert.equal((await r.items(a)).length,1);
  }finally{await r.clean();}
});
test('19 the button and the automatic capture at the same time: one item',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    r.slowDatabase(200);await r.connect();const saleId=await r.db.activeSaleId();
    await r.sim.place(480);await until(()=>r.scale.diagnostics().state.phase!=='WAITING_PRODUCT');
    const answers=await Promise.all([1,2,3].map(()=>r.post('/api/cart/weight',{saleId})));
    await r.server.settle(2000);await wait(300);
    assert.equal((await r.items()).length,1,JSON.stringify(answers.map(x=>x.body.error||'ok')));
    // With the automatic capture off, two taps on the button still add it once.
    await r.db.updateConfig({autoCapture:false});await r.sim.remove();await armed(r);await r.sim.place(350);await until(()=>r.scale.snapshot().ready);
    const taps=await Promise.all([r.post('/api/cart/weight',{saleId}),r.post('/api/cart/weight',{saleId})]);
    assert.deepEqual(taps.map(x=>x.status).sort(),[200,400]);assert.deepEqual(grams(await r.items()),[480,350]);
  }finally{await r.clean();}
});
test('20 a write that fails waits as pending while the next cups go on; retried twice at once, it goes in once',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    let fail=true;r.db.adapter.onQuery=sql=>{if(fail&&/INSERT INTO draft_sale_items/.test(sql))throw Error('Banco ocupado');};
    await r.connect();await r.sim.place(480);await until(async()=>(await r.get('/api/state')).body.pendingCaptures.length===1);
    fail=false;await r.sim.remove();await armed(r);await r.sim.place(350);await r.waitItems(1);
    const [p]=(await r.get('/api/state')).body.pendingCaptures;assert.equal(p.grams,480);
    const retries=await Promise.all([1,2].map(()=>r.post('/api/scale/pending/retry',{captureId:p.captureId})));
    assert.ok(retries.some(x=>x.status===200));
    assert.deepEqual(grams(await r.items()),[350,480]);assert.equal((await r.get('/api/state')).body.pendingCaptures.length,0);
  }finally{await r.clean();}
});
test('20 the database failing before the write (not only the insert) keeps the weighing as pending',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    const get=r.db.ctx.config.getConfig;let fail=true;r.db.ctx.config.getConfig=async function(...a){if(fail)throw Error('Banco indisponível');return get.apply(this,a);};
    await r.connect();await r.sim.place(480);await until(()=>!r.scale.snapshot().armed);await r.sim.remove();await r.server.settle(2000);
    fail=false;const st=(await r.get('/api/state')).body;assert.equal(st.pendingCaptures.length,1);assert.equal(st.cart.length,0);
    assert.equal((await r.post('/api/scale/pending/retry',{captureId:st.pendingCaptures[0].captureId})).status,200);
    assert.deepEqual(grams(await r.items()),[480]);
  }finally{await r.clean();}
});
test('21 typed by hand while the scale was down: when it comes back with the cup still there, it is not charged again',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    await r.connect();const saleId=await r.db.activeSaleId();
    r.sim.unplug();await r.sim.place(480);
    assert.equal((await r.post('/api/cart/manual-weight',{saleId,weight:'0,480'})).status,200);
    r.sim.plug();await until(()=>r.scale.snapshot().mode==='serial'&&r.scale.snapshot().grams===480,2000);await wait(150);
    assert.equal((await r.items()).length,1);assert.equal(r.scale.snapshot().ready,false);
    await r.sim.remove();await armed(r);await r.sim.place(350);assert.deepEqual(grams(await r.waitItems(2)),[480,350]);
    // A refused typing holds nothing.
    await r.db.updateConfig({autoCapture:false});await r.sim.remove();await armed(r);await r.sim.place(200);await until(()=>r.scale.snapshot().ready);
    assert.equal((await r.post('/api/cart/manual-weight',{saleId,weight:'abc'})).status,400);assert.equal(r.scale.snapshot().armed,true);
    // Typed with the plate empty: the next cup is weighed normally.
    await r.sim.remove();await until(()=>r.scale.snapshot().grams===0);await r.post('/api/cart/manual-value',{saleId,amount:'5,00'});assert.equal(r.scale.snapshot().armed,true);
  }finally{await r.clean();}
});
test('22 charging while a weighing is being written: the charge waits, sees the new total and is refused',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    const saleId=await r.db.activeSaleId();await r.db.addManualValue(saleId,'10,00');const {revision}=await r.db.getDraftSale(saleId);
    r.slowDatabase(400);await r.connect();await r.sim.place(480);await until(()=>!r.scale.snapshot().armed);
    const refused=await r.post('/api/checkout',{saleId,revision,method:'pix',uuid:'00000000-0000-4000-8000-000000000022'});
    assert.equal(refused.status,400);assert.match(refused.body.error,/mudou/);
    const sale=await r.db.getDraftSale(saleId);assert.equal(sale.items.length,2);
    const paid=await r.post('/api/checkout',{saleId,revision:sale.revision,method:'pix',uuid:'00000000-0000-4000-8000-000000000023'});
    assert.equal(paid.status,200);assert.equal(paid.body.result.sale.total_cents,sale.totalCents);
  }finally{await r.clean();}
});
test('22 a sale closed behind the weighing: it becomes pending, never goes to another customer',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    const saleId=await r.db.activeSaleId();
    const sales=r.db.ctx.sales,add=sales.addWeighed;sales.addWeighed=async function(...a){await sales.discardDraftSale(saleId);return add.apply(this,a);};
    await r.connect();await r.sim.place(480);await until(async()=>(await r.get('/api/state')).body.pendingCaptures.length===1);
    const st=(await r.get('/api/state')).body;assert.equal(st.cart.length,0);assert.equal(st.pendingCaptures[0].saleId,saleId);assert.match(st.pendingCaptures[0].error,/descartada/);
  }finally{await r.clean();}
});
test('23 locking and changing the operator while a weighing is written does not lose or move it',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    const saleId=await r.db.activeSaleId();r.slowDatabase(400);await r.connect();await r.sim.place(480);await until(()=>!r.scale.snapshot().armed);
    await r.sim.remove();await armed(r);
    assert.equal((await r.post('/api/auth/lock')).status,200);await r.pos.signIn('Bia');
    await until(async()=>(await r.items(saleId)).length===1);await wait(100);assert.equal((await r.items(saleId)).length,1);
  }finally{await r.clean();}
});
test('24 without permission, locked or with the till closed nothing is captured; the cup waits and goes in once',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    const limited=await r.pos.signIn('Bia',['screen.vendas']);
    await r.connect();await r.sim.place(480);await wait(200);
    assert.equal((await r.items()).length,0);assert.equal(r.scale.snapshot().ready,true);
    assert.ok(logged(r).some(e=>e.type==='captura_bloqueada'&&/permissão/.test(e.motivo)));
    // The light read needs a session and carries no cash or sales; the diagnostic needs scale.manage.
    assert.equal((await r.get('/api/scale/state',null)).status,401);
    const light=await r.get('/api/scale/state',limited.cookie);assert.equal(light.status,200);
    assert.deepEqual(Object.keys(light.body).sort(),['canSwitch','lastAutoError','liveKey','scale']);
    assert.equal((await r.get('/api/scale/diagnostics',limited.cookie)).status,403);
    const ana=await r.pos.signIn('Ana');assert.deepEqual(grams(await r.waitItems(1)),[480]);
    const diag=await r.get('/api/scale/diagnostics',ana.cookie);assert.equal(diag.status,200);
    assert.ok(diag.body.events.length>0);assert.equal(diag.body.captures.write.count,1);
    assert.doesNotMatch(JSON.stringify(diag.body),/Ana|Bia|cookie|token|pin/i);
    // Locked, then the till closed.
    await r.sim.remove();await armed(r);await r.post('/api/auth/lock',{},ana.cookie);await r.sim.place(350);await wait(150);assert.equal((await r.items()).length,1);
    await r.pos.signIn('Ana');await r.waitItems(2);
  }finally{await r.clean();}
});
test('26 the screen learns about a new weighing from the light read (liveKey), which asks the database nothing new',async()=>{
  const r=await scaleRig({options:FAST,http:true});try{
    await r.connect();const before=(await r.get('/api/state')).body;
    assert.equal((await r.get('/api/scale/state')).body.liveKey,before.liveKey);
    let sales=0;r.db.adapter.onQuery=sql=>{if(/draft_sale|FROM sales|shifts|products/.test(sql))sales++;};
    for(let i=0;i<5;i++)await r.get('/api/scale/state');
    assert.equal(sales,0);r.db.adapter.onQuery=null;
    await r.sim.place(480);await r.waitItems(1);await r.server.settle();
    assert.notEqual((await r.get('/api/scale/state')).body.liveKey,before.liveKey);
  }finally{await r.clean();}
});
test('driver: taking a cycle that already ended changes nothing for the cup now on the plate',()=>{
  const s=new ScaleDriver();s.mode='demo';
  feed(s,400,400);const first=s.peek();feed(s,0,500,500);const second=s.peek();
  assert.notEqual(first.captureId,second.captureId);
  assert.equal(s.consume(first.captureId),false);assert.equal(s.peek().captureId,second.captureId);
  assert.equal(s.consume(second.captureId),true);assert.equal(s.peek(),null);assert.equal(s.consume(second.captureId),false);
});
test('technical log: rotates by size and keeps a fixed number of files; settings are limited',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-log-'));
  try{
    const log=scaleLog(dir,{maxBytes:1000,files:3});
    for(let i=0;i<200;i++){log.write({type:'leitura',i,pad:'x'.repeat(50)});log.flush();}
    assert.deepEqual(fs.readdirSync(dir).sort(),['balanca.1.log','balanca.2.log','balanca.log']);
    assert.ok(fs.statSync(path.join(dir,'balanca.log')).size<=1000);
    const config=env=>loadConfig({PDV_HOME:dir,...env}).scale;
    assert.deepEqual(config({}),{pollMs:undefined,stableReadings:undefined,emptyReadings:undefined,log:false});
    assert.deepEqual(config({PDV_SCALE_POLL_MS:'200',PDV_SCALE_STABLE_READINGS:'3',PDV_SCALE_EMPTY_READINGS:'2',PDV_SCALE_LOG:'true'}),{pollMs:200,stableReadings:3,emptyReadings:2,log:true});
    assert.equal(config({PDV_SCALE_POLL_MS:'10',PDV_SCALE_STABLE_READINGS:'1'}).pollMs,undefined);
    const s=new ScaleDriver(config({}));assert.deepEqual([s.pollMs,s.options.stableReadings,s.options.emptyReadings],[150,2,1]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
