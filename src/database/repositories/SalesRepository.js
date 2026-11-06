'use strict';
// Finished sales (paid or canceled) and their items.
class SalesRepository {
  constructor(q){this.q=q;}
  findById(id){return this.q.get('SELECT * FROM sales WHERE id=?',[id]);}
  findByUuid(uuid){return this.q.get('SELECT * FROM sales WHERE uuid=?',[uuid]);}
  findByDraft(draftId){return this.q.get('SELECT * FROM sales WHERE draft_sale_id=?',[draftId]);}
  async createSale(s){
    return (await this.q.get('INSERT INTO sales(uuid,shift_id,created_at,method,total_cents,operator_id,received_cents,change_cents,draft_sale_id) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
      [s.uuid,s.shiftId,s.createdAt,s.method,s.totalCents,s.operatorId,s.receivedCents,s.changeCents,s.draftSaleId])).id;
  }
  addSaleItem(saleId,x){return this.q.run('INSERT INTO sale_items(sale_id,product_id,kind,label,grams,quantity,unit_cents,total_cents,manual) VALUES(?,?,?,?,?,?,?,?,?)',
    [saleId,x.productId??null,x.kind,x.label,x.grams??null,x.quantity??null,x.unitCents,x.totalCents,x.manual?1:0]);}
  items(saleId){return this.q.all('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id',[saleId]);}
  unitItems(saleId){return this.q.all("SELECT product_id,quantity FROM sale_items WHERE sale_id=? AND kind='unit' AND product_id IS NOT NULL",[saleId]);}
  async cancelSale(id,{canceledAt,canceledBy,reason}){return (await this.q.run("UPDATE sales SET status='canceled',canceled_at=?,canceled_by=?,cancel_reason=? WHERE id=? AND status='done'",[canceledAt,canceledBy,reason,id])).changes===1;}
  // where/params come from the service (fixed fragments), never from the request.
  listSales(where,params){
    return this.q.all(`SELECT s.*,e.name AS operator_name,(SELECT COUNT(*) FROM sale_items i WHERE i.sale_id=s.id) AS item_count,(SELECT COALESCE(MAX(manual),0) FROM sale_items i WHERE i.sale_id=s.id) AS has_manual
      FROM sales s LEFT JOIN employees e ON e.id=s.operator_id WHERE ${where} ORDER BY s.id DESC`,params);
  }
  detail(id){return this.q.get('SELECT s.*,e.name AS operator_name,c.name AS canceled_by_name,d.label AS draft_label FROM sales s LEFT JOIN employees e ON e.id=s.operator_id LEFT JOIN employees c ON c.id=s.canceled_by LEFT JOIN draft_sales d ON d.id=s.draft_sale_id WHERE s.id=?',[id]);}
  doneItemsBetween(from,to){return this.q.all("SELECT i.sale_id,i.kind,i.grams,i.manual,i.total_cents FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.status='done' AND s.created_at>=? AND s.created_at<?",[from,to]);}
}
module.exports={SalesRepository};
