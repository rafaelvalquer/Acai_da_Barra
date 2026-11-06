'use strict';
const {readMoney}=require('../protocol');const {assert,now,emptyMethods}=require('./util');
// Shift opening, cash supplies and withdrawals, the expected drawer amount and the closing count.
class CashService {
  constructor(ctx){this.ctx=ctx;}
  async shift(r=this.ctx.r){return (await r.cash.openShift())||null;}
  async openShift(opening,operatorId){
    const {ctx}=this;assert(!(await this.shift()),'Já existe um caixa aberto');const cents=readMoney(opening);
    const op=operatorId!==undefined&&operatorId!==null&&operatorId!==''?await ctx.employees.setOperator(operatorId):await ctx.employees.requireOperator();
    // The shift starts with one open sale, so the first weighing already has a destination.
    await ctx.tx(async t=>{await t.cash.insertShift({openedAt:now(),openingCents:cents,openedBy:op.id});await ctx.sales.insertDraft(t,await t.cash.openShift());});
    return this.shift();
  }
  async moveCash(kind,amount,note=''){
    const {ctx}=this;const shift=await this.shift();assert(shift,'Abra o caixa antes de realizar movimentações');const op=await ctx.employees.requireOperator();
    assert(['supply','withdrawal'].includes(kind),'Movimentação inválida');
    const cents=readMoney(amount);assert(cents>0,'Valor deve ser positivo');
    if(kind==='withdrawal')assert(cents<=(await this.cashSummary()).expectedCents,'Sangria maior que o dinheiro em caixa');
    await ctx.r.cash.insertEvent({shiftId:shift.id,kind,amountCents:cents,note:String(note).slice(0,180),createdAt:now(),operatorId:op.id});
    return this.cashSummary();
  }
  async shiftTotals(shiftId,r=this.ctx.r){
    const methods=emptyMethods();let salesCount=0,canceledCount=0;
    for(const x of await r.cash.salesByMethod(shiftId)){if(x.status==='done'){methods[x.method]+=x.amount;salesCount+=x.n;}else canceledCount+=x.n;}
    return {methods,totalCents:Object.values(methods).reduce((a,b)=>a+b,0),salesCount,canceledCount,suppliesCents:await r.cash.moved(shiftId,'supply'),withdrawalsCents:await r.cash.moved(shiftId,'withdrawal')};
  }
  async cashSummary(){
    const r=this.ctx.r;const shift=await this.shift();if(!shift)return {shift:null,expectedCents:0,events:[],methods:emptyMethods()};
    const t=await this.shiftTotals(shift.id);const events=await r.cash.events(shift.id);
    const opener=shift.opened_by?await r.employees.findName(shift.opened_by):null;
    return {shift:{...shift,opened_by_name:opener?.name||null},expectedCents:shift.opening_cents+t.methods.cash+t.suppliesCents-t.withdrawalsCents,cashSalesCents:t.methods.cash,...t,events};
  }
  async closeShift(counted){
    const {ctx}=this;const s=await this.cashSummary();assert(s.shift,'Não há caixa aberto');
    const pending=(await ctx.sales.listDraftSales()).filter(d=>d.item_count>0);
    assert(!pending.length,pending.length===1?`Existe 1 venda em aberto (${pending[0].label}). Finalize ou descarte essa venda para fechar o caixa.`:`Existem ${pending.length} vendas em aberto. Finalize ou descarte essas vendas para fechar o caixa.`);
    const c=readMoney(counted);const closedBy=await ctx.employees.operatorId();
    await ctx.tx(async t=>{
      // Sales left without items are just empty tabs: they close with the shift.
      const at=now();await t.openSales.discardOpenOfShift(s.shift.id,at);
      await t.cash.close(s.shift.id,{closedAt:at,countedCents:c,expectedCents:s.expectedCents,closedBy});
    });
    return {shiftId:s.shift.id,openingCents:s.shift.opening_cents,expectedCents:s.expectedCents,countedCents:c,differenceCents:c-s.expectedCents,methods:s.methods,totalCents:s.totalCents,salesCount:s.salesCount,canceledCount:s.canceledCount,suppliesCents:s.suppliesCents,withdrawalsCents:s.withdrawalsCents};
  }
}
module.exports={CashService};
