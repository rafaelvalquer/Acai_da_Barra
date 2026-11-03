'use strict';
// Toledo Prix 3 Fit, protocolo Prt5 conforme manual 01-25 Rev.14, seção 5.3.4.
const ENQ = Buffer.from([0x05]);
const STX = 0x02;
const ETX = 0x03;

function decodePrt5(str, maxGrams = 15000) {
  if (str === 'IIIII') return {status:'unstable',grams:null};
  if (str === 'NNNNN') return {status:'negative',grams:null};
  if (str === 'SSSSS') return {status:'overload',grams:null};
  if (!/^\d{5}$/.test(str)) return {status:'invalid',grams:null};
  const grams = Number(str);
  if (grams > maxGrams) return {status:'invalid',grams:null};
  return {status:'stable',grams};
}
class Prt5Parser {
  constructor(onFrame, maxGrams=15000) {
    this.onFrame = onFrame; this.maxGrams = maxGrams;
    this.buf = []; this.open = false;
  }
  push(bytes) {
    for (const b of bytes) {
      if (b === STX) {this.open = true; this.buf = [];} 
      else if (b === ETX && this.open) {
        this.open = false;
        this.onFrame(decodePrt5(Buffer.from(this.buf).toString('ascii'), this.maxGrams));
        this.buf = [];
      } else if (this.open) {
        if (this.buf.length < 16) this.buf.push(b);
        else {this.open = false; this.buf = [];}
      }
    }
  }
}
function readMoney(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0 || input > 999999) throw Error('Valor inválido');
    input=String(input);
  }
  if (typeof input !== 'string') throw Error('Valor monetário inválido');
  const match = input.trim().replace(/^R\$\s*/, '').match(/^(\d{1,6})(?:[.,](\d{1,2}))?$/);
  if (!match) throw Error('Use valor como 64,90');
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2,'0'));
}
// Peso digitado em kg ("0,450", "1.2" ou "0,450 kg"), devolvido em gramas inteiros.
function readWeight(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw Error('Peso inválido');
    input = String(input);
  }
  if (typeof input !== 'string') throw Error('Peso inválido');
  const match = input.trim().replace(/\s*kg$/i, '').match(/^(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) throw Error('Use peso como 0,450');
  const grams = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3,'0'));
  if (grams < 1 || grams > 15000) throw Error('Peso deve estar entre 0,001 e 15,000 kg');
  return grams;
}
function calcTotal(grams, priceCents) {
  if (!Number.isInteger(grams) || grams < 0 || grams > 15000) throw Error('Peso inválido');
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > 99999999) throw Error('Preço inválido');
  return Math.round((grams * priceCents) / 1000);
}
module.exports={ENQ,Prt5Parser,decodePrt5,readMoney,readWeight,calcTotal};
