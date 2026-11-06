'use strict';
const {randomUUID}=require('node:crypto');
const {readMoney,readWeight,calcTotal}=require('../protocol');
const {assert,integer,now,pad2,sameName}=require('./util');
// Value of a Promise.allSettled entry, or its error: reads sent together still fail in the order they are checked.
const settled=x=>{if(x.status==='rejected')throw x.reason;return x.value;};
const itemView=r=>({key:r.id,kind:r.kind,productId:r.product_id??undefined,label:r.label,grams:r.grams??undefined,quantity:r.quantity??undefined,unitCents:r.unit_cents,totalCents:r.total_cents,manual:!!r.manual,captureId:r.scale_capture_id??undefined});
// Open sales (one per customer being served, each with its own items until paid or discarded), checkout,
// cancellation and correction. Methods taking `t` run inside a transaction held by the caller.
class SaleService {
  constructor(ctx){this.ctx=ctx;}
  async draftRow(id,r=this.ctx.r){return (await r.openSales.find(id))||null;}
  async requireOpenSale(id,r=this.ctx.r){
    // Both reads go out together (one round trip on a cloud database); the checks keep their order.
    const [s,x]=await Promise.allSettled([this.ctx.cash.shift(r),this.draftRow(id,r)]);
    const shift=settled(s);assert(shift,'Abra o caixa primeiro');const d=settled(x);assert(d,'Venda não encontrada');
    assert(d.status==='open',d.status==='completed'?`A venda ${d.label} já foi cobrada`:`A venda ${d.label} foi descartada`);
    assert(shift.id===d.shift_id,'Esta venda não pertence ao caixa aberto');return d;
  }
  async draftItems(id,r=this.ctx.r){return (await r.openSales.items(id)).map(itemView);}
  async itemOf(saleId,itemId,r=this.ctx.r){const i=await r.openSales.item(itemId);assert(i,'Item não encontrado');assert(i.draft_sale_id===saleId,'Este item não pertence a esta venda');return i;}
  touch(t,id){return t.openSales.touch(id,now());}
  async logDraft(t,id,kind,detail){await t.openSales.log({id,uuid:randomUUID(),kind,detail,operatorId:await this.ctx.employees.operatorId(t),at:now()});}
  // Automatic names count the shift's sales and skip names already on an open tab.
  async insertDraft(t,shift,{select=true,label=''}={}){
    let name=label;
    if(!name){const used=(await t.openSales.listOpen(shift.id)).map(d=>d.label);let n=(await t.openSales.countForShift(shift.id))+1;
      do name=`Venda ${pad2(n++)}`;while(used.some(u=>sameName(u,name)));}
    const id=randomUUID();
    await t.openSales.create({id,shiftId:shift.id,label:name,operatorId:await this.ctx.employees.operatorId(t),at:now()});
    if(select)await t.cash.setActiveDraft(shift.id,id);
    return id;
  }
  // When the sale receiving the weighings closes, the scale needs a destination that can't be another customer's:
  // a sale nobody has touched yet, or a new one. A sale that ever had items is never picked automatically.
  async chooseActive(t,shift){
    const fresh=await t.openSales.freshest(shift.id);
    if(fresh)await t.cash.setActiveDraft(shift.id,fresh.id);else await this.insertDraft(t,shift);
    return (await t.cash.openShift()).active_draft_id;
  }
  // At startup open sales come back as they were, and the weighing destination stays the one chosen before.
  async restoreOpenDraftSales(){
    const {ctx}=this;await ctx.r.openSales.discardEmptyOrphans(now());
    const shift=await ctx.cash.shift();if(!shift)return [];
    const active=await this.draftRow(shift.active_draft_id);
    if(!(active&&active.status==='open'&&active.shift_id===shift.id))await ctx.tx(t=>this.chooseActive(t,shift));
    return this.listDraftSales();
  }
  async activeSaleId(r=this.ctx.r){return (await this.ctx.cash.shift(r))?.active_draft_id||null;}
  async listDraftSales(r=this.ctx.r){const shift=await this.ctx.cash.shift(r);return shift?r.openSales.listOpen(shift.id):[];}
  async getDraftSale(id,r=this.ctx.r){const [d,items]=await Promise.all([this.draftRow(id,r),this.draftItems(id,r)]);assert(d,'Venda não encontrada');return {...d,items,totalCents:items.reduce((s,x)=>s+x.totalCents,0)};}
  async createDraftSale(){const shift=await this.ctx.cash.shift();assert(shift,'Abra o caixa antes da venda');return this.getDraftSale(await this.ctx.tx(t=>this.insertDraft(t,shift)));}
  async selectDraftSale(id){const d=await this.requireOpenSale(id);await this.ctx.r.cash.setActiveDraft(d.shift_id,d.id);return this.getDraftSale(d.id);}
  async renameDraftSale(id,label){
    const d=await this.requireOpenSale(id);const name=String(label??'').trim().replace(/\s+/g,' ');
    assert(name.length>=1&&name.length<=30,'O nome da venda deve ter de 1 a 30 caracteres');
    assert(!(await this.listDraftSales()).some(x=>x.id!==d.id&&sameName(x.label,name)),'Já existe uma venda aberta com esse nome');
    await this.ctx.tx(async t=>{await t.openSales.rename(d.id,name);await this.touch(t,d.id);});return this.getDraftSale(d.id);
  }
  async insertItem(t,saleId,x){await t.openSales.addItem(saleId,{...x,id:randomUUID(),at:now()});await this.touch(t,saleId);}
  async addUnit(saleId,productId,quantity=1){
    const d=await this.requireOpenSale(saleId);const n=integer(productId,'Produto',1),qty=integer(quantity,'Quantidade',1,999);
    // Repeated taps on the same product grow one line instead of stacking duplicates.
    const line=await this.ctx.r.openSales.unitLine(d.id,n);
    const p=await this.ctx.stock.checkStock(n,qty+(line?line.quantity:0),line?line.id:'');
    await this.ctx.tx(async t=>{
      if(line){await t.openSales.setQuantity(line.id,line.quantity+qty,line.unit_cents*(line.quantity+qty));await this.touch(t,d.id);}
      else await this.insertItem(t,d.id,{kind:'unit',productId:n,label:p.name,quantity:qty,unitCents:p.price_cents,totalCents:p.price_cents*qty});
    });
    return this.getDraftSale(d.id);
  }
  async setQuantity(saleId,itemId,quantity){
    const d=await this.requireOpenSale(saleId);const item=await this.itemOf(d.id,itemId);assert(item.kind==='unit','Só produtos avulsos têm quantidade');
    const qty=integer(quantity,'Quantidade',1,999);await this.ctx.stock.checkStock(item.product_id,qty,item.id);
    await this.ctx.tx(async t=>{await t.openSales.setQuantity(item.id,qty,item.unit_cents*qty);await this.touch(t,d.id);});
    return this.getDraftSale(d.id);
  }
  // captureId identifies one scale cycle: offered again (retry, reconnection, repeated request), it is stored only once.
  async addWeighed(saleId,grams,captureId=null){
    const d=await this.requireOpenSale(saleId);const g=integer(grams,'Peso',1,15000);
    if(captureId!==null)assert(/^[0-9a-zA-Z-]{8,80}$/.test(String(captureId)),'Identificador de pesagem inválido');
    // The duplicate check and the price per kg are read together.
    const [seen,config]=await Promise.all([captureId!==null?this.ctx.r.openSales.captureExists(String(captureId)):null,this.ctx.config.getConfig()]);
    if(seen)return {...await this.getDraftSale(d.id),duplicate:true};
    const price=config.priceKgCents;
    await this.ctx.tx(t=>this.insertItem(t,d.id,{kind:'weight',grams:g,label:'Açaí por peso',unitCents:price,totalCents:calcTotal(g,price),captureId:captureId===null?null:String(captureId)}));
    return {...await this.getDraftSale(d.id),duplicate:false};
  }
  // A weighing from the scale goes to the sale on the scale, read in the same step that stores it. With saleId
  // (the "add weighing" button), that sale must still be the one on the scale. The error says which sale it was for.
  async captureWeighing(reading,saleId=null){
    const active=await this.activeSaleId();
    try{
      if(saleId!==null&&saleId!==undefined){assert(await this.ctx.cash.shift(),'Abra o caixa primeiro');assert(saleId===active,'A balança está pesando para outra venda. Selecione esta venda antes de lançar o peso.');}
      assert(active,'Abra o caixa primeiro');
      return await this.addWeighed(active,reading.grams,reading.captureId);
    }catch(e){e.saleId=active;e.saleLabel=active?(await this.draftRow(active).catch(()=>null))?.label||'':'';throw e;}
  }
  async addManualWeight(saleId,weight){const d=await this.requireOpenSale(saleId);const g=readWeight(weight);const price=(await this.ctx.config.getConfig()).priceKgCents;
    await this.ctx.tx(t=>this.insertItem(t,d.id,{kind:'weight',grams:g,label:'Açaí por peso (digitado)',unitCents:price,totalCents:calcTotal(g,price),manual:true}));
    return this.getDraftSale(d.id);}
  async addManualValue(saleId,amount){const d=await this.requireOpenSale(saleId);const cents=readMoney(amount);assert(cents>0&&cents<=100000,'Valor deve estar entre R$ 0,01 e R$ 1.000,00');
    await this.ctx.tx(t=>this.insertItem(t,d.id,{kind:'value',label:'Açaí (valor digitado)',quantity:1,unitCents:cents,totalCents:cents,manual:true}));
    return this.getDraftSale(d.id);}
  async removeDraftSaleItem(saleId,itemId){const d=await this.requireOpenSale(saleId);const item=await this.itemOf(d.id,itemId);
    await this.ctx.tx(async t=>{await t.openSales.removeItem(item.id);await this.touch(t,d.id);});return this.getDraftSale(d.id);}
  // Moves one line to another open sale ('new' creates one), both totals follow, and the move is recorded on both sales.
  async transferDraftSaleItem(fromId,itemId,toId){
    const from=await this.requireOpenSale(fromId);const item=await this.itemOf(from.id,itemId);
    if(toId!=='new'){const to=await this.requireOpenSale(toId);assert(to.id!==from.id,'Escolha outra venda de destino');}
    return this.ctx.tx(async t=>{
      const to=toId==='new'?await this.draftRow(await this.insertDraft(t,await t.cash.openShift(),{select:false}),t):await this.draftRow(toId,t);
      await t.openSales.moveItem(item.id,to.id);await this.touch(t,from.id);await this.touch(t,to.id);
      const detail={itemId:item.id,label:item.label,grams:item.grams,quantity:item.quantity,totalCents:item.total_cents,from:{id:from.id,label:from.label},to:{id:to.id,label:to.label}};
      await this.logDraft(t,from.id,'transfer_out',detail);await this.logDraft(t,to.id,'transfer_in',detail);
      return {from:await this.getDraftSale(from.id,t),to:await this.getDraftSale(to.id,t)};
    });
  }
  async draftEvents(id){return (await this.ctx.r.openSales.events(id)).map(e=>({...e,detail:JSON.parse(e.detail||'{}')}));}
  async discardDraftSale(id){
    const d=await this.requireOpenSale(id);const items=await this.draftItems(d.id);
    return this.ctx.tx(async t=>{
      await t.openSales.discard(d.id,now());
      await this.logDraft(t,d.id,'discard',{label:d.label,items:items.length,totalCents:items.reduce((s,x)=>s+x.totalCents,0)});
      const shift=await t.cash.openShift();if(shift.active_draft_id===d.id)await this.chooseActive(t,shift);
      return {discarded:d.id,activeSaleId:await this.activeSaleId(t)};
    });
  }
  // Pays one open sale. The finished sale, its items, the stock and the end of the open sale are one transaction:
  // on any failure nothing is written and the open sale keeps its items. Asking twice returns the first sale.
  async checkoutDraftSale(saleId,method,requestId,received,revision){
    const {ctx}=this;assert(['cash','pix','debit','credit'].includes(method),'Forma de pagamento inválida');
    const uuid=String(requestId||'');
    // Reads that do not depend on each other go out together (on a cloud database each one is a round trip); the
    // checks and their messages keep the order they always had.
    const [s,byUuid,byDraft]=await Promise.allSettled([ctx.cash.shift(),ctx.r.sales.findByUuid(uuid),ctx.r.sales.findByDraft(String(saleId??''))]);
    const shift=settled(s);assert(shift,'Abra o caixa primeiro');
    assert(/^[0-9a-zA-Z-]{12,80}$/.test(uuid),'Identificador de venda inválido');
    const again=settled(byUuid)||settled(byDraft);
    if(again)return {sale:again,duplicate:true,activeSaleId:await this.activeSaleId()};
    const [open,operator]=await Promise.allSettled([this.requireOpenSale(saleId),ctx.employees.requireOperator()]);
    const d=settled(open);
    // The total the operator confirmed must still be the total: a weighing that arrived meanwhile stops the charge.
    if(revision!==undefined&&revision!==null&&revision!=='')assert(integer(revision,'Revisão',0,1e9)===d.revision,`A venda ${d.label} mudou depois da conferência. Confira o total e cobre de novo.`);
    const items=await this.draftItems(d.id);assert(items.length>0,`A venda ${d.label} não tem itens`);const op=settled(operator);
    const total=items.reduce((s,x)=>s+x.totalCents,0);assert(total>0,'Venda com total inválido');
    // Amount handed over by the customer, optional and only for cash; the drawer still counts the sale total.
    let receivedCents=null;
    if(method==='cash'&&received!==undefined&&received!==null&&received!==''){receivedCents=readMoney(received);assert(receivedCents>=total,'Valor recebido menor que o total da venda');}
    const id=await ctx.tx(async t=>{
      await ctx.stock.takeForSale(t,items);
      const id=await t.sales.createSale({uuid,shiftId:shift.id,createdAt:now(),method,totalCents:total,operatorId:op.id,receivedCents,changeCents:receivedCents===null?null:receivedCents-total,draftSaleId:d.id});
      for(const item of items)await t.sales.addSaleItem(id,item);
      assert(await t.openSales.complete(d.id,{at:now(),saleId:id}),`A venda ${d.label} já foi cobrada`);
      if((await t.cash.openShift()).active_draft_id===d.id)await this.chooseActive(t,shift);
      return id;
    });
    const [sale,activeSaleId]=await Promise.all([ctx.r.sales.findById(id),this.activeSaleId()]);
    return {sale,duplicate:false,activeSaleId};
  }
  async cancelCheck(id,reason){
    const n=integer(id,'Venda',1);const why=String(reason||'').trim();assert(why.length>=3&&why.length<=180,'Informe o motivo do cancelamento');
    const sale=await this.ctx.r.sales.findById(n);assert(sale,'Venda não encontrada');assert(sale.status==='done','Venda já cancelada');
    // A closed shift was already counted; changing its sales would silently break that closing.
    const shift=await this.ctx.cash.shift();assert(shift&&sale.shift_id===shift.id,'Só é possível cancelar vendas do caixa aberto');
    return {n,why,op:await this.ctx.employees.requireOperator(),shift};
  }
  async markCanceled(t,n,why,op){
    assert(await t.sales.cancelSale(n,{canceledAt:now(),canceledBy:op.id,reason:why}),'Venda já cancelada');
    await this.ctx.stock.returnForSale(t,n);
  }
  async cancelSale(id,reason){const {n,why,op}=await this.cancelCheck(id,reason);await this.ctx.tx(t=>this.markCanceled(t,n,why,op));return this.saleDetail(n);}
  // The canceled sale's items go to a new open sale of their own, so no other customer's sale is touched.
  // select is decided by the caller (the server only allows it with the scale empty).
  async correctSale(id,reason,{select=false}={}){
    const {n,why,op,shift}=await this.cancelCheck(id,reason);
    const draftId=await this.ctx.tx(async t=>{
      await this.markCanceled(t,n,why,op);
      const draftId=await this.insertDraft(t,shift,{select,label:`Correção #${n}`});
      for(const x of await t.sales.items(n))
        await this.insertItem(t,draftId,{kind:x.kind,productId:x.product_id,label:x.label,grams:x.grams,quantity:x.quantity,unitCents:x.unit_cents,totalCents:x.total_cents,manual:!!x.manual});
      await this.logDraft(t,draftId,'correction',{saleId:n,reason:why});
      return draftId;
    });
    return {sale:await this.saleDetail(n),draft:await this.getDraftSale(draftId),selected:select};
  }
  async saleDetail(id){
    const n=integer(id,'Venda',1);const r=this.ctx.r;const sale=await r.sales.detail(n);assert(sale,'Venda não encontrada');
    const shift=await this.ctx.cash.shift();
    return {...sale,items:await r.sales.items(n),cancelable:sale.status==='done'&&!!shift&&shift.id===sale.shift_id};
  }
}
module.exports={SaleService,itemView};
