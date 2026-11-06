'use strict';
const {readMoney}=require('../protocol');const {assert}=require('./util');
// Commercial settings kept in the database: price per kilo and automatic capture.
class ConfigService {
  constructor(ctx){this.ctx=ctx;}
  async init(){const s=this.ctx.r.settings;await s.ensure('price_kg_cents','6490');await s.ensure('auto_capture','1');await s.ensure('operator_id','');}
  async getConfig(r=this.ctx.r){return {priceKgCents:Number(await r.settings.get('price_kg_cents')),autoCapture:(await r.settings.get('auto_capture'))==='1'};}
  async updateConfig(input){
    const s=this.ctx.r.settings;
    if(input.priceKg!==undefined){const cents=readMoney(input.priceKg);assert(cents>0&&cents<=1000000,'Preço/kg fora do limite');await s.set('price_kg_cents',cents);}
    if(input.autoCapture!==undefined){assert(typeof input.autoCapture==='boolean','Opção inválida');await s.set('auto_capture',input.autoCapture?'1':'0');}
    return this.getConfig();
  }
}
module.exports={ConfigService};
