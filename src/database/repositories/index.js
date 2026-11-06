'use strict';
// All repositories bound to one executor: the adapter itself, or the transaction in progress.
const {SettingsRepository}=require('./SettingsRepository');const {EmployeesRepository}=require('./EmployeesRepository');
const {ProductsRepository}=require('./ProductsRepository');const {CashRepository}=require('./CashRepository');
const {SalesRepository}=require('./SalesRepository');const {OpenSalesRepository}=require('./OpenSalesRepository');
function repositories(q){
  return {settings:new SettingsRepository(q),employees:new EmployeesRepository(q),products:new ProductsRepository(q),cash:new CashRepository(q),
    sales:new SalesRepository(q),openSales:new OpenSalesRepository(q)};
}
module.exports={repositories};
