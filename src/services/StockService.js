'use strict';
const {readMoney}=require('../protocol');const {assert,integer,byName}=require('./util');
const {CATEGORIES,CHANNELS,categoryOf,channelOf}=require('../database/catalog');
const flag=(v,label)=>{assert([true,false,0,1].includes(v),`${label} inválido`);return v===true||v===1?1:0;};
// Products sold by the unit and their stock. available = stock minus the units already in open sales.
class StockService {
  constructor(ctx){this.ctx=ctx;}
  async listProducts(){return (await this.ctx.r.products.listActive()).map(p=>({...p,available:p.stock-p.reserved})).sort(byName);}
  // category, channel and favorite are optional: left out, an edit keeps them and a new product is classified by its
  // name (catalog.js). An empty category means "by the name" too.
  async product(input){
    const r=this.ctx.r;const name=String(input.name||'').trim();assert(name.length>=2&&name.length<=80,'Nome deve ter 2 a 80 caracteres');
    const priceCents=readMoney(input.price);assert(priceCents>0,'Preço deve ser maior que zero');
    const stock=integer(input.stock,'Estoque',0,999999);
    const id=input.id?integer(input.id,'ID',1):null;const current=id?await r.products.find(id):null;assert(!id||current,'Produto não encontrado');
    const category=input.category==null||input.category===''?current?.category??categoryOf(name):String(input.category);
    assert(CATEGORIES.includes(category),`Categoria inválida. Use: ${CATEGORIES.join(', ')}.`);
    const channel=input.channel==null||input.channel===''?current?.channel??channelOf(name):String(input.channel);
    assert(CHANNELS.includes(channel),'Canal inválido. Use loja ou delivery.');
    const favorite=input.favorite==null?current?.is_favorite??0:flag(input.favorite,'Favorito');
    const row={name,priceCents,stock,category,channel,favorite};
    if(id){await r.products.update(id,row);return {id};}
    return {id:await r.products.insert(row)};
  }
  // Only the star: stock and price are not touched, whatever the screen had.
  async favoriteProduct(id,favorite){
    const n=integer(id,'ID',1);const value=flag(favorite,'Favorito');
    assert((await this.ctx.r.products.setFavorite(n,value)).changes===1,'Produto não encontrado');return {id:n,favorite:value===1};
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
