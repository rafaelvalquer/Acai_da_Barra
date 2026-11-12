'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {ScaleDriver}=require('../src/scale');const {createServer}=require('../src/server');const {tempStore,until,wait}=require('./helpers');const {posAuth}=require('./pos-helpers');
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
// Items of the sale the scale is weighing for.
const cart=async r=>{const id=await r.db.activeSaleId();return id?(await r.db.getDraftSale(id)).items:[];};
async function rig({open=true}={}){
 const box=await tempStore('luminor-scale-');const db=box.s;
 const op=(await db.saveEmployee({name:'Ana'})).id;if(open)await db.openShift('0',op);
 const pos=await posAuth(db);const me=await pos.signIn('Ana');
 const scale=new ScaleDriver({SerialPort:FakePort,pollMs:10});createServer({db,scale,auth:pos.auth});
 await scale.connect('COM9',2400);const port=FakePort.last;
 await until(()=>scale.snapshot().status==='stable');
 return {db,scale,port,op,pos,me,async clean(){scale.disconnect();await pos.close();return box.clean();}};
}

test('the scale sends a stable weight and it is added to the sale automatically, once',async()=>{
 const r=await rig();try{
  assert.equal(r.port.options.path,'COM9');assert.equal(r.port.options.baudRate,2400);
  r.port.reading='00840';
  await until(async()=>(await cart(r)).length===1);
  assert.equal((await cart(r))[0].grams,840);assert.equal((await cart(r))[0].totalCents,5452);assert.equal((await cart(r))[0].manual,false);assert.ok((await cart(r))[0].captureId);
  // The plate stays on the scale: many more identical frames must not add the cup again.
  const polls=r.port.enq;await until(()=>r.port.enq>=polls+15);
  assert.equal((await cart(r)).length,1);assert.equal(r.scale.snapshot().ready,false);
  // Removing the plate (zero readings) rearms the next weighing.
  r.port.reading='00000';await until(()=>r.scale.snapshot().armed);
  r.port.reading='00420';
  await until(async()=>(await cart(r)).length===2);
  assert.equal((await cart(r))[1].grams,420);
  await wait(80);assert.equal((await cart(r)).length,2);
 }finally{await r.clean();}
});
test('unstable, negative and overload readings never become an item',async()=>{
 const r=await rig();try{
  for(const reading of ['IIIII','NNNNN','SSSSS','99999']){
   r.port.reading=reading;const polls=r.port.enq;await until(()=>r.port.enq>=polls+8);
   assert.equal((await cart(r)).length,0,reading);assert.equal(r.scale.snapshot().ready,false,reading);
  }
  // Oscillating weights are not stable enough either (frames fed directly, without timer jitter).
  r.port.reading=null;await wait(30);
  for(let i=0;i<12;i++)r.scale.sample({status:'stable',grams:i%2?500:510});
  assert.equal((await cart(r)).length,0);assert.equal(r.scale.snapshot().ready,false);
  r.port.reading='00500';await until(async()=>(await cart(r)).length===1);
 }finally{await r.clean();}
});
test('frames split across serial reads are still captured',async()=>{
 const r=await rig();try{
  r.port.reading=[Buffer.from([0x02,0x30,0x30]),Buffer.from([0x33]),Buffer.from([0x30,0x30,0x03])];
  await until(async()=>(await cart(r)).length===1);assert.equal((await cart(r))[0].grams,300);
 }finally{await r.clean();}
});
test('with the shift closed or auto-capture off the weight waits on the scale',async()=>{
 const r=await rig({open:false});try{
  r.port.reading='00840';await until(()=>r.scale.snapshot().ready);
  await wait(60);assert.equal((await cart(r)).length,0);assert.equal(r.scale.snapshot().ready,true);
  await r.db.updateConfig({autoCapture:false});await r.db.openShift('0',r.op);
  await wait(60);assert.equal((await cart(r)).length,0);assert.equal(r.scale.snapshot().ready,true);
  // The operator can still add it by hand, exactly once.
  await r.db.addWeighed(await r.db.activeSaleId(),r.scale.consume());assert.equal(r.scale.consume(),null);assert.equal((await cart(r)).length,1);
 }finally{await r.clean();}
});
test('a lost serial connection goes offline and stops capturing',async()=>{
 const r=await rig();try{
  r.port.emit('close');
  const s=r.scale.snapshot();assert.equal(s.mode,'offline');assert.equal(s.status,'offline');assert.equal(s.lastError,'Porta serial fechada');
  r.port.reading='00840';await wait(60);assert.equal((await cart(r)).length,0);
  // Manual entry is the fallback while the scale is down.
  await r.db.addManualWeight(await r.db.activeSaleId(),'0,840');assert.equal((await cart(r))[0].totalCents,5452);
 }finally{await r.clean();}
});
test('serial settings are validated before opening the port',async()=>{
 const scale=new ScaleDriver({SerialPort:FakePort,pollMs:10});
 await assert.rejects(scale.connect('COM9',300),/Velocidade/);
 await assert.rejects(scale.connect('COM9; rm',2400),/Porta serial/);
 assert.deepEqual((await scale.ports()).map(p=>p.path),['COM9']);
});
