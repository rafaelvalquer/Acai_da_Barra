'use strict';
const {assert,integer,now,byName,sameName}=require('./util');
// The team and who is operating the register. Every sale, cash movement and cancellation is recorded with that name.
class EmployeeService {
  constructor(ctx){this.ctx=ctx;}
  async listEmployees(r=this.ctx.r){return (await r.employees.listActive()).sort(byName);}
  async employee(id,r=this.ctx.r){return (await r.employees.findActive(id))||null;}
  async saveEmployee(input){
    const r=this.ctx.r;const name=String(input.name||'').trim().replace(/\s+/g,' ');assert(name.length>=2&&name.length<=40,'Nome deve ter 2 a 40 caracteres');
    const id=input.id?integer(input.id,'ID',1):0;
    assert(!(await this.listEmployees()).some(e=>e.id!==id&&sameName(e.name,name)),'Já existe um funcionário com esse nome');
    if(id){assert(await this.employee(id),'Funcionário não encontrado');await r.employees.rename(id,name);return {id};}
    return {id:await r.employees.insert({name,createdAt:now()})};
  }
  async removeEmployee(id){const n=integer(id,'ID',1);const r=this.ctx.r;
    assert(!((await this.ctx.cash.shift())&&(await this.operatorId())===n),'Troque o operador antes de desativar quem está no caixa');
    await r.employees.deactivate(n);if((await this.operatorId())===n)await r.settings.set('operator_id','');return true;}
  async operatorId(r=this.ctx.r){const v=await r.settings.get('operator_id');return v?Number(v):null;}
  async operator(r=this.ctx.r){const id=await this.operatorId(r);return id?this.employee(id,r):null;}
  async setOperator(id){const e=await this.employee(integer(id,'Funcionário',1));assert(e,'Funcionário não encontrado');await this.ctx.r.settings.set('operator_id',e.id);return e;}
  async requireOperator(r=this.ctx.r){const op=await this.operator(r);assert(op,'Selecione o operador do caixa');return op;}
}
module.exports={EmployeeService};
