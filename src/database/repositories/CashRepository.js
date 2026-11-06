'use strict';
const {randomUUID}=require('node:crypto');
class CashRepository {
  constructor(q){this.q=q;}
  openShift(){return this.q.get('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');}
  async insertShift({openedAt,openingCents,openedBy}){return (await this.q.get('INSERT INTO shifts(uuid,opened_at,opening_cents,opened_by) VALUES(?,?,?,?) RETURNING id',[randomUUID(),openedAt,openingCents,openedBy])).id;}
  setActiveDraft(shiftId,draftId){return this.q.run('UPDATE shifts SET active_draft_id=? WHERE id=?',[draftId,shiftId]);}
  close(id,{closedAt,countedCents,expectedCents,closedBy}){return this.q.run('UPDATE shifts SET closed_at=?,counted_cents=?,expected_cents=?,difference_cents=?,closed_by=?,active_draft_id=NULL WHERE id=?',[closedAt,countedCents,expectedCents,countedCents-expectedCents,closedBy,id]);}
  insertEvent({shiftId,kind,amountCents,note,createdAt,operatorId}){return this.q.run('INSERT INTO cash_events(uuid,shift_id,kind,amount_cents,note,created_at,operator_id) VALUES(?,?,?,?,?,?,?)',[randomUUID(),shiftId,kind,amountCents,note,createdAt,operatorId]);}
  salesByMethod(shiftId){return this.q.all('SELECT method,status,COUNT(*) AS n,COALESCE(SUM(total_cents),0) AS amount FROM sales WHERE shift_id=? GROUP BY method,status',[shiftId]);}
  async moved(shiftId,kind){return (await this.q.get('SELECT COALESCE(SUM(amount_cents),0) AS amount FROM cash_events WHERE shift_id=? AND kind=?',[shiftId,kind])).amount;}
  events(shiftId){return this.q.all('SELECT c.id,c.shift_id,c.kind,c.amount_cents,c.note,c.created_at,c.operator_id,e.name AS operator_name FROM cash_events c LEFT JOIN employees e ON e.id=c.operator_id WHERE c.shift_id=? ORDER BY c.id DESC LIMIT 80',[shiftId]);}
  shiftsOpenedBetween(from,to){return this.q.all('SELECT sh.*,o.name AS opened_by_name,c.name AS closed_by_name FROM shifts sh LEFT JOIN employees o ON o.id=sh.opened_by LEFT JOIN employees c ON c.id=sh.closed_by WHERE sh.opened_at>=? AND sh.opened_at<? ORDER BY sh.id DESC',[from,to]);}
}
module.exports={CashRepository};
