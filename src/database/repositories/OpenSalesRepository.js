'use strict';
// Open sales (one tab per customer being served), their items and the log of what happened to them.
// seq keeps the order things were created in; it replaces SQLite's rowid, which PostgreSQL does not have.
const NEXT_SEQ=table=>`(SELECT COALESCE(MAX(seq),0)+1 FROM ${table})`;
class OpenSalesRepository {
  constructor(q){this.q=q;}
  find(id){return this.q.get('SELECT * FROM draft_sales WHERE id=?',[String(id??'')]);}
  listOpen(shiftId){
    return this.q.all(`SELECT d.id,d.label,d.revision,d.created_at,d.updated_at,d.operator_id,e.name AS operator_name,
      (SELECT COUNT(*) FROM draft_sale_items i WHERE i.draft_sale_id=d.id) AS item_count,(SELECT COALESCE(SUM(total_cents),0) FROM draft_sale_items i WHERE i.draft_sale_id=d.id) AS total_cents
      FROM draft_sales d LEFT JOIN employees e ON e.id=d.operator_id WHERE d.status='open' AND d.shift_id=? ORDER BY d.seq`,[shiftId]);
  }
  async countForShift(shiftId){return (await this.q.get('SELECT COUNT(*) AS n FROM draft_sales WHERE shift_id=?',[shiftId])).n;}
  create({id,shiftId,label,operatorId,at}){return this.q.run(`INSERT INTO draft_sales(id,shift_id,label,operator_id,created_at,updated_at,seq) VALUES(?,?,?,?,?,?,${NEXT_SEQ('draft_sales')})`,[id,shiftId,label,operatorId,at,at]);}
  // The newest open sale nobody has touched yet (revision 0).
  freshest(shiftId){return this.q.get("SELECT id FROM draft_sales WHERE shift_id=? AND status='open' AND revision=0 ORDER BY seq DESC LIMIT 1",[shiftId]);}
  touch(id,at){return this.q.run('UPDATE draft_sales SET revision=revision+1,updated_at=? WHERE id=?',[at,id]);}
  rename(id,label){return this.q.run('UPDATE draft_sales SET label=? WHERE id=?',[label,id]);}
  discard(id,at){return this.q.run("UPDATE draft_sales SET status='discarded',completed_at=?,updated_at=? WHERE id=?",[at,at,id]);}
  discardOpenOfShift(shiftId,at){return this.q.run("UPDATE draft_sales SET status='discarded',completed_at=?,updated_at=? WHERE shift_id=? AND status='open'",[at,at,shiftId]);}
  // Empty sales left open by a shift that is no longer open (crash before closing): nothing to keep.
  discardEmptyOrphans(at){return this.q.run("UPDATE draft_sales SET status='discarded',completed_at=? WHERE status='open' AND shift_id NOT IN (SELECT id FROM shifts WHERE closed_at IS NULL) AND NOT EXISTS (SELECT 1 FROM draft_sale_items i WHERE i.draft_sale_id=draft_sales.id)",[at]);}
  async complete(id,{at,saleId}){return (await this.q.run("UPDATE draft_sales SET status='completed',completed_at=?,updated_at=?,sale_id=? WHERE id=? AND status='open'",[at,at,saleId,id])).changes===1;}
  items(id){return this.q.all('SELECT * FROM draft_sale_items WHERE draft_sale_id=? ORDER BY seq',[id]);}
  item(itemId){return this.q.get('SELECT * FROM draft_sale_items WHERE id=?',[String(itemId??'')]);}
  unitLine(saleId,productId){return this.q.get("SELECT * FROM draft_sale_items WHERE draft_sale_id=? AND kind='unit' AND product_id=?",[saleId,productId]);}
  captureExists(captureId){return this.q.get('SELECT 1 AS x FROM draft_sale_items WHERE scale_capture_id=?',[captureId]);}
  addItem(saleId,x){
    return this.q.run(`INSERT INTO draft_sale_items(id,draft_sale_id,product_id,kind,label,grams,quantity,unit_cents,total_cents,manual,scale_capture_id,created_at,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,${NEXT_SEQ('draft_sale_items')})`,
      [x.id,saleId,x.productId??null,x.kind,x.label,x.grams??null,x.quantity??null,x.unitCents,x.totalCents,x.manual?1:0,x.captureId??null,x.at]);
  }
  setQuantity(itemId,quantity,totalCents){return this.q.run('UPDATE draft_sale_items SET quantity=?,total_cents=? WHERE id=?',[quantity,totalCents,itemId]);}
  removeItem(itemId){return this.q.run('DELETE FROM draft_sale_items WHERE id=?',[itemId]);}
  moveItem(itemId,toId){return this.q.run('UPDATE draft_sale_items SET draft_sale_id=? WHERE id=?',[toId,itemId]);}
  log({id,uuid,kind,detail,operatorId,at}){return this.q.run('INSERT INTO draft_sale_events(uuid,draft_sale_id,kind,detail,operator_id,created_at) VALUES(?,?,?,?,?,?)',[uuid,id,kind,JSON.stringify(detail),operatorId,at]);}
  events(id){return this.q.all('SELECT e.id,e.draft_sale_id,e.kind,e.detail,e.operator_id,e.created_at,o.name AS operator_name FROM draft_sale_events e LEFT JOIN employees o ON o.id=e.operator_id WHERE e.draft_sale_id=? ORDER BY e.id',[String(id??'')]);}
}
module.exports={OpenSalesRepository};
