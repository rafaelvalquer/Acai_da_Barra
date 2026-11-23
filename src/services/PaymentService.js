'use strict';
const {readMoney}=require('../protocol');const {assert}=require('./util');
// How one sale is paid: one to four parts, at most one per payment method, every amount in whole cents. The parts
// must add up to exactly the total the server calculated (never a total sent by the browser). Only cash may have an
// amount received, and its change is that amount minus the cash part, never minus the whole sale.
// Nothing here touches the database: SaleService validates with this, stores the parts and reads them back.
const METHODS=['cash','pix','credit','debit'];
const LABELS={cash:'Dinheiro',pix:'Pix',credit:'Crédito',debit:'Débito'};
const MAX_PARTS=METHODS.length;
const MIXED='mixed';
const reais=c=>`R$ ${Math.floor(Math.abs(c)/100).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${String(Math.abs(c)%100).padStart(2,'0')}`;
const blank=v=>v===undefined||v===null||(typeof v==='string'&&!v.trim());
// A typed amount ("12,50", "12.50" or the number 12.5) as whole cents. A negative value is its own message.
function toCents(v,what){
  if((typeof v==='string'&&/^\s*(R\$\s*)?-/.test(v))||(typeof v==='number'&&v<0))throw Error(`${what} não pode ser negativo`);
  if(typeof v!=='string'&&typeof v!=='number')throw Error(`${what} inválido`);
  let c;try{c=readMoney(v);}catch(_){throw Error(`${what} inválido. Use o formato 12,50`);}
  assert(Number.isSafeInteger(c),`${what} inválido`);return c;
}
// The parts as the sale will keep them: [{method,amountCents,receivedCents,changeCents}], in the fixed order of METHODS.
function normalize(payments,totalCents){
  assert(Array.isArray(payments),'Informe as formas de pagamento da venda');
  assert(payments.length>=1,'Informe pelo menos uma forma de pagamento');
  assert(payments.length<=MAX_PARTS,`Use no máximo ${MAX_PARTS} formas de pagamento por venda`);
  assert(Number.isSafeInteger(totalCents)&&totalCents>0,'Venda com total inválido');
  const seen=new Set(),parts=[];
  for(const p of payments){
    assert(p&&typeof p==='object'&&!Array.isArray(p),'Forma de pagamento inválida');
    assert(METHODS.includes(p.method),'Forma de pagamento inválida');
    assert(!seen.has(p.method),`A forma de pagamento ${LABELS[p.method]} foi informada mais de uma vez`);seen.add(p.method);
    const name=LABELS[p.method];
    assert(!blank(p.amount),`Informe o valor de ${name}`);
    const amountCents=toCents(p.amount,`Valor de ${name}`);
    assert(amountCents>0,`O valor de ${name} deve ser maior que zero`);
    let receivedCents=null,changeCents=null;
    if(p.method==='cash'){
      if(!blank(p.received)){
        receivedCents=toCents(p.received,'Valor recebido em dinheiro');
        assert(receivedCents>=amountCents,'Valor recebido em dinheiro menor que o valor da parcela em dinheiro');changeCents=receivedCents-amountCents;
      }
    }else assert(blank(p.received),`Valor recebido só vale para dinheiro (${name})`);
    parts.push({method:p.method,amountCents,receivedCents,changeCents});
  }
  const sum=parts.reduce((s,x)=>s+x.amountCents,0);
  assert(sum>=totalCents,`A soma das formas de pagamento (${reais(sum)}) é menor que o total da venda (${reais(totalCents)}). Faltam ${reais(totalCents-sum)}.`);
  assert(sum<=totalCents,`A soma das formas de pagamento (${reais(sum)}) é maior que o total da venda (${reais(totalCents)}). Passa ${reais(sum-totalCents)}.`);
  return parts.sort((a,b)=>METHODS.indexOf(a.method)-METHODS.indexOf(b.method));
}
// The contract of before (one method, optional amount received) as one part for the whole sale.
function single(method,received,totalCents){
  assert(METHODS.includes(method),'Forma de pagamento inválida');
  let receivedCents=null;
  if(method==='cash'&&!blank(received)){receivedCents=readMoney(received);assert(receivedCents>=totalCents,'Valor recebido menor que o total da venda');}
  return [{method,amountCents:totalCents,receivedCents,changeCents:receivedCents===null?null:receivedCents-totalCents}];
}
// What the sale's own "method" column holds: the method of a single part, or "mixed".
const saleMethod=parts=>parts.length===1?parts[0].method:MIXED;
// Amount received and change of the cash part, kept on the sale as well (the history and old screens read them there).
function cashColumns(parts){const c=parts.find(x=>x.method==='cash');return {receivedCents:c?c.receivedCents:null,changeCents:c?c.changeCents:null};}
// One stored row as the services and the API send it.
const view=r=>({id:r.id,method:r.method,label:LABELS[r.method]||r.method,amountCents:r.amount_cents,receivedCents:r.received_cents??null,changeCents:r.change_cents??null});
const sortRows=rows=>[...rows].sort((a,b)=>METHODS.indexOf(a.method)-METHODS.indexOf(b.method));
const viewAll=rows=>sortRows(rows).map(view);
// Same parts as a comparable string (to tell a repeated request from a different one).
const signature=parts=>parts.map(p=>`${p.method}:${p.amountCents}:${p.receivedCents??''}`).join('|');
module.exports={METHODS,LABELS,MAX_PARTS,MIXED,normalize,single,saleMethod,cashColumns,view,viewAll,signature,toCents,reais};
