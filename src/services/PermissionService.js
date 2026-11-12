'use strict';
const {CATALOG,isKnown}=require('../auth/PermissionCatalog');const {assert,integer,now,byName}=require('./util');
// What each employee may do at the till, kept in the commercial database with the employees (so it goes with the
// backups and to the cloud copy). Only the administrator changes it (src/admin/AdminApi.js). Who may sign in, and
// with which PIN, is not here: that is config/admin.sqlite (src/auth/OperatorAuthService.js).
class PermissionService {
  constructor(ctx){this.ctx=ctx;}
  // { permission: true|false } for every permission with a row; a permission without a row is refused.
  async employeePermissions(employeeId){
    const rows=await this.ctx.r.permissions.forEmployee(integer(employeeId,'Funcionário',1));
    return Object.fromEntries(rows.map(r=>[r.permission,!!Number(r.allowed)]));
  }
  // changes: { permission: true|false }, only permissions of the catalog. Returns what really changed.
  async savePermissions(employeeId,changes,{by}){
    const id=integer(employeeId,'Funcionário',1);const e=await this.ctx.r.employees.find(id);assert(e&&Number(e.active)===1,'Funcionário não encontrado');
    assert(changes&&typeof changes==='object'&&!Array.isArray(changes),'Permissões inválidas');
    for(const [p,v] of Object.entries(changes)){assert(isKnown(p),`Permissão desconhecida: ${String(p).slice(0,40)}`);assert(typeof v==='boolean','Permissões inválidas');}
    const before=await this.employeePermissions(id);const at=now();const who=String(by||'administrador').slice(0,64);
    const added=[],removed=[];
    await this.ctx.tx(async t=>{
      for(const p of CATALOG.map(x=>x.id))if(p in changes){
        const was=!!before[p],next=changes[p];
        if(!(p in before)||was!==next)await t.permissions.set(id,p,next,{at,by:who});
        if(next&&!was)added.push(p);else if(!next&&was)removed.push(p);
      }
    });
    return {employee:{id:e.id,uuid:e.uuid,name:e.name},added,removed,permissions:await this.employeePermissions(id)};
  }
  // Every employee with their uuid and allowed permissions, for checking each request (cached by the store).
  async accessIndex(){
    const r=this.ctx.r;const [team,allowed]=await Promise.all([r.employees.listWithUuid(),r.permissions.allowed()]);
    const byId=new Map(team.map(e=>[Number(e.id),{id:Number(e.id),uuid:e.uuid,name:e.name,active:Number(e.active)===1,allowed:[]}]));
    for(const a of allowed)byId.get(Number(a.employee_id))?.allowed.push(a.permission);
    const byUuid=new Map();for(const e of byId.values()){e.allowed.sort();byUuid.set(e.uuid,e);}
    return {byUuid,byId};
  }
  // Active employees and when their permissions last changed, for the Admin screen.
  async permissionOverview(){
    const r=this.ctx.r;const [team,changes]=await Promise.all([r.employees.listWithUuid(),r.permissions.lastChanges()]);
    const last=new Map(changes.map(c=>[Number(c.employee_id),c.at]));
    return team.filter(e=>Number(e.active)===1).map(e=>({id:Number(e.id),uuid:e.uuid,name:e.name,permissionsChangedAt:last.get(Number(e.id))||null})).sort(byName);
  }
}
module.exports={PermissionService};
