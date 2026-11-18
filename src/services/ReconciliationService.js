'use strict';
const {readMoney}=require('../protocol');const {assert,now}=require('./util');
// The full count of the shift's close: the person types what they counted of each payment method, the system keeps
// what it had for each (a snapshot taken inside the same transaction that closes the shift) and the difference.
//   cash   expected = opening + cash sales + supplies - withdrawals; counted = everything in the drawer, opening included
//   pix, credit, debit   expected = the shift's finished sales of that method; counted is typed (nothing is checked
//                        against a bank or a card company)
//   difference = counted - expected (negative: missing, positive: extra, zero: matched), always in whole cents
// Each close is a revision. A correction by the administrator adds the next revision and the earlier ones stay as
// they were. Nothing here decides who may see what: src/auth/CashVisibilityPolicy.js and src/server.js do, before
// anything of this leaves the server.
const METHODS=['cash','pix','credit','debit'];
const LABELS={cash:'Dinheiro',pix:'Pix',credit:'Crédito',debit:'Débito'};
const KEY=/^[A-Za-z0-9_-]{8,80}$/;
const MIN_REASON=5,MAX_REASON=300;
const err=(status,message,expose)=>Object.assign(Error(message),{status,...(expose?{expose}:{})});
const statusOf=d=>d<0?'FALTA':d>0?'SOBRA':'CONFERIDO';
const sum=a=>a.reduce((s,x)=>s+x,0);
// What leaves the service for a revision: every amount in cents, items in the fixed order of METHODS.
function view(h,items,{shift=null,supersededBy=null}={}){
  const by=new Map(items.map(i=>[i.method,i]));
  const rows=METHODS.filter(m=>by.has(m)).map(m=>{const i=by.get(m);return {method:m,label:LABELS[m],countedCents:i.counted_cents,expectedCents:i.expected_cents,differenceCents:i.difference_cents,status:statusOf(i.difference_cents)};});
  return {id:h.id,uuid:h.uuid,shiftId:h.shift_id,revision:h.revision,status:h.status,isCurrent:!!h.is_current,superseded:!h.is_current,supersededByRevision:supersededBy,
    confirmedAt:h.confirmed_at,confirmedBy:{name:h.confirmed_by_name,kind:h.confirmed_by_kind,employeeId:h.confirmed_by_employee_id},correctedFromId:h.corrected_from_id,
    reopen:h.reopened_at?{at:h.reopened_at,by:h.reopened_by,reason:h.reopen_reason}:null,correctionReason:h.correction_reason||null,correctedBy:h.corrected_by||null,
    closedByEmployeeId:shift?.closed_by??null,openedAt:shift?.opened_at||null,closedAt:shift?.closed_at||null,openedByName:shift?.opened_by_name||null,
    items:rows,totals:{countedCents:h.total_counted_cents,expectedCents:h.total_expected_cents,differenceCents:h.total_difference_cents,status:statusOf(h.total_difference_cents),
      revenueCents:h.revenue_cents,salesCount:h.sales_count,canceledCount:h.canceled_count},
    cash:{openingCents:h.opening_cents,cashSalesCents:h.cash_sales_cents,suppliesCents:h.supplies_cents,withdrawalsCents:h.withdrawals_cents,expectedCents:items.find(i=>i.method==='cash')?.expected_cents??null}};
}
class ReconciliationService {
  constructor(ctx){this.ctx=ctx;}
  // The four typed amounts as whole cents. All four are required (zero is a valid count); a missing field is an
  // error, never a zero. Whatever the browser sends beyond them is ignored.
  validateCountedAmounts(counted){
    assert(counted&&typeof counted==='object'&&!Array.isArray(counted),'Informe os valores conferidos de dinheiro, Pix, crédito e débito.');
    const out={};
    for(const m of METHODS){
      const v=counted[m];const name=LABELS[m].toLowerCase();
      if(v===undefined||v===null||(typeof v==='string'&&!v.trim()))throw err(400,`Informe o valor conferido de ${name}. Se não houve, digite 0,00.`,{field:m});
      if(typeof v!=='string'&&typeof v!=='number')throw err(400,`Valor de ${name} inválido.`,{field:m});
      if(typeof v==='number'&&(!Number.isFinite(v)||v<0))throw err(400,`Valor de ${name} inválido.`,{field:m});
      if(typeof v==='string'&&/^\s*-/.test(v))throw err(400,`O valor de ${name} não pode ser negativo.`,{field:m});
      try{out[m]=readMoney(v);}catch(_){throw err(400,`Valor de ${name} inválido. Use o formato 350,00.`,{field:m});}
      assert(Number.isSafeInteger(out[m])&&out[m]>=0&&out[m]<=99999999,`Valor de ${name} fora do limite.`);
    }
    return out;
  }
  // The checks that come before the count: the right shift, open, no sale waiting. It reveals nothing of the totals.
  async beginClose({shiftId}={}){
    const s=await this.ctx.cash.shift();await this.assertShift(s,shiftId);await this.assertNoPending();
    return {shiftId:s.id,ready:true,fields:METHODS.map(m=>({method:m,label:LABELS[m]}))};
  }
  async assertShift(s,shiftId){
    const given=shiftId!==undefined&&shiftId!==null&&shiftId!==''?Number(shiftId):null;
    if(given!==null&&(!Number.isSafeInteger(given)||!s||given!==s.id))throw err(409,'Este caixa já foi fechado.',{closed:true});
    assert(s,'Não há caixa aberto');
  }
  async assertNoPending(){
    const pending=(await this.ctx.sales.listDraftSales()).filter(d=>d.item_count>0);
    assert(!pending.length,pending.length===1?`Existe 1 venda em aberto (${pending[0].label}). Finalize ou descarte essa venda para fechar o caixa.`:`Existem ${pending.length} vendas em aberto. Finalize ou descarte essas vendas para fechar o caixa.`);
  }
  async actorRow(r){
    const {ctx}=this;const a=ctx.actor;
    if(a&&a.kind==='admin')return {employeeId:null,uuid:null,name:a.name,kind:'admin'};
    const id=await ctx.employees.operatorId(r);assert(id,ctx.actor?'Entre com o seu PIN para usar o caixa':'Selecione o operador do caixa');
    const e=await r.employees.find(id);assert(e,'Funcionário não encontrado');
    return {employeeId:e.id,uuid:e.uuid,name:e.name,kind:'operador'};
  }
  // The close. shiftId (optional): the shift the person counted; a second close of the same shift is answered with
  // the first one (same idempotencyKey) or refused (another key), never applied to the next shift.
  // legacyCash: the one-value close of before (src/services/CashService.js): the other methods are taken as matched.
  async confirmClose({shiftId,idempotencyKey,counted,legacyCash=null}={}){
    const {ctx}=this;
    assert(typeof idempotencyKey==='string'&&KEY.test(idempotencyKey),'Identificador da requisição inválido. Recarregue a página e tente de novo.');
    const typed=legacyCash===null?this.validateCountedAmounts(counted):null;
    const legacyCents=legacyCash===null?null:readMoney(legacyCash);
    const given=shiftId!==undefined&&shiftId!==null&&shiftId!==''?Number(shiftId):null;
    const prior=await ctx.r.reconciliations.byKey(idempotencyKey);
    if(prior){
      if(given!==null&&prior.shift_id!==given)throw err(409,'Este identificador já foi usado em outro fechamento.');
      const actor=ctx.actor;
      if(actor&&actor.kind!=='admin'&&prior.confirmed_by_employee_id!==actor.employeeId)throw err(403,'Este fechamento foi feito por outra pessoa.');
      return {duplicate:true,reconciliation:await this.load(prior)};
    }
    const s=await ctx.cash.shift();await this.assertShift(s,shiftId);await this.assertNoPending();
    const at=now();let saved;
    await ctx.tx(async t=>{
      // Everything below is one transaction: the shift is closed only if the count is saved with it.
      const open=await t.cash.openShift();if(!open||open.id!==s.id)throw err(409,'Este caixa já foi fechado.',{closed:true});
      const who=await this.actorRow(t);const totals=await ctx.cash.shiftTotals(s.id,t);
      const expected={cash:s.opening_cents+totals.methods.cash+totals.suppliesCents-totals.withdrawalsCents,pix:totals.methods.pix,credit:totals.methods.credit,debit:totals.methods.debit};
      const countedNow=typed||{cash:legacyCents,pix:expected.pix,credit:expected.credit,debit:expected.debit};
      await t.openSales.discardOpenOfShift(s.id,at);
      const totalCounted=sum(METHODS.map(m=>countedNow[m])),totalExpected=sum(METHODS.map(m=>expected[m]));
      const id=await t.reconciliations.insert({shiftId:s.id,revision:1,status:'CONFIRMED',isCurrent:true,idempotencyKey,createdAt:at,confirmedAt:at,confirmedByEmployeeId:who.employeeId,confirmedByUuid:who.uuid,
        confirmedByName:who.name,confirmedByKind:who.kind,openingCents:s.opening_cents,cashSalesCents:totals.methods.cash,suppliesCents:totals.suppliesCents,withdrawalsCents:totals.withdrawalsCents,
        revenueCents:totals.totalCents,salesCount:totals.salesCount,canceledCount:totals.canceledCount,totalCountedCents:totalCounted,totalExpectedCents:totalExpected,totalDifferenceCents:totalCounted-totalExpected});
      for(const m of METHODS)await t.reconciliations.insertItem(id,{method:m,countedCents:countedNow[m],expectedCents:expected[m]});
      // The shift's own columns keep the cash figures, as before (reports and older screens read them).
      await t.cash.close(s.id,{closedAt:at,countedCents:countedNow.cash,expectedCents:expected.cash,closedBy:who.employeeId});
      saved={id,legacy:{status:statusOf(countedNow.cash-expected.cash),openingCents:s.opening_cents,expectedCents:expected.cash,countedCents:countedNow.cash,differenceCents:countedNow.cash-expected.cash,methods:totals.methods,
        totalCents:totals.totalCents,salesCount:totals.salesCount,canceledCount:totals.canceledCount,suppliesCents:totals.suppliesCents,withdrawalsCents:totals.withdrawalsCents}};
    });
    return {duplicate:false,reconciliation:await this.load(await ctx.r.reconciliations.byId(saved.id)),legacy:saved.legacy};
  }
  async load(h,r=this.ctx.r){
    const [items,shift,newer]=await Promise.all([r.reconciliations.items(h.id),r.reconciliations.shift(h.shift_id),h.is_current?null:r.reconciliations.revision(h.shift_id,h.revision+1)]);
    return view(h,items,{shift,supersededBy:newer?newer.revision:null});
  }
  // The revision a person asks for (the current one by default), as saved. Never from anything but the database.
  async getConfirmedReport({shiftId,revision=null}={}){
    const r=this.ctx.r;const id=Number(shiftId);assert(Number.isSafeInteger(id)&&id>0,'Turno inválido');
    const shift=await r.reconciliations.shift(id);if(!shift)throw err(404,'Fechamento não encontrado.');
    if(!shift.closed_at)throw err(409,'O caixa deste turno ainda está aberto.',{open:true});
    const h=revision?await r.reconciliations.revision(id,Number(revision)):await r.reconciliations.current(id);
    if(!h)throw err(404,'Este turno foi fechado antes da conferência por forma de pagamento: não há relatório de conferência.');
    if(h.status==='OPEN')throw err(409,'O fechamento ainda não foi confirmado.');
    return this.load(h);
  }
  // employeeId: only what that person closed (null: every close).
  async listClosings({employeeId=null,limit=60}={}){
    const r=this.ctx.r;const rows=await r.reconciliations.list({employeeId,limit});
    const out=rows.map(h=>({shiftId:h.shift_id,revision:h.revision,status:h.status,openedAt:h.opened_at,closedAt:h.closed_at,openedByName:h.opened_by_name,confirmedBy:h.confirmed_by_name,confirmedAt:h.confirmed_at,
      employeeId:h.confirmed_by_employee_id,reopened:h.status==='REOPENED',legacy:false,
      totals:{countedCents:h.total_counted_cents,expectedCents:h.total_expected_cents,differenceCents:h.total_difference_cents,status:statusOf(h.total_difference_cents),revenueCents:h.revenue_cents}}));
    if(employeeId===null)for(const s of await r.reconciliations.legacyList(limit))out.push({shiftId:s.id,revision:0,status:'LEGACY',openedAt:s.opened_at,closedAt:s.closed_at,openedByName:s.opened_by_name,confirmedBy:s.closed_by_name,confirmedAt:s.closed_at,
      employeeId:s.closed_by,reopened:false,legacy:true,totals:{countedCents:s.counted_cents,expectedCents:s.expected_cents,differenceCents:s.difference_cents,status:s.difference_cents===null?null:statusOf(s.difference_cents),revenueCents:null}});
    return out.sort((a,b)=>b.shiftId-a.shiftId);
  }
  // Every revision of a shift, oldest first, with who did what and why.
  async getRevisions({shiftId}={}){
    const r=this.ctx.r;const id=Number(shiftId);assert(Number.isSafeInteger(id)&&id>0,'Turno inválido');
    const heads=await r.reconciliations.revisions(id);if(!heads.length)throw err(404,'Este turno não tem conferência por forma de pagamento.');
    const shift=await r.reconciliations.shift(id);const out=[];
    for(const h of heads){const next=heads.find(x=>x.revision===h.revision+1);out.push(view(h,await r.reconciliations.items(h.id),{shift,supersededBy:next?next.revision:null}));}
    return {shiftId:id,revisions:out};
  }
  // Administrator: opens the confirmed count for correction (the shift stays closed, its sales are not touched).
  async requestReopen({shiftId,reason}={}){
    const {ctx}=this;const a=ctx.actor;assert(a&&a.kind==='admin','Somente o administrador pode reabrir uma conferência.');
    const why=String(reason||'').trim();assert(why.length>=MIN_REASON,`Informe a justificativa (pelo menos ${MIN_REASON} caracteres).`);assert(why.length<=MAX_REASON,'Justificativa muito longa.');
    const id=Number(shiftId);assert(Number.isSafeInteger(id)&&id>0,'Turno inválido');
    let revision;
    await ctx.tx(async t=>{
      const cur=await t.reconciliations.current(id);if(!cur)throw err(404,'Este turno não tem conferência por forma de pagamento.');
      if(cur.status==='REOPENED')throw err(409,'Esta conferência já está reaberta para correção.');
      const n=await t.reconciliations.reopen(cur.id,{at:now(),by:a.name,reason:why});if(!n)throw err(409,'Esta conferência não pode ser reaberta agora.');revision=cur.revision;
    });
    return {shiftId:id,revision,reconciliation:await this.load(await ctx.r.reconciliations.current(id))};
  }
  // Administrator: the corrected count becomes the next revision. The system's expected values stay those of the
  // close (same base); the difference is recomputed from what is now informed. The earlier revision is kept.
  async confirmCorrection({shiftId,idempotencyKey,counted,reason}={}){
    const {ctx}=this;const a=ctx.actor;assert(a&&a.kind==='admin','Somente o administrador pode corrigir uma conferência.');
    assert(typeof idempotencyKey==='string'&&KEY.test(idempotencyKey),'Identificador da requisição inválido. Recarregue a página e tente de novo.');
    const why=String(reason||'').trim();assert(why.length>=MIN_REASON,`Informe a justificativa da correção (pelo menos ${MIN_REASON} caracteres).`);assert(why.length<=MAX_REASON,'Justificativa muito longa.');
    const typed=this.validateCountedAmounts(counted);const id=Number(shiftId);assert(Number.isSafeInteger(id)&&id>0,'Turno inválido');
    const prior=await ctx.r.reconciliations.byKey(idempotencyKey);
    if(prior){if(prior.shift_id!==id)throw err(409,'Este identificador já foi usado em outro fechamento.');return {duplicate:true,reconciliation:await this.load(prior)};}
    let newId,before;const at=now();
    await ctx.tx(async t=>{
      const cur=await t.reconciliations.current(id);if(!cur)throw err(404,'Este turno não tem conferência por forma de pagamento.');
      if(cur.status!=='REOPENED')throw err(409,'Reabra a conferência antes de corrigir.');
      const items=await t.reconciliations.items(cur.id);before=Object.fromEntries(items.map(i=>[i.method,i.counted_cents]));
      const expected=Object.fromEntries(items.map(i=>[i.method,i.expected_cents]));
      const totalCounted=sum(METHODS.map(m=>typed[m])),totalExpected=cur.total_expected_cents;
      await t.reconciliations.setCurrent(cur.id,false);
      newId=await t.reconciliations.insert({shiftId:id,revision:cur.revision+1,status:'CONFIRMED',isCurrent:true,idempotencyKey,createdAt:at,confirmedAt:at,confirmedByEmployeeId:null,confirmedByUuid:null,confirmedByName:a.name,confirmedByKind:'admin',
        correctedFromId:cur.id,correctionReason:why,correctedBy:a.name,openingCents:cur.opening_cents,cashSalesCents:cur.cash_sales_cents,suppliesCents:cur.supplies_cents,withdrawalsCents:cur.withdrawals_cents,
        revenueCents:cur.revenue_cents,salesCount:cur.sales_count,canceledCount:cur.canceled_count,totalCountedCents:totalCounted,totalExpectedCents:totalExpected,totalDifferenceCents:totalCounted-totalExpected});
      for(const m of METHODS)await t.reconciliations.insertItem(newId,{method:m,countedCents:typed[m],expectedCents:expected[m]});
    });
    return {duplicate:false,previousCounted:before,reconciliation:await this.load(await ctx.r.reconciliations.byId(newId))};
  }
}
module.exports={ReconciliationService,METHODS,LABELS,statusOf};
