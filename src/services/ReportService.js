'use strict';
const {assert,DAY_MS,localDay,dateRangeToday,parseDay,fmtDay,addDays,periodRange,inRange,emptyMethods}=require('./util');
// Sales history and the day, week and month reports, on the store's calendar (America/Sao_Paulo).
class ReportService {
  constructor(ctx){this.ctx=ctx;}
  salesBetween(from,to){return this.ctx.r.sales.listSales('s.created_at>=? AND s.created_at<?',[addDays(from,-1),addDays(to,2)]).then(rows=>inRange(rows,from,to));}
  async salesHistory(filter={}){
    if(filter.q){const n=Number(String(filter.q).trim().replace(/^#/,''));assert(Number.isSafeInteger(n)&&n>0,'Número da venda inválido');return {q:n,sales:await this.ctx.r.sales.listSales('s.id=?',[n])};}
    const from=filter.from||dateRangeToday(),to=filter.to||from;
    assert(parseDay(from)<=parseDay(to),'Data inicial depois da final');assert(parseDay(to)-parseDay(from)<=366*DAY_MS,'Período máximo de um ano');
    let sales=await this.salesBetween(from,to);
    if(filter.status==='done'||filter.status==='canceled')sales=sales.filter(x=>x.status===filter.status);
    return {from,to,sales:sales.slice(0,500)};
  }
  async report(options={}){
    const r=this.ctx.r;const period=options.period||'day',date=options.date||dateRangeToday();const {from,to}=periodRange(period,date);
    const sales=await this.salesBetween(from,to);const done=sales.filter(x=>x.status==='done'),canceled=sales.filter(x=>x.status!=='done');
    const sum=rows=>rows.reduce((s,x)=>s+x.total_cents,0);
    const methods=emptyMethods();for(const x of done)methods[x.method]+=x.total_cents;
    const doneIds=new Set(done.map(x=>x.id));
    const items=(await r.sales.doneItemsBetween(addDays(from,-1),addDays(to,2))).filter(x=>doneIds.has(x.sale_id));
    const manual=items.filter(x=>x.manual);
    const byDay=new Map();for(let t=parseDay(from);t<=parseDay(to);t+=DAY_MS)byDay.set(fmtDay(t),{day:fmtDay(t),totalCents:0,count:0});
    const byOperator=new Map();
    for(const x of done){
      const day=byDay.get(localDay(new Date(x.created_at)));day.totalCents+=x.total_cents;day.count++;
      const name=x.operator_name||'Não identificado';const op=byOperator.get(name)||{name,totalCents:0,count:0};op.totalCents+=x.total_cents;op.count++;byOperator.set(name,op);
    }
    const shifts=inRange(await r.cash.shiftsOpenedBetween(addDays(from,-1),addDays(to,2)),from,to,'opened_at');
    const totalCents=sum(done);
    return {period,date,from,to,today:dateRangeToday(),totalCents,count:done.length,avgTicketCents:done.length?Math.round(totalCents/done.length):0,
      grams:items.filter(x=>x.kind==='weight').reduce((s,x)=>s+(x.grams||0),0),methods,
      canceled:{count:canceled.length,totalCents:sum(canceled)},manual:{count:manual.length,totalCents:sum(manual)},
      byDay:[...byDay.values()],byOperator:[...byOperator.values()].sort((a,b)=>b.totalCents-a.totalCents),sales,shifts};
  }
}
module.exports={ReportService};
