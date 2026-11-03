'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ENQ,decodePrt5,Prt5Parser,readMoney,calcTotal}=require('../src/protocol');
test('Prt5 0,840 kg and states',()=>{
 assert.equal(ENQ[0],5);assert.deepEqual(decodePrt5('00840'),{status:'stable',grams:840});
 assert.equal(decodePrt5('IIIII').status,'unstable');assert.equal(decodePrt5('NNNNN').status,'negative');assert.equal(decodePrt5('SSSSS').status,'overload');
 assert.equal(decodePrt5('16000').status,'invalid');assert.equal(decodePrt5('abcde').status,'invalid');
});
test('parser accepts fragmented frames and multiple frames',()=>{
 const found=[];const p=new Prt5Parser(x=>found.push(x));p.push(Buffer.from([0x00,0x02,0x30,0x30,0x38]));p.push(Buffer.from([0x34,0x30,0x03,0x02,0x49,0x49,0x49,0x49,0x49,0x03]));
 assert.deepEqual(found,[{status:'stable',grams:840},{status:'unstable',grams:null}]);
});
test('price in BRL and rounding',()=>{
 assert.equal(readMoney('64,90'),6490);assert.equal(readMoney('5'),500);assert.equal(readMoney('12.9'),1290);
 assert.equal(calcTotal(840,6490),5452);assert.equal(calcTotal(420,6490),2726);
 assert.throws(()=>readMoney('-1'));assert.throws(()=>readMoney('R$ 1,000.00'));
});
