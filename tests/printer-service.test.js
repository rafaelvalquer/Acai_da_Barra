'use strict';
// Print service and queue against a fake spooler: sending, failure, doubtful results, reprint, restart (F23, F24, F25, F37-F40).
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const {AdminStore}=require('../src/auth/AdminStore');const {fakePrinting}=require('./printing-helpers');
const report=(o={})=>({uuid:'rec-1',shiftId:7,revision:1,status:'CONFIRMED',superseded:false,confirmedAt:'2026-11-17T15:00:00.000Z',openedAt:'2026-11-17T09:00:00.000Z',closedAt:'2026-11-17T15:00:00.000Z',confirmedBy:{name:'Ana'},
  items:['cash','pix','credit','debit'].map(m=>({method:m,label:m,countedCents:100,expectedCents:100,differenceCents:0})),totals:{countedCents:400,expectedCents:400,differenceCents:0,revenueCents:300,salesCount:1,canceledCount:0},
  cash:{openingCents:0,cashSalesCents:100,suppliesCents:0,withdrawalsCents:0,expectedCents:100},...o});
async function setup(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prn-'));const file=path.join(dir,'admin.sqlite');const store=await AdminStore.open(file);const p=fakePrinting(store);
  await p.service.saveSettings({printerName:'ELGIN i9',type:'elgin_i9',transport:'windows-spooler'},{by:'admin'});
  return {...p,store,file,dir,close:async()=>{try{await store.close?.();}catch{}fs.rmSync(dir,{recursive:true,force:true});}};
}
test('F23 the original goes to the spooler once; the same close printed automatically again does not duplicate',async()=>{
  const p=await setup();try{
    const r=await p.service.printClosing(report(),{by:'Ana',auto:true});assert.equal(r.ok,true);assert.equal(r.status,'SUBMITTED');assert.equal(p.spooler.sent.length,1);
    const again=await p.service.printClosing(report(),{by:'Ana',auto:true});assert.equal(again.duplicate,true);assert.equal(p.spooler.sent.length,1);
    assert.equal((await p.service.jobsFor('rec-1')).length,1);
  }finally{await p.close();}
});
test('F24 F37 reprint is a marked second copy and keeps the original job',async()=>{
  const p=await setup();try{
    await p.service.printClosing(report(),{by:'Ana'});const r=await p.service.reprintClosing(report(),{by:'Bia'});assert.equal(r.ok,true);
    assert.equal(p.spooler.sent.length,2);assert.match(p.spooler.sent[1].bytes.toString('latin1'),/2a VIA/);assert.ok(!/2a VIA/.test(p.spooler.sent[0].bytes.toString('latin1')));
    const jobs=await p.service.jobsFor('rec-1');assert.deepEqual(jobs.map(j=>j.kind),['closing','reprint']);
  }finally{await p.close();}
});
test('F25 a failed print says why and can be retried',async()=>{
  const p=await setup();try{
    p.spooler.failWith={message:'Spooler parado.',code:'spooler_stopped'};
    const r=await p.service.printClosing(report(),{by:'Ana'});assert.equal(r.ok,false);assert.equal(r.status,'FAILED');assert.equal(r.ambiguous,false);assert.match(r.message,/Spooler/);
    assert.ok(p.audits.some(a=>a.action==='impressao_falhou'));
    p.spooler.failWith=null;const again=await p.service.printClosing(report(),{by:'Ana'});assert.equal(again.ok,true);assert.equal(p.spooler.sent.length,1);
  }finally{await p.close();}
});
test('F38 a doubtful result needs confirmation before another copy is printed',async()=>{
  const p=await setup();try{
    p.spooler.failWith={message:'Tempo esgotado.',code:'timeout',ambiguous:true};
    const r=await p.service.printClosing(report(),{by:'Ana'});assert.equal(r.ambiguous,true);assert.match(r.message,/papel/);
    p.spooler.failWith=null;
    await assert.rejects(p.service.printClosing(report(),{by:'Ana'}),e=>e.status===409&&e.expose.needsConfirmation);
    assert.equal(p.spooler.sent.length,0);
    const ok=await p.service.printClosing(report(),{by:'Ana',confirmDuplicate:true});assert.equal(ok.ok,true);assert.equal(p.spooler.sent.length,1);
  }finally{await p.close();}
});
test('F39 jobs left SPOOLING by a restart become doubtful failures, never printed again by themselves',async()=>{
  const p=await setup();try{
    const job=await p.service.jobs.create({kind:'closing',dedupeKey:'original:rec-9',reconciliationUuid:'rec-9',shiftId:9,revision:1,printer:'ELGIN i9',transport:'windows-spooler',requestedAt:new Date().toISOString(),requestedBy:'Ana'});
    await p.service.jobs.begin(job.uuid,{printer:'ELGIN i9',transport:'windows-spooler'});
    await p.service.start();const after=await p.service.jobs.byUuid(job.uuid);assert.equal(after.status,'FAILED');assert.equal(after.ambiguous,true);assert.equal(p.spooler.sent.length,0);
  }finally{await p.close();}
});
test('F40 two simultaneous prints of the same close reach the printer once',async()=>{
  const p=await setup();try{
    p.spooler.delayMs=30;
    await Promise.allSettled([p.service.printClosing(report(),{by:'A'}),p.service.printClosing(report(),{by:'B'})]);
    assert.equal(p.spooler.sent.length,1);
  }finally{await p.close();}
});
test('no printer chosen is refused clearly; browser mode returns text and sends nothing; unknown transport is rejected',async()=>{
  const p=await setup();try{
    await p.service.saveSettings({printerName:''},{by:'admin'});await assert.rejects(p.service.printClosing(report(),{by:'Ana'}),e=>e.status===409&&/escolhida/.test(e.message));
    await p.service.saveSettings({transport:'browser'},{by:'admin'});const r=await p.service.printClosing(report(),{by:'Ana'});assert.equal(r.mode,'browser');assert.ok(r.text.includes('FECHAMENTO'));assert.equal(p.spooler.sent.length,0);
    await assert.rejects(p.service.saveSettings({transport:'cmd /c calc'},{by:'admin'}),e=>e.status===400);
  }finally{await p.close();}
});
