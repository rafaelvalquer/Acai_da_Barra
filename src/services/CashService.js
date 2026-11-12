'use strict';
const {readMoney}=require('../protocol');const {assert,now,emptyMethods}=require('./util');
const DEFAULT_BLIND_LIMIT=20000;
// Counted minus expected, in words: what an operator without access to the balance sees of the close.
const closeStatus=d=>d<0?'FALTA':d>0?'SOBRA':'CONFERIDO';
// Shift opening, cash supplies and withdrawals, the expected drawer amount and the closing count.
class CashService {
  constructor(ctx){this.ctx=ctx;}
  async shift(r=this.ctx.r){return (await r.cash.openShift())||null;}
  async openShift(opening,operatorId){
    const {ctx}=this;assert(!(await this.shift()),'Já existe um caixa aberto');const cents=readMoney(opening);
    // Signed in at the till: the person signed in opens it, whatever id came with the request.
    const op=!ctx.actor&&operatorId!==undefined&&operatorId!==null&&operatorId!==''?await ctx.employees.setOperator(operatorId):await ctx.employees.requireOperator();
    // The shift starts with one open sale, so the first weighing already has a destination.
    await ctx.tx(async t=>{await t.cash.insertShift({openedAt:now(),openingCents:cents,openedBy:op.id});await ctx.sales.insertDraft(t,await t.cash.openShift());});
    return this.shift();
  }
  // blind: whoever does it may not see the drawer balance (src/auth/CashVisibilityPolicy.js). Then a withdrawal is
  // checked against a fixed limit set by the administrator, never against the balance: refusing "more than there is"
  // would let anyone find the balance by trying amounts.
  async moveCash(kind,amount,note='',{blind=false}={}){
    const {ctx}=this;const shift=await this.shift();assert(shift,'Abra o caixa antes de realizar movimentações');const op=await ctx.employees.requireOperator();
    assert(['supply','withdrawal'].includes(kind),'Movimentação inválida');
    const cents=readMoney(amount);assert(cents>0,'Valor deve ser positivo');
    if(kind==='withdrawal'&&blind)assert(cents<=await this.blindWithdrawalLimit(),'Sangria acima do limite permitido sem conferência. Peça ao administrador.');
    else if(kind==='withdrawal')assert(cents<=(await this.cashSummary()).expectedCents,'Sangria maior que o dinheiro em caixa');
    await ctx.r.cash.insertEvent({shiftId:shift.id,kind,amountCents:cents,note:String(note).slice(0,180),createdAt:now(),operatorId:op.id});
    return this.cashSummary();
  }
  async shiftTotals(shiftId,r=this.ctx.r){
    const methods=emptyMethods();let salesCount=0,canceledCount=0;
    // Three independent reads, sent together (one round trip instead of three on a cloud database).
    const [byMethod,suppliesCents,withdrawalsCents]=await Promise.all([r.cash.salesByMethod(shiftId),r.cash.moved(shiftId,'supply'),r.cash.moved(shiftId,'withdrawal')]);
    for(const x of byMethod){if(x.status==='done'){methods[x.method]+=x.amount;salesCount+=x.n;}else canceledCount+=x.n;}
    return {methods,totalCents:Object.values(methods).reduce((a,b)=>a+b,0),salesCount,canceledCount,suppliesCents,withdrawalsCents};
  }
  async cashSummary(){
    const r=this.ctx.r;const shift=await this.shift();if(!shift)return {shift:null,expectedCents:0,events:[],methods:emptyMethods()};
    const [t,events,opener]=await Promise.all([this.shiftTotals(shift.id),r.cash.events(shift.id),shift.opened_by?r.employees.findName(shift.opened_by):null]);
    return {shift:{...shift,opened_by_name:opener?.name||null},expectedCents:shift.opening_cents+t.methods.cash+t.suppliesCents-t.withdrawalsCents,cashSalesCents:t.methods.cash,...t,events};
  }
  // Never set (or unreadable): the default. An empty setting is not "zero".
  async blindWithdrawalLimit(r=this.ctx.r){const raw=await r.settings.get('blind_withdrawal_limit_cents');const v=raw===null||raw===undefined||String(raw).trim()===''?NaN:Number(raw);return Number.isSafeInteger(v)&&v>=0?v:DEFAULT_BLIND_LIMIT;}
  async setBlindWithdrawalLimit(amount){const cents=readMoney(amount);assert(cents>=0&&cents<=10000000,'Limite inválido');await this.ctx.r.settings.set('blind_withdrawal_limit_cents',cents);return cents;}
  // shiftId (optional): the shift the person counted. A second close of the same shift (a double click, a screen
  // left open) is refused instead of closing the next one.
  async closeShift(counted,{shiftId}={}){
    const {ctx}=this;const s=await this.cashSummary();
    if(shiftId!==undefined&&shiftId!==null&&shiftId!==''&&(!s.shift||Number(shiftId)!==s.shift.id))throw Object.assign(Error('Este caixa já foi fechado.'),{status:409,expose:{closed:true}});
    assert(s.shift,'Não há caixa aberto');
    const pending=(await ctx.sales.listDraftSales()).filter(d=>d.item_count>0);
    assert(!pending.length,pending.length===1?`Existe 1 venda em aberto (${pending[0].label}). Finalize ou descarte essa venda para fechar o caixa.`:`Existem ${pending.length} vendas em aberto. Finalize ou descarte essas vendas para fechar o caixa.`);
    const c=readMoney(counted);const closedBy=await ctx.employees.operatorId();
    await ctx.tx(async t=>{
      // Sales left without items are just empty tabs: they close with the shift.
      const at=now();await t.openSales.discardOpenOfShift(s.shift.id,at);
      await t.cash.close(s.shift.id,{closedAt:at,countedCents:c,expectedCents:s.expectedCents,closedBy});
    });
    const differenceCents=c-s.expectedCents;
    return {shiftId:s.shift.id,status:closeStatus(differenceCents),openingCents:s.shift.opening_cents,expectedCents:s.expectedCents,countedCents:c,differenceCents,methods:s.methods,totalCents:s.totalCents,salesCount:s.salesCount,canceledCount:s.canceledCount,suppliesCents:s.suppliesCents,withdrawalsCents:s.withdrawalsCents};
  }
}
module.exports={CashService,closeStatus,DEFAULT_BLIND_LIMIT};
