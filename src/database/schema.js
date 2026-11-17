'use strict';
// The PDV tables, in an order where every reference points to a table listed before it. Used to copy data between
// databases (backup, restore, migration to PostgreSQL) and to check that a backup has the expected structure.
// since: the schema version that created the table (absent: there from the start).
const SCHEMA_VERSION=7;
const TABLES=[
  {name:'settings',key:'k',columns:['k','v']},
  {name:'employees',key:'id',identity:true,columns:['id','uuid','name','active','created_at']},
  {name:'employee_permissions',key:'id',identity:true,since:6,columns:['id','uuid','employee_id','permission','allowed','updated_at','updated_by']},
  {name:'products',key:'id',identity:true,columns:['id','uuid','name','price_cents','stock','active','category','channel','is_favorite']},
  {name:'shifts',key:'id',identity:true,columns:['id','uuid','opened_at','opening_cents','closed_at','counted_cents','expected_cents','difference_cents','opened_by','closed_by','active_draft_id']},
  {name:'cash_events',key:'id',identity:true,columns:['id','uuid','shift_id','kind','amount_cents','note','created_at','operator_id']},
  {name:'sales',key:'id',identity:true,columns:['id','uuid','shift_id','created_at','method','total_cents','operator_id','status','canceled_at','canceled_by','cancel_reason','received_cents','change_cents','draft_sale_id']},
  {name:'sale_items',key:'id',identity:true,columns:['id','sale_id','product_id','kind','label','grams','quantity','unit_cents','total_cents','manual']},
  {name:'draft_sales',key:'id',columns:['id','shift_id','label','status','operator_id','created_at','updated_at','completed_at','revision','sale_id','seq']},
  {name:'draft_sale_items',key:'id',columns:['id','draft_sale_id','product_id','kind','label','grams','quantity','unit_cents','total_cents','manual','scale_capture_id','created_at','seq']},
  {name:'shift_reconciliations',key:'id',identity:true,since:7,columns:['id','uuid','shift_id','revision','status','is_current','idempotency_key','created_at','confirmed_at','confirmed_by_employee_id','confirmed_by_uuid','confirmed_by_name','confirmed_by_kind','corrected_from_id','reopened_at','reopened_by','reopen_reason','correction_reason','corrected_by','opening_cents','cash_sales_cents','supplies_cents','withdrawals_cents','revenue_cents','sales_count','canceled_count','total_counted_cents','total_expected_cents','total_difference_cents']},
  {name:'shift_reconciliation_items',key:'id',identity:true,since:7,columns:['id','uuid','reconciliation_id','method','counted_cents','expected_cents','difference_cents']},
  {name:'draft_sale_events',key:'id',identity:true,columns:['id','uuid','draft_sale_id','kind','detail','operator_id','created_at']}
];
const TABLE_NAMES=TABLES.map(t=>t.name);
// The tables a database of that schema version has.
const tablesAt=version=>TABLES.filter(t=>(t.since||0)<=version);
module.exports={SCHEMA_VERSION,TABLES,TABLE_NAMES,tablesAt};
