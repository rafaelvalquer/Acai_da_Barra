'use strict';
// The rules of a payment in parts (src/services/PaymentService.js), on their own: no database. PD01–PD14 of the plan.
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../src/services/PaymentService');
const part=(method,amount,received)=>({method,amount,...(received!==undefined?{received}:{})});
const fails=(fn,re)=>assert.throws(fn,e=>re.test(e.message),String(re));

test('PD01 one part for the whole total is valid for each of the four methods',()=>{
  for(const m of ['cash','pix','credit','debit']){
    const r=P.normalize([part(m,'25,00')],2500);assert.deepEqual(r,[{method:m,amountCents:2500,receivedCents:null,changeCents:null}]);assert.equal(P.saleMethod(r),m);
  }
});
test('PD02 two, three and four parts that add up to the total are valid and come in the fixed order',()=>{
  const two=P.normalize([part('pix','10,00'),part('cash','15,00')],2500);assert.deepEqual(two.map(x=>x.method),['cash','pix']);assert.equal(P.saleMethod(two),'mixed');
  const three=P.normalize([part('debit','5,00'),part('pix','10,00'),part('cash','10,00')],2500);assert.deepEqual(three.map(x=>x.amountCents),[1000,1000,500]);
  const four=P.normalize([part('debit','5,00'),part('credit','5,00'),part('pix','5,00'),part('cash','5,00')],2000);assert.deepEqual(four.map(x=>x.method),['cash','pix','credit','debit']);
});
test('PD03 a sum below the total is refused and says how much is missing',()=>{
  fails(()=>P.normalize([part('cash','10,00'),part('pix','14,99')],2500),/menor que o total.*Faltam R\$ 0,01/);
});
test('PD04 a sum above the total is refused and says how much is over',()=>{
  fails(()=>P.normalize([part('cash','10,00'),part('pix','15,01')],2500),/maior que o total.*Passa R\$ 0,01/);
});
test('PD05 negative, zero, missing and malformed amounts are refused',()=>{
  fails(()=>P.normalize([part('cash','-5,00'),part('pix','30,00')],2500),/negativo/);
  fails(()=>P.normalize([part('cash',-5),part('pix',30)],2500),/negativo/);
  fails(()=>P.normalize([part('cash','0,00'),part('pix','25,00')],2500),/maior que zero/);
  fails(()=>P.normalize([part('cash',''),part('pix','25,00')],2500),/Informe o valor de Dinheiro/);
  fails(()=>P.normalize([{method:'cash'}],2500),/Informe o valor/);
  for(const bad of ['abc','1,234','12,5,0',{},[],true])fails(()=>P.normalize([part('cash',bad)],2500),/inválido/);
});
test('PD06 a method twice, an unknown method and more than four parts are refused',()=>{
  fails(()=>P.normalize([part('cash','10,00'),part('cash','15,00')],2500),/mais de uma vez/);
  fails(()=>P.normalize([part('voucher','25,00')],2500),/Forma de pagamento inválida/);
  fails(()=>P.normalize([{amount:'25,00'}],2500),/Forma de pagamento inválida/);
  fails(()=>P.normalize([part('cash','5,00'),part('pix','5,00'),part('credit','5,00'),part('debit','5,00'),part('pix','5,00')],2500),/no máximo 4/);
});
test('PD07 no parts, a list that is not a list, and parts that are not objects are refused',()=>{
  fails(()=>P.normalize([],2500),/pelo menos uma/);fails(()=>P.normalize(null,2500),/Informe as formas/);fails(()=>P.normalize({method:'cash'},2500),/Informe as formas/);
  fails(()=>P.normalize(['cash'],2500),/Forma de pagamento inválida/);fails(()=>P.normalize([null],2500),/Forma de pagamento inválida/);
});
test('PD08 cash received is checked against the cash part, never against the whole sale',()=>{
  // R$ 40,00 sale: R$ 10,00 in cash and R$ 30,00 in Pix. R$ 10,00 handed over is enough.
  const ok=P.normalize([part('cash','10,00','10,00'),part('pix','30,00')],4000);assert.equal(ok[0].changeCents,0);
  fails(()=>P.normalize([part('cash','10,00','9,99'),part('pix','30,00')],4000),/recebido em dinheiro menor/);
});
test('PD09 the change is the amount received minus the cash part',()=>{
  const r=P.normalize([part('cash','10,00','50,00'),part('pix','30,00')],4000);assert.deepEqual([r[0].receivedCents,r[0].changeCents],[5000,4000]);
  assert.deepEqual(P.cashColumns(r),{receivedCents:5000,changeCents:4000});
  const none=P.normalize([part('cash','10,00'),part('pix','30,00')],4000);assert.deepEqual(P.cashColumns(none),{receivedCents:null,changeCents:null});
  assert.deepEqual(P.cashColumns(P.normalize([part('pix','40,00')],4000)),{receivedCents:null,changeCents:null});
});
test('PD10 an amount received on a method other than cash is refused',()=>{
  fails(()=>P.normalize([part('cash','10,00'),part('pix','30,00','30,00')],4000),/só vale para dinheiro/);
});
test('PD11 amounts are whole cents with no rounding: 0,1 + 0,2 style sums are exact',()=>{
  const r=P.normalize([part('cash','0,10'),part('pix','0,20')],30);assert.equal(r.reduce((s,x)=>s+x.amountCents,0),30);
  const n=P.normalize([part('cash',0.1),part('pix',0.2)],30);assert.equal(n.reduce((s,x)=>s+x.amountCents,0),30);
  fails(()=>P.normalize([part('cash',0.1+0.2),part('pix','1,00')],130),/inválido/);
});
test('PD12 the contract of before (one method, optional amount received) is one part for the whole total',()=>{
  assert.deepEqual(P.single('pix',undefined,1500),[{method:'pix',amountCents:1500,receivedCents:null,changeCents:null}]);
  assert.deepEqual(P.single('cash','20,00',1500),[{method:'cash',amountCents:1500,receivedCents:2000,changeCents:500}]);
  assert.deepEqual(P.single('credit','20,00',1500)[0].receivedCents,null);
  fails(()=>P.single('cash','10,00',1500),/menor que o total/);fails(()=>P.single('x',undefined,1500),/inválida/);
});
test('PD13 the stored rows become the standard view, in the fixed order of the methods',()=>{
  const v=P.viewAll([{id:2,method:'pix',amount_cents:3000,received_cents:null,change_cents:null},{id:1,method:'cash',amount_cents:1000,received_cents:5000,change_cents:4000}]);
  assert.deepEqual(v.map(x=>[x.method,x.label,x.amountCents,x.receivedCents,x.changeCents]),[['cash','Dinheiro',1000,5000,4000],['pix','Pix',3000,null,null]]);
});
test('PD14 a signature tells a repeated payment from a different one',()=>{
  const a=P.normalize([part('cash','10,00'),part('pix','30,00')],4000),b=P.normalize([part('pix','30,00'),part('cash','10,00')],4000),c=P.normalize([part('cash','11,00'),part('pix','29,00')],4000);
  assert.equal(P.signature(a),P.signature(b));assert.notEqual(P.signature(a),P.signature(c));
});
