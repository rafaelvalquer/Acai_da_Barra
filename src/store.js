'use strict';
// The PDV seen by the server: one object with every operation of the store, all asynchronous. Underneath, the
// services hold the business rules and talk to the database only through repositories and an adapter (SQLite now,
// PostgreSQL later). Operations run one at a time, so a check and the write that depends on it never interleave.
const {Mutex}=require('./database/Mutex');const {repositories}=require('./database/repositories');
const {ConfigService}=require('./services/ConfigService');const {EmployeeService}=require('./services/EmployeeService');
const {CashService}=require('./services/CashService');const {StockService}=require('./services/StockService');
const {SaleService}=require('./services/SaleService');const {ReportService}=require('./services/ReportService');
const OPERATIONS={
  config:['getConfig','updateConfig'],
  employees:['listEmployees','employee','saveEmployee','removeEmployee','operatorId','operator','setOperator','requireOperator'],
  cash:['shift','openShift','moveCash','shiftTotals','cashSummary','closeShift'],
  stock:['listProducts','product','deleteProduct'],
  sales:['draftRow','activeSaleId','listDraftSales','getDraftSale','createDraftSale','selectDraftSale','renameDraftSale','addUnit','setQuantity','addWeighed','captureWeighing',
    'addManualWeight','addManualValue','removeDraftSaleItem','transferDraftSaleItem','draftEvents','discardDraftSale','checkoutDraftSale','cancelSale','correctSale','saleDetail'],
  reports:['salesHistory','report']
};
async function migrate(adapter){
  if(adapter.dialect==='postgres')return require('./database/migrations/postgres').migratePostgres(adapter);
  return require('./database/migrations/sqlite').migrateSqlite(adapter);
}
class PdvStore {
  constructor(adapter){
    this.lock=new Mutex();const ctx=this.ctx={};
    ctx.config=new ConfigService(ctx);ctx.employees=new EmployeeService(ctx);ctx.cash=new CashService(ctx);ctx.stock=new StockService(ctx);
    ctx.sales=new SaleService(ctx);ctx.reports=new ReportService(ctx);
    this.attach(adapter);
  }
  attach(adapter){
    this.adapter=adapter;this.ctx.db=adapter;this.ctx.r=repositories(adapter);
    this.ctx.tx=fn=>adapter.transaction(q=>fn(repositories(q)));
  }
  // Brings the schema up to date (existing rows are kept), fills the default settings and brings back open sales.
  static async open(adapter){const store=new PdvStore(adapter);await store.init();return store;}
  async init(){await migrate(this.adapter);await this.ctx.config.init();await this.ctx.sales.restoreOpenDraftSales();}
  get provider(){return this.adapter.provider;}
  schemaVersion(){return this.lock.run(()=>this.adapter.schemaVersion());}
  // Runs fn alone, with nothing else reading or writing (backup snapshot, restore).
  exclusive(fn){return this.lock.run(fn);}
  // Inside exclusive(): swaps the database under the same store object (after a restore).
  async replaceAdapter(adapter){await this.adapter.close();this.attach(adapter);await this.init();}
  // cart/cartTotalCents are the active open sale: the one the scale is weighing for.
  getState(scale){
    return this.lock.run(async()=>{
      const {sales,config,cash,stock,employees}=this.ctx;const activeSaleId=await sales.activeSaleId();const active=activeSaleId?await sales.getDraftSale(activeSaleId):null;
      return {config:await config.getConfig(),cash:await cash.cashSummary(),openSales:await sales.listDraftSales(),activeSaleId,
        activeSale:active&&{id:active.id,label:active.label,revision:active.revision,created_at:active.created_at,updated_at:active.updated_at,operator_id:active.operator_id},
        cart:active?active.items:[],cartTotalCents:active?active.totalCents:0,products:await stock.listProducts(),employees:await employees.listEmployees(),operator:await employees.operator(),scale:scale.snapshot()};
    });
  }
  close(){return this.lock.run(()=>this.adapter.close());}
}
for(const [service,names] of Object.entries(OPERATIONS))
  for(const name of names)PdvStore.prototype[name]=function(...args){return this.lock.run(()=>this.ctx[service][name](...args));};
module.exports={PdvStore,migrate};
