'use strict';
const {randomUUID}=require('node:crypto');
// Units sitting in open sales are reserved: the stock itself only drops when a sale is paid.
const RESERVED="(SELECT COALESCE(SUM(i.quantity),0) FROM draft_sale_items i JOIN draft_sales d ON d.id=i.draft_sale_id WHERE d.status='open' AND i.kind='unit' AND i.product_id=p.id)";
class ProductsRepository {
  constructor(q){this.q=q;}
  listActive(){return this.q.all(`SELECT p.id,p.name,p.price_cents,p.stock,p.active,p.category,p.channel,p.is_favorite,${RESERVED} AS reserved FROM products p WHERE p.active=1`);}
  findActive(id){return this.q.get('SELECT id,name,price_cents,stock,active FROM products WHERE id=? AND active=1',[id]);}
  exists(id){return this.q.get('SELECT id FROM products WHERE id=?',[id]);}
  find(id){return this.q.get('SELECT id,name,category,channel,is_favorite FROM products WHERE id=?',[id]);}
  async insert({name,priceCents,stock,category,channel,favorite}){return (await this.q.get('INSERT INTO products(uuid,name,price_cents,stock,category,channel,is_favorite) VALUES(?,?,?,?,?,?,?) RETURNING id',[randomUUID(),name,priceCents,stock,category,channel,favorite])).id;}
  update(id,{name,priceCents,stock,category,channel,favorite}){return this.q.run('UPDATE products SET name=?,price_cents=?,stock=?,category=?,channel=?,is_favorite=?,active=1 WHERE id=?',[name,priceCents,stock,category,channel,favorite,id]);}
  setFavorite(id,favorite){return this.q.run('UPDATE products SET is_favorite=? WHERE id=? AND active=1',[favorite,id]);}
  deactivate(id){return this.q.run('UPDATE products SET active=0 WHERE id=?',[id]);}
  async reserved(productId,exceptItem=''){return (await this.q.get("SELECT COALESCE(SUM(i.quantity),0) AS n FROM draft_sale_items i JOIN draft_sales d ON d.id=i.draft_sale_id WHERE d.status='open' AND i.kind='unit' AND i.product_id=? AND i.id<>?",[productId,exceptItem])).n;}
  // Only succeeds while there is enough stock: the check and the update are one statement.
  async takeStock(id,quantity){return (await this.q.run('UPDATE products SET stock=stock-? WHERE id=? AND active=1 AND stock>=?',[quantity,id,quantity])).changes===1;}
  returnStock(id,quantity){return this.q.run('UPDATE products SET stock=stock+? WHERE id=?',[quantity,id]);}
}
module.exports={ProductsRepository};
