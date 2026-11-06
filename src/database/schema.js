'use strict';
// The PDV tables, in an order where every reference points to a table listed before it. Used to copy data between
// databases (backup, restore, migration to PostgreSQL) and to check that a backup has the expected structure.
const SCHEMA_VERSION=4;
const TABLES=[
  {name:'settings',key:'k',columns:['k','v']},
  {name:'employees',key:'id',identity:true,columns:['id','uuid','name','active','created_at']},
  {name:'products',key:'id',identity:true,columns:['id','uuid','name','price_cents','stock','active']},
  {name:'shifts',key:'id',identity:true,columns:['id','uuid','opened_at','opening_cents','closed_at','counted_cents','expected_cents','difference_cents','opened_by','closed_by','active_draft_id']},
  {name:'cash_events',key:'id',identity:true,columns:['id','uuid','shift_id','kind','amount_cents','note','created_at','operator_id']},
  {name:'sales',key:'id',identity:true,columns:['id','uuid','shift_id','created_at','method','total_cents','operator_id','status','canceled_at','canceled_by','cancel_reason','received_cents','change_cents','draft_sale_id']},
  {name:'sale_items',key:'id',identity:true,columns:['id','sale_id','product_id','kind','label','grams','quantity','unit_cents','total_cents','manual']},
  {name:'draft_sales',key:'id',columns:['id','shift_id','label','status','operator_id','created_at','updated_at','completed_at','revision','sale_id','seq']},
  {name:'draft_sale_items',key:'id',columns:['id','draft_sale_id','product_id','kind','label','grams','quantity','unit_cents','total_cents','manual','scale_capture_id','created_at','seq']},
  {name:'draft_sale_events',key:'id',identity:true,columns:['id','uuid','draft_sale_id','kind','detail','operator_id','created_at']}
];
const TABLE_NAMES=TABLES.map(t=>t.name);
module.exports={SCHEMA_VERSION,TABLES,TABLE_NAMES};
