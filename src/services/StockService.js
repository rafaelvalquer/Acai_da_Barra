'use strict';
const {readMoney}=require('../protocol');const {assert,integer,byName}=require('./util');
// Products sold by the unit and their stock. available = stock minus the units already in open sales.
class StockService {
  constructor(ctx){this.ctx=ctx;}
  async listProducts(){return (await this.ctx.r.products.listActive()).map(p=>({...p,available:p.stock-p.reserved})).sort(byName);}
  async product(input){
    const r=this.ctx.r;const name=String(input.name||'').trim();assert(name.length>=2&&name.length<=80,'Nome deve ter 2 a 80 caracteres');
    const priceCents=readMoney(input.price);assert(priceCents>0,'Preço deve ser maior que zero');
    const stock=integer(input.stock,'Estoque',0,999999);
    if(input.id){const id=integer(input.id,'ID',1);assert(await r.products.exists(id),'Produto não encontrado');await r.products.update(id,{name,priceCents,stock});return {id};}
    return {id:await r.products.insert({name,priceCents,stock})};
  }
  async deleteProduct(id){const n=integer(id,'ID',1);
    assert((await this.ctx.r.products.reserved(n))===0,'Este produto está em vendas abertas. Tire das vendas antes de excluir.');
    await this.ctx.r.products.deactivate(n);return true;}
  async checkStock(productId,quantity,exceptItem,r=this.ctx.r){
    const p=await r.products.findActive(productId);assert(p,'Produto não encontrado');
    const free=p.stock-(await r.products.reserved(productId,exceptItem));assert(free>=quantity,`Estoque insuficiente para ${p.name} (disponível: ${Math.max(free,0)})`);return p;
  }
  // Inside the checkout transaction: any line without stock aborts the whole sale.
  async takeForSale(t,items){
    for(const item of items.filter(x=>x.kind==='unit'))assert(await t.products.takeStock(item.productId,item.quantity),`Estoque insuficiente para ${item.label}`);
  }
  // Inside the cancellation transaction: the units of a canceled sale go back to the shelf.
  async returnForSale(t,saleId){for(const item of await t.sales.unitItems(saleId))await t.products.returnStock(item.product_id,item.quantity);}
}
module.exports={StockService};
