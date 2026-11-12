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
  // Who is operating. Through the server it is always the person signed in at the till (ctx.actor, set by
  // store.as()), never an id sent by the browser; the administrator at the till is recorded without an employee
  // (operator NULL) and in the administrative log. Without an actor (scripts, tests, the demo's example data) the
  // operator chosen with setOperator() is used.
  async operatorId(r=this.ctx.r){const a=this.ctx.actor;if(a)return a.employeeId??null;const v=await r.settings.get('operator_id');return v?Number(v):null;}
  async operator(r=this.ctx.r){
    const a=this.ctx.actor;if(a&&!a.employeeId)return a.kind==='admin'?{id:null,name:a.name}:null;
    const id=await this.operatorId(r);return id?this.employee(id,r):null;
  }
  async setOperator(id){assert(!this.ctx.actor,'O operador é quem entrou no caixa');const e=await this.employee(integer(id,'Funcionário',1));assert(e,'Funcionário não encontrado');await this.ctx.r.settings.set('operator_id',e.id);return e;}
  async requireOperator(r=this.ctx.r){const op=await this.operator(r);assert(op,this.ctx.actor?'Entre com o seu PIN para usar o caixa':'Selecione o operador do caixa');return op;}
}
module.exports={EmployeeService};
