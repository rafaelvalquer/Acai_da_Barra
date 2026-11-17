'use strict';
// The 80 mm closing report: layout, widths, accents (PC860), signs, banners (F34, F35).
const test=require('node:test'),assert=require('node:assert/strict');
const {closingLines,testLines,toBytes,encodeText,wrap}=require('../src/printing/ThermalReceiptBuilder');
const report=(o={})=>({uuid:'u-1',shiftId:12,revision:1,status:'CONFIRMED',superseded:false,confirmedAt:'2026-11-17T15:00:00.000Z',openedAt:'2026-11-17T09:00:00.000Z',closedAt:'2026-11-17T15:00:00.000Z',
  confirmedBy:{name:'Maria Conceição da Silva Albuquerque de Oliveira'},
  items:[['cash','Dinheiro',24000,25000],['pix','Pix',3000,3000],['credit','Crédito',2000,1500],['debit','Débito',0,0]].map(([method,label,c,e])=>({method,label,countedCents:c,expectedCents:e,differenceCents:c-e})),
  totals:{countedCents:29000,expectedCents:29500,differenceCents:-500,revenueCents:10000,salesCount:3,canceledCount:1},
  cash:{openingCents:20000,cashSalesCents:5000,suppliesCents:0,withdrawalsCents:0,expectedCents:25000},...o});
test('F34 every line fits the configured width, for 32 to 64 columns, even with long names and notes',()=>{
  for(const width of [32,42,48,64]){
    const lines=closingLines(report({correctionReason:'Motivo muito longo '.repeat(8),revision:2}),{width,storeName:'Açaí da Barra Unidade Centro Muito Grande Mesmo',unit:'Loja do Centro Histórico',header:'Cabeçalho',footer:'Obrigado'});
    for(const l of lines)assert.ok([...l].length<=width,`${width}: "${l}"`);
  }
});
test('F34 the report shows counted, system and difference per method, the signed difference and the non-fiscal notice',()=>{
  const text=closingLines(report(),{width:48}).join('\n');
  for(const w of ['FECHAMENTO DE CAIXA','DINHEIRO','PIX','CREDITO','DEBITO','TOTAL INFORMADO','TOTAL SISTEMA','DIFERENCA TOTAL','NAO FISCAL','FALTA','240,00','250,00'])assert.ok(text.includes(w),w);
  assert.ok(text.includes("-R$ 10,00"));
  assert.ok(!/2a VIA|SUBSTITUIDA/.test(text));
});
test('F35 reprint, corrected and superseded banners; text is encoded in PC860 with the page selected',()=>{
  const copy=closingLines(report(),{width:48,reprint:{by:'Ana',at:'2026-11-17T16:00:00.000Z'}}).join('\n');assert.match(copy,/2a VIA/);assert.match(copy,/Ana/);
  const fixed=closingLines(report({revision:2}),{width:48}).join('\n');assert.match(fixed,/FECHAMENTO CORRIGIDO/);assert.match(fixed,/SUBSTITUI A REVISAO 1/);
  assert.match(closingLines(report({superseded:true,supersededByRevision:2}),{width:48}).join('\n'),/SUBSTITUIDA PELA REVISAO 2/);
  const bytes=toBytes(['Açaí Crédito'],{mode:'escpos'});assert.deepEqual([...bytes.subarray(0,5)],[0x1b,0x40,0x1b,0x74,0x03]);
  const enc=encodeText('çãé');assert.ok(enc.every(b=>b>0x7f),'acentos fora do ASCII');assert.ok(!bytes.includes(0x1d),'sem corte por padrão');
  assert.ok(toBytes(['x'],{mode:'escpos',cut:true}).includes(0x1d));
  const plain=toBytes(['Açaí'],{mode:'text'});assert.ok([...plain].every(b=>b<0x80),'modo texto só ASCII');
});
test('wrapping never breaks a line over the width and the test page fits',()=>{
  for(const l of wrap('palavra'.repeat(20)+' fim',40))assert.ok([...l].length<=40);
  for(const l of testLines({width:48,printer:'ELGIN i9'}))assert.ok([...l].length<=48);
});
