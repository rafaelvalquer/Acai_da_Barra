'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {Store}=require('../src/db');const {ScaleDriver}=require('../src/scale');const {createServer}=require('../src/server');
const frame=payload=>Buffer.from([0x02,...Buffer.from(payload,'ascii'),0x03]);
// Fake Toledo port: answers every ENQ with the current reading, the way the Prix 3 Fit does in Prt5.
class FakePort extends EventEmitter{
 constructor(options){super();this.options=options;this.isOpen=false;this.enq=0;this.reading='00000';FakePort.last=this;}
 open(cb){this.isOpen=true;cb();}
 close(cb){this.isOpen=false;if(cb)cb();}
 write(bytes,cb){
  if(bytes[0]===0x05&&this.isOpen){this.enq++;const r=this.reading;
   // An array simulates the bytes of one frame arriving split across serial reads.
   if(r!==null)setImmediate(()=>{for(const chunk of Array.isArray(r)?r:[frame(r)])this.emit('data',chunk);});}
  if(cb)cb();
 }
 static list(){return Promise.resolve([{path:'COM9',manufacturer:'Fake'}]);}
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=2000){const start=Date.now();while(!check()){if(Date.now()-start>ms)throw Error('Tempo esgotado aguardando a balança');await wait(5);}}
// Items of the sale the scale is weighing for.
const cart=r=>{const id=r.db.activeSaleId();return id?r.db.getDraftSale(id).items:[];};
async function rig({open=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-scale-'));const db=new Store(path.join(dir,'scale.sqlite'));
 const op=db.saveEmployee({name:'Ana'}).id;if(open)db.openShift('0',op);
 const scale=new ScaleDriver({SerialPort:FakePort,pollMs:10});createServer({db,scale});
 await scale.connect('COM9',2400);const port=FakePort.last;
 await until(()=>scale.snapshot().status==='stable');
 return {db,scale,port,op,clean(){scale.disconnect();db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}

test('the scale sends a stable weight and it is added to the sale automatically, once',async()=>{
 const r=await rig();try{
  assert.equal(r.port.options.path,'COM9');assert.equal(r.port.options.baudRate,2400);
  r.port.reading='00840';
  await until(()=>cart(r).length===1);
  assert.equal(cart(r)[0].grams,840);assert.equal(cart(r)[0].totalCents,5452);assert.equal(cart(r)[0].manual,false);assert.ok(cart(r)[0].captureId);
  // The plate stays on the scale: many more identical frames must not add the cup again.
  const polls=r.port.enq;await until(()=>r.port.enq>=polls+15);
  assert.equal(cart(r).length,1);assert.equal(r.scale.snapshot().ready,false);
  // Removing the plate (zero readings) rearms the next weighing.
  r.port.reading='00000';await until(()=>r.scale.snapshot().armed);
  r.port.reading='00420';
  await until(()=>cart(r).length===2);
  assert.equal(cart(r)[1].grams,420);
  await wait(80);assert.equal(cart(r).length,2);
 }finally{r.clean();}
});
test('unstable, negative and overload readings never become an item',async()=>{
 const r=await rig();try{
  for(const reading of ['IIIII','NNNNN','SSSSS','99999']){
   r.port.reading=reading;const polls=r.port.enq;await until(()=>r.port.enq>=polls+8);
   assert.equal(cart(r).length,0,reading);assert.equal(r.scale.snapshot().ready,false,reading);
  }
  // Oscillating weights are not stable enough either (frames fed directly, without timer jitter).
  r.port.reading=null;await wait(30);
  for(let i=0;i<12;i++)r.scale.sample({status:'stable',grams:i%2?500:510});
  assert.equal(cart(r).length,0);assert.equal(r.scale.snapshot().ready,false);
  r.port.reading='00500';await until(()=>cart(r).length===1);
 }finally{r.clean();}
});
test('frames split across serial reads are still captured',async()=>{
 const r=await rig();try{
  r.port.reading=[Buffer.from([0x02,0x30,0x30]),Buffer.from([0x33]),Buffer.from([0x30,0x30,0x03])];
  await until(()=>cart(r).length===1);assert.equal(cart(r)[0].grams,300);
 }finally{r.clean();}
});
test('with the shift closed or auto-capture off the weight waits on the scale',async()=>{
 const r=await rig({open:false});try{
  r.port.reading='00840';await until(()=>r.scale.snapshot().ready);
  await wait(60);assert.equal(cart(r).length,0);assert.equal(r.scale.snapshot().ready,true);
  r.db.updateConfig({autoCapture:false});r.db.openShift('0',r.op);
  await wait(60);assert.equal(cart(r).length,0);assert.equal(r.scale.snapshot().ready,true);
  // The operator can still add it by hand, exactly once.
  r.db.addWeighed(r.db.activeSaleId(),r.scale.consume());assert.equal(r.scale.consume(),null);assert.equal(cart(r).length,1);
 }finally{r.clean();}
});
test('a lost serial connection goes offline and stops capturing',async()=>{
 const r=await rig();try{
  r.port.emit('close');
  const s=r.scale.snapshot();assert.equal(s.mode,'offline');assert.equal(s.status,'offline');assert.equal(s.lastError,'Porta serial fechada');
  r.port.reading='00840';await wait(60);assert.equal(cart(r).length,0);
  // Manual entry is the fallback while the scale is down.
  r.db.addManualWeight(r.db.activeSaleId(),'0,840');assert.equal(cart(r)[0].totalCents,5452);
 }finally{r.clean();}
});
test('serial settings are validated before opening the port',async()=>{
 const scale=new ScaleDriver({SerialPort:FakePort,pollMs:10});
 await assert.rejects(scale.connect('COM9',300),/Velocidade/);
 await assert.rejects(scale.connect('COM9; rm',2400),/Porta serial/);
 assert.deepEqual((await scale.ports()).map(p=>p.path),['COM9']);
});
