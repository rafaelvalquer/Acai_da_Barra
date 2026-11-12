'use strict';
const {randomUUID}=require('node:crypto');
// Operators identify themselves by name; administrator accounts are not employees (see src/auth/).
const PUBLIC='id,name';
class EmployeesRepository {
  constructor(q){this.q=q;}
  listActive(){return this.q.all(`SELECT ${PUBLIC} FROM employees WHERE active=1`);}
  findActive(id){return this.q.get(`SELECT ${PUBLIC} FROM employees WHERE id=? AND active=1`,[id]);}
  findName(id){return this.q.get('SELECT name FROM employees WHERE id=?',[id]);}
  // Sign-in accounts (config/admin.sqlite) point to employees by uuid.
  findByUuid(uuid){return this.q.get('SELECT id,uuid,name,active FROM employees WHERE uuid=?',[uuid]);}
  find(id){return this.q.get('SELECT id,uuid,name,active FROM employees WHERE id=?',[id]);}
  listWithUuid(){return this.q.all('SELECT id,uuid,name,active FROM employees ORDER BY active DESC,name');}
  async insert({name,createdAt}){return (await this.q.get('INSERT INTO employees(uuid,name,created_at) VALUES(?,?,?) RETURNING id',[randomUUID(),name,createdAt])).id;}
  rename(id,name){return this.q.run('UPDATE employees SET name=? WHERE id=?',[name,id]);}
  deactivate(id){return this.q.run('UPDATE employees SET active=0 WHERE id=?',[id]);}
  async count(){return (await this.q.get('SELECT COUNT(*) AS n FROM employees WHERE active=1')).n;}
}
module.exports={EmployeesRepository};
