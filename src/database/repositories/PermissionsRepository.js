'use strict';
const {randomUUID}=require('node:crypto');
// What each employee may do at the till: one row per permission of src/auth/PermissionCatalog.js, allowed (1) or
// refused (0). A permission without a row is refused.
class PermissionsRepository {
  constructor(q){this.q=q;}
  forEmployee(employeeId){return this.q.all('SELECT permission,allowed,updated_at,updated_by FROM employee_permissions WHERE employee_id=? ORDER BY permission',[employeeId]);}
  // Every allowed permission of active employees, for the authorization index.
  allowed(){return this.q.all('SELECT p.employee_id,p.permission FROM employee_permissions p JOIN employees e ON e.id=p.employee_id WHERE p.allowed=1 AND e.active=1');}
  // The last change of each employee's permissions (what the Admin screen shows).
  lastChanges(){return this.q.all('SELECT employee_id,MAX(updated_at) AS at FROM employee_permissions GROUP BY employee_id');}
  // Only a value that changes is written, so updated_at/updated_by tell when and by whom it last changed.
  set(employeeId,permission,allowed,{at,by}){
    return this.q.run(`INSERT INTO employee_permissions(uuid,employee_id,permission,allowed,updated_at,updated_by) VALUES(?,?,?,?,?,?)
      ON CONFLICT(employee_id,permission) DO UPDATE SET allowed=excluded.allowed,updated_at=excluded.updated_at,updated_by=excluded.updated_by
      WHERE employee_permissions.allowed<>excluded.allowed`,[randomUUID(),employeeId,permission,allowed?1:0,at,by]);
  }
}
module.exports={PermissionsRepository};
