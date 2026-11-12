'use strict';
// Who may do what, decided on the server for every request, from the identity of the session (never from anything
// the browser sends) and the permissions as they are now (a change made by the administrator counts at the next
// request, in sessions already open too). Nothing is allowed by default:
//   no session, an expired or a locked one  → 401, nothing runs
//   a permission the identity does not have → 403, nothing runs
//   a permission that is not in the catalog → refused for everybody, the administrator included
// identity: {kind:'admin'|'operador',name,employeeId,permissions:Set} (src/auth/PosAuth.js).
const {isKnown,isAdminOnly}=require('./PermissionCatalog');
const httpError=(status,message,expose)=>Object.assign(Error(message),{status,...(expose?{expose}:{})});
const DENIED='Você não tem permissão para esta operação. Peça ao administrador.';
function hasPermission(identity,permission){
  if(!identity||identity.locked)return false;
  if(!isKnown(permission)&&!isAdminOnly(permission))return false;
  if(identity.kind==='admin')return true;
  if(identity.kind!=='operador'||isAdminOnly(permission))return false;
  return !!identity.permissions?.has(permission);
}
function requireAuthentication(identity){
  if(!identity)throw httpError(401,'Entre com o seu usuário para usar o caixa.',{auth:'login'});
  if(identity.locked)throw httpError(401,'O caixa está bloqueado. Digite o PIN para continuar.',{auth:'locked'});
  return identity;
}
function requirePermission(identity,permission){
  requireAuthentication(identity);
  if(!hasPermission(identity,permission))throw httpError(403,DENIED,{permission,needsAdmin:true});
  return identity;
}
// At least one of them (a screen reachable through more than one permission).
function requireAny(identity,permissions){
  requireAuthentication(identity);
  if(!permissions.some(p=>hasPermission(identity,p)))throw httpError(403,DENIED,{permission:permissions[0],needsAdmin:true});
  return identity;
}
function requireAdmin(identity){
  requireAuthentication(identity);
  if(identity.kind!=='admin')throw httpError(403,'Somente o administrador pode fazer isso.',{needsAdmin:true});
  return identity;
}
module.exports={hasPermission,requireAuthentication,requirePermission,requireAny,requireAdmin,httpError,DENIED};
