'use strict';
// What a database holds, in numbers a person can check: rows per table and the business totals (sales, cash, stock,
// open sales). Written into every backup's manifest, shown before a restore, and compared after a migration.
// Portable SQL only, so the same summary is computed on SQLite and on PostgreSQL.
const {TABLES}=require('./schema');
const n=v=>Number(v||0);
async function summarize(q){
  const tables=await existing(q);const counts={};
  for(const t of TABLES)if(tables.has(t.name))counts[t.name]=n((await q.get(`SELECT COUNT(*) AS n FROM ${t.name}`))?.n);
  const one=async(sql,p=[])=>tables.has(sql.match(/FROM (\w+)/)[1])?(await q.get(sql,p))||{}:{};
  const sales=await one("SELECT SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceled,SUM(CASE WHEN status='done' THEN total_cents ELSE 0 END) AS cents,MAX(created_at) AS last FROM sales");
  const shifts=await one('SELECT COUNT(*) AS total,SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open FROM shifts');
  const cash=await one("SELECT SUM(CASE WHEN kind='supply' THEN amount_cents ELSE 0 END) AS supply,SUM(CASE WHEN kind='withdrawal' THEN amount_cents ELSE 0 END) AS withdrawal FROM cash_events");
  const drafts=tables.has('draft_sales')?await one("SELECT COUNT(*) AS n FROM draft_sales WHERE status='open'"):{};
  const draftItems=tables.has('draft_sale_items')&&tables.has('draft_sales')?(await q.get("SELECT COUNT(*) AS n FROM draft_sale_items WHERE draft_sale_id IN (SELECT id FROM draft_sales WHERE status='open')"))||{}:{};
  const products=await one('SELECT SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN active=1 THEN stock ELSE 0 END) AS stock FROM products');
  const employees=await one('SELECT SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active FROM employees');
  return {counts,
    sales:{done:n(sales.done),canceled:n(sales.canceled),doneCents:n(sales.cents),lastAt:sales.last?new Date(sales.last).toISOString():null},
    shifts:{total:n(shifts.total),open:n(shifts.open)},
    cash:{supplyCents:n(cash.supply),withdrawalCents:n(cash.withdrawal)},
    openSales:{sales:n(drafts.n),items:n(draftItems.n)},
    products:{active:n(products.active),stock:n(products.stock)},
    employees:{active:n(employees.active)}};
}
async function existing(q){
  const names=q.dialect==='postgres'
    ?(await q.all("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()")).map(r=>r.name)
    :(await q.all("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>r.name);
  return new Set(names);
}
module.exports={summarize};
