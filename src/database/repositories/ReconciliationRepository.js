'use strict';
const {randomUUID}=require('node:crypto');
// The full count of a shift's close (shift_reconciliations and its four items, one per payment method). A revision is
// never rewritten: the only columns that change after it is saved are the ones that say whether it is the current one
// and that it was reopened. The values (counted, expected, difference) have no update here on purpose.
const HEADER=`r.id,r.uuid,r.shift_id,r.revision,r.status,r.is_current,r.idempotency_key,r.created_at,r.confirmed_at,r.confirmed_by_employee_id,r.confirmed_by_uuid,r.confirmed_by_name,r.confirmed_by_kind,
  r.corrected_from_id,r.reopened_at,r.reopened_by,r.reopen_reason,r.correction_reason,r.corrected_by,r.opening_cents,r.cash_sales_cents,r.supplies_cents,r.withdrawals_cents,r.revenue_cents,r.sales_count,r.canceled_count,
  r.total_counted_cents,r.total_expected_cents,r.total_difference_cents`;
class ReconciliationRepository {
  constructor(q){this.q=q;}
  byKey(key){return this.q.get(`SELECT ${HEADER} FROM shift_reconciliations r WHERE r.idempotency_key=?`,[key]);}
  byId(id){return this.q.get(`SELECT ${HEADER} FROM shift_reconciliations r WHERE r.id=?`,[id]);}
  current(shiftId){return this.q.get(`SELECT ${HEADER} FROM shift_reconciliations r WHERE r.shift_id=? AND r.is_current=1`,[shiftId]);}
  revision(shiftId,revision){return this.q.get(`SELECT ${HEADER} FROM shift_reconciliations r WHERE r.shift_id=? AND r.revision=?`,[shiftId,revision]);}
  revisions(shiftId){return this.q.all(`SELECT ${HEADER} FROM shift_reconciliations r WHERE r.shift_id=? ORDER BY r.revision`,[shiftId]);}
  items(reconciliationId){return this.q.all('SELECT id,uuid,reconciliation_id,method,counted_cents,expected_cents,difference_cents FROM shift_reconciliation_items WHERE reconciliation_id=? ORDER BY id',[reconciliationId]);}
  async insert(h){
    return (await this.q.get(`INSERT INTO shift_reconciliations(uuid,shift_id,revision,status,is_current,idempotency_key,created_at,confirmed_at,confirmed_by_employee_id,confirmed_by_uuid,confirmed_by_name,confirmed_by_kind,
      corrected_from_id,correction_reason,corrected_by,opening_cents,cash_sales_cents,supplies_cents,withdrawals_cents,revenue_cents,sales_count,canceled_count,total_counted_cents,total_expected_cents,total_difference_cents)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [randomUUID(),h.shiftId,h.revision,h.status,h.isCurrent?1:0,h.idempotencyKey,h.createdAt,h.confirmedAt,h.confirmedByEmployeeId??null,h.confirmedByUuid??null,h.confirmedByName,h.confirmedByKind,
        h.correctedFromId??null,h.correctionReason??null,h.correctedBy??null,h.openingCents,h.cashSalesCents,h.suppliesCents,h.withdrawalsCents,h.revenueCents,h.salesCount,h.canceledCount,
        h.totalCountedCents,h.totalExpectedCents,h.totalDifferenceCents])).id;
  }
  insertItem(reconciliationId,{method,countedCents,expectedCents}){
    return this.q.run('INSERT INTO shift_reconciliation_items(uuid,reconciliation_id,method,counted_cents,expected_cents,difference_cents) VALUES(?,?,?,?,?,?)',
      [randomUUID(),reconciliationId,method,countedCents,expectedCents,countedCents-expectedCents]);
  }
  setCurrent(id,current){return this.q.run('UPDATE shift_reconciliations SET is_current=? WHERE id=?',[current?1:0,id]);}
  // Only a confirmed, current revision can be reopened (the WHERE makes two administrators' clicks a single reopening).
  async reopen(id,{at,by,reason}){return (await this.q.run("UPDATE shift_reconciliations SET status='REOPENED',reopened_at=?,reopened_by=?,reopen_reason=? WHERE id=? AND status='CONFIRMED' AND is_current=1",[at,by,reason,id])).changes;}
  // The closes of the shifts, newest first: the current revision of each (employeeId: only what that person closed).
  list({employeeId=null,limit=60}={}){
    const where=employeeId?'WHERE r.is_current=1 AND sh.closed_by=?':'WHERE r.is_current=1';
    return this.q.all(`SELECT ${HEADER},sh.opened_at,sh.closed_at,sh.opened_by,o.name AS opened_by_name FROM shift_reconciliations r JOIN shifts sh ON sh.id=r.shift_id LEFT JOIN employees o ON o.id=sh.opened_by ${where} ORDER BY r.shift_id DESC LIMIT ${Math.min(Math.max(Number(limit)||60,1),200)}`,employeeId?[employeeId]:[]);
  }
  shift(id){return this.q.get('SELECT sh.*,o.name AS opened_by_name,c.name AS closed_by_name FROM shifts sh LEFT JOIN employees o ON o.id=sh.opened_by LEFT JOIN employees c ON c.id=sh.closed_by WHERE sh.id=?',[id]);}
  // The shifts closed before the full count existed: only one value was counted.
  legacyList(limit=60){return this.q.all(`SELECT sh.*,o.name AS opened_by_name,c.name AS closed_by_name FROM shifts sh LEFT JOIN employees o ON o.id=sh.opened_by LEFT JOIN employees c ON c.id=sh.closed_by
    WHERE sh.closed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shift_reconciliations r WHERE r.shift_id=sh.id) ORDER BY sh.id DESC LIMIT ${Math.min(Math.max(Number(limit)||60,1),200)}`);}
}
module.exports={ReconciliationRepository};
