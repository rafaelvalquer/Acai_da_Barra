'use strict';
// What each person sees of the money, decided on the server before anything is sent (hiding it in the browser would
// not hide it: the answer would still carry it). Without "cash.view_expected" the close is blind: no expected
// balance, no opening amount, no sales per payment method, no totals that add up to the balance, and the close
// answers only Conferido, Falta or Sobra. The calculations stay in src/services/CashService.js:
//   Esperado = Abertura + Vendas em dinheiro + Suprimentos − Sangrias      Diferença = Contado − Esperado
// Every function returns a new object; the state the store keeps between requests is never changed.
const {hasPermission}=require('./AuthorizationService');
const can=(identity,p)=>hasPermission(identity,p);
const seesExpected=identity=>can(identity,'cash.view_expected');
const seesMovements=identity=>can(identity,'cash.view_history')||can(identity,'cash.move');
// The cash panel of the open shift (store.cashSummary()).
function cash(summary,identity){
  if(!summary)return summary;
  const events=seesMovements(identity)?summary.events||[]:[];
  if(seesExpected(identity))return {...summary,events,blind:false};
  const s=summary.shift;
  return {shift:s?{id:s.id,opened_at:s.opened_at,opened_by:s.opened_by,opened_by_name:s.opened_by_name,active_draft_id:s.active_draft_id}:null,
    blind:true,salesCount:summary.salesCount||0,canceledCount:summary.canceledCount||0,events};
}
// The answer to closing the shift (store.closeShift()).
function closeResult(r,identity){
  if(!seesExpected(identity))return {shiftId:r.shiftId,status:r.status,blind:true};
  return {shiftId:r.shiftId,expectedCents:r.expectedCents,countedCents:r.countedCents,differenceCents:r.differenceCents,status:r.status,blind:false,
    openingCents:r.openingCents,methods:r.methods,totalCents:r.totalCents,salesCount:r.salesCount,canceledCount:r.canceledCount,suppliesCents:r.suppliesCents,withdrawalsCents:r.withdrawalsCents};
}
// After a withdrawal or a supply: the cash panel again, as this person may see it.
const moveResult=cash;
// Reports (store.report()): the closings only with "cash.view_history", and their expected and difference only with
// "cash.view_expected"; without it, no totals per payment method and no list of sales either (the cash ones would
// add up to the drawer balance of the open shift).
function report(rep,identity){
  const expected=seesExpected(identity);
  const shifts=can(identity,'cash.view_history')?(rep.shifts||[]).map(s=>expected?{...s}:withoutBalance(s)):[];
  if(expected)return {...rep,shifts,blind:false};
  const {methods,sales,...rest}=rep;
  return {...rest,shifts,blind:true};
}
// A closing without its amounts: only whether the count matched.
function withoutBalance(s){
  const {expected_cents,difference_cents,opening_cents,counted_cents,...rest}=s;
  const d=difference_cents===null||difference_cents===undefined?null:Number(difference_cents);
  return {...rest,status:s.closed_at&&d!==null?(d<0?'FALTA':d>0?'SOBRA':'CONFERIDO'):null,blind:true};
}
module.exports={cash,closeResult,moveResult,report,seesExpected,seesMovements};
