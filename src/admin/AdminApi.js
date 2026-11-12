'use strict';
// /api/admin/*: the Admin area's routes. Everything except signing in needs an administrator session (HttpOnly
// cookie); writes also need the page's session token and a same-origin request, so another site open in the browser
// cannot trigger them. Operations that change or replace data ask for the current password again.
const fs=require('node:fs');
const {AdminSessionService}=require('../auth/AdminSessionService');const {describeUrl}=require('../database/DatabaseManager');
const {catalogView}=require('../auth/PermissionCatalog');
// What the Usuários e permissões screen lists in its log.
const OPERATOR_ACTIONS=['login_operador','login_operador_falhou','logout_operador','terminal_bloqueado','troca_pin','permissoes_alteradas','acesso_desativado','acesso_ativado',
  'limite_sangria_alterado','caixa_aberto','caixa_fechado','venda_cancelada','venda_corrigida','sangria','suprimento','preco_kg_alterado','preco_produto_alterado','acesso_negado','venda_admin'];
const httpError=(status,message)=>Object.assign(Error(message),{status});
function sameOrigin(req){
  const host=req.headers.host;const o=req.headers.origin;if(o)return o===`http://${host}`;
  const r=req.headers.referer;if(r){try{return new URL(r).host===host;}catch(_){return false;}}
  return true;
}
class AdminApi {
  constructor(system){this.sys=system;}
  async session(req){return this.sys.sessions.get(AdminSessionService.read(req));}
  // scope "completo" for the Admin area; any session for signing out and setting the new password.
  async need(req,scope='completo'){
    const s=await this.session(req);
    if(!s){
      // An employee signed in at the till is known but not allowed here (403, logged); anyone else must sign in (401).
      const who=await this.sys.pos?.identify(req,{touch:false}).catch(()=>null);
      if(who?.kind==='operador'){
        await this.sys.audit({username:who.name,action:'acesso_negado',ok:false,detail:{permissao:'admin',rota:'/api/admin'}}).catch(()=>{});
        throw httpError(403,'Somente o administrador acessa esta área. Peça ao administrador.');
      }
      throw httpError(401,'Entre com o usuário e a senha de administrador.');
    }
    if(scope==='completo'&&s.scope!=='completo')throw httpError(403,'Defina a nova senha de administrador para continuar.');
    return s;
  }
  async confirmed(req,b){const s=await this.need(req);await this.sys.auth.confirm(s,b.password);return s;}
  async handle(req,res,{url,token,send,fail,readBody}){
    const route=url.pathname.slice('/api/admin/'.length);const sys=this.sys;
    if(req.method==='GET'){
      if(route==='session')return send(res,200,await sys.auth.status(await this.session(req)));
      const s=await this.need(req);
      switch(route){
        case 'overview':return send(res,200,await sys.overview(s));
        case 'database':return send(res,200,await sys.databaseInfo());
        case 'backup':return send(res,200,{...sys.backups.overview(),hardware:await sys.hardware.check(sys.scale)});
        case 'diagnostics':return send(res,200,await sys.diagnostics());
        case 'access-log':return send(res,200,await sys.auth.recentAccess(40));
        case 'audit':return send(res,200,await sys.adminStore.recentAudit(80));
        // Users and permissions: the employees of the commercial database, their access at the till and the catalog.
        case 'operators':return send(res,200,{operators:await sys.pos.operators.listOperators(),catalog:catalogView(),
          settings:{blindWithdrawalLimitCents:await sys.db.blindWithdrawalLimit()}});
        case 'permissions/catalog':return send(res,200,catalogView());
        case 'operators/audit':return send(res,200,await sys.adminStore.recentAudit(80,OPERATOR_ACTIONS));
        default:return fail(res,404,'Endereço não encontrado');
      }
    }
    if(req.method!=='POST')return fail(res,404,'Endereço não encontrado');
    if(req.headers['x-luminor-token']!==token||!sameOrigin(req))return fail(res,403,'Sessão de segurança inválida. Recarregue a página.');
    const ua=String(req.headers['user-agent']||'');
    // The backup file arrives as raw bytes, not JSON.
    if(route==='backup/restore/upload'){
      const s=await this.need(req);sys.assertRestoreAllowed();
      const r=await sys.backups.restorer.receive(req);await sys.audit({username:s.username,action:'restauracao_arquivo',detail:{bytes:r.bytes,createdAt:r.createdAt}});
      return send(res,200,{ok:true,result:r});
    }
    const b=await readBody(req);let result,headers={};
    const cookie=t=>{headers={'Set-Cookie':AdminSessionService.cookie(t)};};
    switch(route){
      case 'login':{const r=await sys.auth.login({username:b.username,password:b.password,userAgent:ua});cookie(r.token);result={user:r.user};break;}
      case 'recover':{const r=await sys.auth.recover({username:b.username,code:b.code,userAgent:ua});cookie(r.token);result={user:r.user};break;}
      case 'logout':{await sys.auth.logout(await this.session(req));headers={'Set-Cookie':AdminSessionService.clearCookie()};result=true;break;}
      case 'change-password':{const s=await this.need(req,'qualquer');const r=await sys.auth.changePassword(s,{current:b.current,next:b.next,userAgent:ua});cookie(r.token);result={user:r.user};break;}
      case 'change-username':result=await sys.auth.changeUsername(await this.need(req),{username:b.username,password:b.password});break;
      case 'recovery-code':result=await sys.auth.newRecoveryCode(await this.need(req),{password:b.password});break;
      case 'database/integrity':{const s=await this.need(req);result=await sys.databases.integrity();await sys.audit({username:s.username,action:'integridade_verificada',ok:result.ok,detail:{mensagem:result.message}});break;}
      case 'database/test':result=await sys.migration.test({url:b.url,password:b.password,ca:b.ca},await this.need(req));break;
      case 'database/prepare':result=await sys.migration.prepare(await this.confirmed(req,b));break;
      case 'database/sync/enable':result=await sys.migration.enableSync(await this.confirmed(req,b),{replace:b.replace===true});break;
      case 'database/sync/disable':result=await sys.migration.disableSync(await this.confirmed(req,b));break;
      case 'database/sync/now':result=await sys.migration.syncNow(await this.need(req));break;
      case 'database/sync/resend':result=await sys.migration.resendAll(await this.confirmed(req,b));break;
      // Only while an installation of the old cloud mode waits to move to the local database.
      case 'database/convert':{await this.confirmed(req,b);if(!(await sys.migration.convertLegacy()))throw httpError(409,'Não há nada para converter: o PDV já usa o banco deste computador, ou a nuvem está fora do ar.');result=await sys.databaseInfo();break;}
      case 'database/use-local':result=await sys.migration.useLocal(await this.confirmed(req,b),{mode:b.mode});break;
      case 'backup/export':{
        const s=await this.need(req);const r=await sys.backups.create({kind:'manual',actor:s});
        await sys.audit({username:s.username,action:'backup_exportado',detail:{name:r.name,bytes:r.bytes}});
        result={name:r.name,bytes:r.bytes,at:r.at,summary:r.summary};break;
      }
      case 'backup/download':{
        const s=await this.need(req);const e=sys.backups.manager.find(b.name);const data=fs.readFileSync(e.file);
        await sys.audit({username:s.username,action:'backup_baixado',detail:{name:e.name}});
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
          'Content-Disposition':`attachment; filename="${e.name}"`});
        return res.end(data);
      }
      case 'backup/settings':{const s=await this.need(req);result=await sys.backups.saveSettings(b);await sys.audit({username:s.username,action:'backup_configurado',detail:result});break;}
      case 'backup/recovery-key':{const s=await this.confirmed(req,b);await sys.audit({username:s.username,action:'chave_backup_exibida'});result={key:sys.backups.keys.recoveryKey(),confirmed:sys.backups.keys.confirmed()};break;}
      case 'backup/recovery-key/confirm':{const s=await this.need(req);await sys.backups.keys.confirm();await sys.audit({username:s.username,action:'chave_backup_anotada'});result=true;break;}
      case 'backup/restore/validate':{
        const s=await this.need(req);
        try{result=await sys.backups.restorer.validate(b.uploadId,{recoveryKey:b.recoveryKey});}
        catch(e){await sys.audit({username:s.username,action:'restauracao_recusada',ok:false,detail:{motivo:e.message,codigo:e.code||null}});
          if(e.needsRecoveryKey)return fail(res,422,e.message,{needsRecoveryKey:true});throw e;}
        await sys.audit({username:s.username,action:'restauracao_validada',detail:{createdAt:result.createdAt,vendas:result.summary.sales.done}});break;
      }
      case 'backup/restore/cancel':await this.need(req);result=sys.backups.restorer.cancel(b.uploadId);break;
      case 'backup/restore':{
        const s=await this.confirmed(req,b);sys.assertRestoreAllowed();
        result=await sys.backups.restorer.restore(b.uploadId,{actor:s});sys.onRestored?.();
        result.hardware=await sys.hardware.check(sys.scale);break;
      }
      // A PIN, permissions or the blind withdrawal limit: the administrator's password again, as for any change of access.
      case 'operators/credentials':{const s=await this.confirmed(req,b);result=await sys.pos.operators.setPin(b.employeeId,b.pin,{by:s.username,applyDefaults:b.applyDefaults===true});break;}
      case 'operators/permissions':{const s=await this.confirmed(req,b);result=await sys.pos.operators.setPermissions(b.employeeId,b.permissions||{},{by:s.username,reset:b.reset===true});break;}
      // Blocking needs no password (it only takes access away); giving it back does.
      case 'operators/disable':{const active=b.active===true;const s=active?await this.confirmed(req,b):await this.need(req);result=await sys.pos.operators.setActive(b.employeeId,active,{by:s.username});break;}
      case 'operators/settings':{
        const s=await this.confirmed(req,b);const cents=await sys.db.setBlindWithdrawalLimit(b.blindWithdrawalLimit);
        await sys.audit({username:s.username,action:'limite_sangria_alterado',detail:{limiteCentavos:cents}});result={blindWithdrawalLimitCents:cents};break;
      }
      // The administrator, already in the Admin area, takes the till with the same sign-in.
      case 'pos-session':{const s=await this.need(req);const r=await sys.pos.adminAtTill(s,{scaleIdle:sys.scale.idle()});headers={'Set-Cookie':r.cookies};result=r.session;break;}
      case 'diagnostics/export':{
        const s=await this.need(req);const d=await sys.diagnostics({full:true});await sys.audit({username:s.username,action:'diagnostico_exportado'});
        const body=Buffer.from(JSON.stringify(d,null,2));
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
          'Content-Disposition':`attachment; filename="luminor-pdv-diagnostico-${d.generatedAt.slice(0,10)}.json"`});
        return res.end(body);
      }
      default:return fail(res,404,'Operação não encontrada');
    }
    send(res,200,{ok:true,result},headers);
  }
}
module.exports={AdminApi,sameOrigin,describeUrl};
