'use strict';
// Shared by the split payment tests: a store with the shift open and open sales of a known total.
const {randomUUID}=require('node:crypto');
const {tempStore}=require('./helpers');
// The shift opens with R$ 100,00 in the drawer; the store is the one the till uses, without the HTTP server.
async function till({opening='100,00'}={}){
  const box=await tempStore('luminor-split-');const s=box.s;
  const ana=(await s.saveEmployee({name:'Ana'})).id;await s.openShift(opening,ana);
  return {box,s,ana,async clean(){await box.clean();}};
}
// The sale on the till gets typed values (each at most R$ 1.000,00) and its id comes back with its revision.
async function draftOf(s,...values){
  const id=await s.activeSaleId();for(const v of values)await s.addManualValue(id,v);
  const d=await s.getDraftSale(id);return {id,revision:d.revision,total:d.totalCents};
}
const part=(method,amount,received)=>({method,amount,...(received!==undefined?{received}:{})});
const uid=()=>randomUUID();
// Pays the open sale in parts and returns the checkout answer.
const pay=(s,d,payments,{uuid=uid(),revision=d.revision}={})=>s.checkoutDraftSale(d.id,null,uuid,undefined,revision,payments);
const rows=(s,sql,params=[])=>s.adapter.all(sql,params);
const partsOf=async(s,saleId)=>(await rows(s,'SELECT method,amount_cents,received_cents,change_cents FROM sale_payments WHERE sale_id=? ORDER BY id',[saleId])).map(r=>({method:r.method,amount_cents:Number(r.amount_cents),received_cents:r.received_cents===null?null:Number(r.received_cents),change_cents:r.change_cents===null?null:Number(r.change_cents)}));
// The rows that must always hold: every finished sale is paid exactly, every part belongs to a sale.
async function integrity(s){
  const bad=await rows(s,"SELECT s.id FROM sales s WHERE s.status='done' AND s.total_cents<>COALESCE((SELECT SUM(p.amount_cents) FROM sale_payments p WHERE p.sale_id=s.id),-1)");
  const orphan=await rows(s,'SELECT p.id FROM sale_payments p WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id=p.sale_id)');
  const method=await rows(s,"SELECT p.id FROM sale_payments p WHERE p.method NOT IN ('cash','pix','credit','debit')");
  const noParts=await rows(s,'SELECT s.id FROM sales s WHERE NOT EXISTS (SELECT 1 FROM sale_payments p WHERE p.sale_id=s.id)');
  return {sumMismatch:bad.map(r=>r.id),orphans:orphan.map(r=>r.id),badMethod:method.map(r=>r.id),withoutParts:noParts.map(r=>r.id)};
}
const clean={sumMismatch:[],orphans:[],badMethod:[],withoutParts:[]};
module.exports={till,draftOf,part,uid,pay,rows,partsOf,integrity,clean};
