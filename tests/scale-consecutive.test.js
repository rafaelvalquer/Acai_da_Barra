'use strict';
// The complaint from the store: the second weighing is slow, or never shows up. These run the driver with its
// production timing (no pollMs override) against a plate that changes on its own clock. On version 42cbdde (ENQ every
// 500 ms, three equal readings, two empty readings, cycle consumed after the database) all of them fail.
const test=require('node:test'),assert=require('node:assert/strict');
const {scaleRig}=require('./scale-rig');const {wait}=require('./helpers');

test('a quick cup change (450 ms empty) still registers the second weighing',async()=>{
  const r=await scaleRig();try{
    await r.connect();await r.sim.place(480);await r.waitItems(1);
    await wait(100);await r.sim.remove();await wait(450);await r.sim.place(480);
    const items=await r.waitItems(2,3000);
    assert.deepEqual(items.map(i=>i.grams),[480,480]);assert.notEqual(items[0].captureId,items[1].captureId);
    await wait(500);assert.equal((await r.items()).length,2,'never twice');
  }finally{await r.clean();}
});
test('the cup changed while the first weighing is still being written: both are registered, once each',async()=>{
  const r=await scaleRig();try{
    r.slowDatabase(2000);await r.connect();await r.sim.place(480);
    await wait(1700);   // the first one is on its way to the database
    await r.sim.remove();await wait(1200);await r.sim.place(350);
    const items=await r.waitItems(2,8000);
    assert.deepEqual(items.map(i=>i.grams),[480,350]);
    await wait(2500);assert.equal((await r.items()).length,2);
  }finally{await r.clean();}
});
test('from the first stable reading to the item stored takes at most 500 ms',async()=>{
  const r=await scaleRig();try{
    await r.connect();
    for(let n=1;n<=3;n++){
      const stableAt=await r.sim.place(300+n,200);await r.waitItems(n);
      const ms=Date.now()-stableAt;assert.ok(ms<=500,`weighing ${n} took ${ms} ms`);
      await r.sim.remove();await wait(700);
    }
  }finally{await r.clean();}
});
