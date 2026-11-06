'use strict';
// The till screen asks for the state almost every second. It is read from the database only after something was
// written; in between it costs no query (on a cloud database every query crosses the internet). These tests check
// that the kept state is never stale: any write, through the PDV or straight into the database, is seen at once.
const test=require('node:test'),assert=require('node:assert/strict');
const {tempStore,sql}=require('./helpers');
const scaleAt=grams=>({snapshot:()=>({status:'demo',grams})});
async function shop(){
  const box=await tempStore('luminor-estado-');const s=box.s;
  await s.openShift('100,00',(await s.saveEmployee({name:'Ana'})).id);
  let queries=0;s.adapter.onQuery=()=>{queries++;};
  return {box,s,queries:()=>{const n=queries;queries=0;return n;}};
}
test('sem nada novo no banco, a atualização da tela não faz nenhuma consulta',async()=>{
  const {box,s,queries}=await shop();
  try{
    const first=await s.getState(scaleAt(0));assert.ok(queries()>0,'a primeira leitura vai ao banco');
    for(let i=0;i<5;i++){const again=await s.getState(scaleAt(0));assert.deepEqual(again,first);}
    assert.equal(queries(),0,'cinco atualizações seguidas sem nenhuma consulta');
  }finally{await box.clean();}
});
test('qualquer gravação pelo PDV aparece na atualização seguinte',async()=>{
  const {box,s,queries}=await shop();
  try{
    const id=(await s.getState(scaleAt(0))).activeSaleId;
    // Inserts that return the new id (INSERT … RETURNING) outside a transaction.
    await s.saveEmployee({name:'Bia'});
    let st=await s.getState(scaleAt(0));assert.deepEqual(st.employees.map(e=>e.name),['Ana','Bia']);
    await s.product({name:'Água',price:'4,00',stock:10});
    st=await s.getState(scaleAt(0));assert.equal(st.products.find(p=>p.name==='Água')?.available,10);
    await s.addManualValue(id,'12,50');
    st=await s.getState(scaleAt(0));assert.equal(st.cartTotalCents,1250);assert.equal(st.cart.length,1);
    const b=(await s.createDraftSale()).id;st=await s.getState(scaleAt(0));
    assert.equal(st.activeSaleId,b);assert.equal(st.openSales.length,2);
    await s.selectDraftSale(id);await s.checkoutDraftSale(id,'cash','00000000-0000-4000-8000-0000000000aa','20,00',(await s.getDraftSale(id)).revision);
    st=await s.getState(scaleAt(0));
    assert.equal(st.cash.methods.cash,1250);assert.equal(st.cash.expectedCents,11250);assert.equal(st.openSales.some(o=>o.id===id),false);
    await s.updateConfig({priceKg:'70,00',autoCapture:false});
    st=await s.getState(scaleAt(0));assert.equal(st.config.priceKgCents,7000);assert.equal(st.config.autoCapture,false);
    queries();await s.getState(scaleAt(0));assert.equal(queries(),0);
  }finally{await box.clean();}
});
test('uma alteração feita direto no banco (fora das telas) também aparece',async()=>{
  const {box,s}=await shop();
  try{
    await s.getState(scaleAt(0));
    await sql(s,"UPDATE settings SET v='5555' WHERE k='price_kg_cents'");
    assert.equal((await s.getState(scaleAt(0))).config.priceKgCents,5555);
  }finally{await box.clean();}
});
test('uma operação recusada não deixa a tela com dados velhos',async()=>{
  const {box,s}=await shop();
  try{
    const id=(await s.getState(scaleAt(0))).activeSaleId;await s.addManualValue(id,'30,00');
    await assert.rejects(s.checkoutDraftSale(id,'cash','00000000-0000-4000-8000-0000000000bb','10,00',(await s.getDraftSale(id)).revision),/menor/);
    const st=await s.getState(scaleAt(0));assert.equal(st.cartTotalCents,3000);assert.equal(st.cash.salesCount,0);
  }finally{await box.clean();}
});
test('o peso da balança vem sempre da leitura do momento, nunca da memória',async()=>{
  const {box,s,queries}=await shop();
  try{
    await s.getState(scaleAt(0));queries();
    assert.equal((await s.getState(scaleAt(486))).scale.grams,486);
    assert.equal((await s.getState(scaleAt(0))).scale.grams,0);
    assert.equal(queries(),0);
  }finally{await box.clean();}
});
