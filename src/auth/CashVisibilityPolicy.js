'use strict';
// What each person sees of the money, decided on the server before anything is sent (hiding it in the browser would
// not hide it: the answer would still carry it). Without "cash.view_expected" the close is blind: no expected
// balance, no opening amount, no sales per payment method, no totals that add up to the balance, and the close
// answers only Conferido, Falta or Sobra. The calculations stay in src/services/CashService.js:
//   Esperado = Abertura + Vendas em dinheiro + Suprimentos − Sangrias      Diferença = Contado − Esperado
// Every function returns a new object; the state the store keeps between requests is never changed.
const {hasPermission}=require('./AuthorizationService');
const can=(identity,p)=>hasPermission(identity,p);
// strict (the default, setting "strict_blind"): an employee never sees the open shift's totals, whatever "cash.view_expected"
// they were given before the full count existed. Only the administrator does, and the employee who closed sees
// the figures of that close afterwards (the confirmed report, src/server.js). Turned off, the permission works as before.
const seesExpected=(identity,{strict=true}={})=>can(identity,'cash.view_expected')&&(!strict||identity.kind==='admin');
// Sangria e suprimento são livres para quem está no caixa; a lista do turno mostra quem fez cada um.
const seesMovements=()=>true;
// The cash panel of the open shift (store.cashSummary()).
function cash(summary,identity,opts){
  if(!summary)return summary;
  const events=seesMovements(identity)?summary.events||[]:[];
  if(seesExpected(identity,opts))return {...summary,events,blind:false};
  const s=summary.shift;
  return {shift:s?{id:s.id,opened_at:s.opened_at,opened_by:s.opened_by,opened_by_name:s.opened_by_name,active_draft_id:s.active_draft_id}:null,
    blind:true,salesCount:summary.salesCount||0,canceledCount:summary.canceledCount||0,events};
}
// The answer to closing the shift (store.closeShift()).
function closeResult(r,identity,opts){
  if(!seesExpected(identity,opts))return {shiftId:r.shiftId,status:r.status,blind:true};
  return {shiftId:r.shiftId,expectedCents:r.expectedCents,countedCents:r.countedCents,differenceCents:r.differenceCents,status:r.status,blind:false,
    openingCents:r.openingCents,methods:r.methods,totalCents:r.totalCents,salesCount:r.salesCount,canceledCount:r.canceledCount,suppliesCents:r.suppliesCents,withdrawalsCents:r.withdrawalsCents};
}
// After a withdrawal or a supply: the cash panel again, as this person may see it.
const moveResult=cash;
// Reports (store.report()): the closings only with "cash.view_history", and their expected and difference only with
// "cash.view_expected"; without it, no totals per payment method and no list of sales either (the cash ones would
// add up to the drawer balance of the open shift).
function report(rep,identity,opts){
  const expected=seesExpected(identity,opts);
  const history=can(identity,'cash.view_history');
  const shifts=history?(rep.shifts||[]).map(s=>expected?{...s}:withoutBalance(s)):[];
  // The history of withdrawals and supplies goes with the cash history permission, like the closings.
  const {movements,movementTotals,...base}=rep;
  const moves=history?{movements:movements||[],movementTotals:movementTotals||null}:{movements:[]};
  if(expected)return {...base,...moves,shifts,blind:false};
  const {methods,sales,...rest}=base;
  return {...rest,...moves,shifts,blind:true};
}
// The sales of the open shift for someone who may not see its totals: each sale as it is, but not how it was paid
// (adding them up by method would give the drawer balance and the Pix and card totals).
function salesOfShift(sale,identity,opts){
  if(seesExpected(identity,opts)||!sale)return sale;
  const strip=s=>({...s,method:null,received_cents:null,change_cents:null,...(s&&Array.isArray(s.payments)?{payments:[]}:{})});
  return Array.isArray(sale.sales)?{...sale,sales:sale.sales.map(strip)}:strip(sale);
}
// A closing without its amounts: only whether the count matched.
function withoutBalance(s){
  const {expected_cents,difference_cents,opening_cents,counted_cents,...rest}=s;
  const d=difference_cents===null||difference_cents===undefined?null:Number(difference_cents);
  return {...rest,status:s.closed_at&&d!==null?(d<0?'FALTA':d>0?'SOBRA':'CONFERIDO'):null,blind:true};
}
module.exports={cash,closeResult,moveResult,report,salesOfShift,seesExpected,seesMovements};
