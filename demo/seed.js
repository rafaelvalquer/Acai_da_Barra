'use strict';
// Example data for the online demo: six weeks of closed shifts plus today's open shift.
// Dates are relative to the build day; the browser moves them forward to the visitor's day.
const {randomUUID}=require('node:crypto');
const {Store}=require('../src/db');

const ZONE_OFFSET_H=3; // America/Sao_Paulo is UTC-3 all year.
const DAYS=42;
const localToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

function seed(filename){
  const s=new Store(filename);
  let state=20261103;const rnd=()=>{state=(state*1103515245+12345)%2147483648;return state/2147483648;};
  const pick=a=>a[Math.floor(rnd()*a.length)];const between=(a,b)=>a+Math.floor(rnd()*(b-a+1));
  const brl=c=>(c/100).toFixed(2).replace('.',',');
  const upd=(sql,...a)=>s.db.prepare(sql).run(...a);
  const today=localToday();const base=Date.UTC(+today.slice(0,4),+today.slice(5,7)-1,+today.slice(8,10));
  const at=(offset,h,min)=>new Date(base+offset*86400000+(h+ZONE_OFFSET_H)*3600000+min*60000).toISOString();

  const ops=['Ana Paula','Bruno Lima','Carla Souza','Diego Martins'].map(name=>s.saveEmployee({name}).id);
  const prods=[['Água sem gás','5,00'],['Refrigerante lata','7,00'],['Água de coco','8,00'],['Adicional de cobertura','4,00']].map(([name,price])=>s.product({name,price,stock:9999}).id);
  const method=()=>{const r=rnd();return r<.47?'pix':r<.67?'debit':r<.84?'credit':'cash';};
  const reasons=['Cliente desistiu','Forma de pagamento errada','Cliente trocou o pedido'];

  function day(offset,{count,firstHour=12,lastHour=21,op,close=true,cancel=rnd()<.55,sangria}){
    const dow=new Date(base+offset*86400000).getUTCDay();op=op||ops[(offset+dow+DAYS)%ops.length];
    s.setOperator(op);s.openShift('150,00',op);const shiftId=s.shift().id;
    upd('UPDATE shifts SET opened_at=? WHERE id=?',at(offset,firstHour-1,30),shiftId);
    const ids=[];
    for(let i=0;i<count;i++){
      for(let c=rnd()<.22?2:1;c>0;c--){if(rnd()<.05)s.addManualWeight('0,'+String(between(30,75)*10).padStart(3,'0'));else s.addWeighed(between(26,82)*10);}
      if(rnd()<.33)s.addManual(pick(prods),rnd()<.8?1:2);
      ids.push(s.checkout(method(),randomUUID()).sale.id);
    }
    const span=(lastHour-firstHour)*60+50;
    ids.forEach((id,i)=>{const t=Math.floor((i+rnd()*.8)*span/ids.length);upd('UPDATE sales SET created_at=? WHERE id=?',at(offset,firstHour+Math.floor(t/60),t%60),id);});
    if(cancel&&ids.length>6){const id=ids[between(2,ids.length-2)];s.cancelSale(id,pick(reasons));
      const t=s.db.prepare('SELECT created_at FROM sales WHERE id=?').get(id).created_at;upd('UPDATE sales SET canceled_at=? WHERE id=?',new Date(Date.parse(t)+4*60000).toISOString(),id);}
    const cash=s.cashSummary().expectedCents;const out=sangria||(cash>35000?Math.floor((cash-15000)/5000)*5000:0);
    if(out){s.moveCash('withdrawal',brl(out),'Retirada para o cofre');upd('UPDATE cash_events SET created_at=? WHERE shift_id=?',at(offset,close?17:firstHour+1,40),shiftId);}
    if(!close)return;
    const diff=rnd()<.7?0:pick([-250,-100,-50,100,200]);
    s.closeShift(brl(s.cashSummary().expectedCents+diff));upd('UPDATE shifts SET closed_at=? WHERE id=?',at(offset,22,between(2,14)),shiftId);
  }
  const volume=[52,30,33,36,38,46,64]; // Sun..Sat
  for(let offset=-DAYS;offset<0;offset++){const dow=new Date(base+offset*86400000).getUTCDay();day(offset,{count:Math.round(volume[dow]*(.85+rnd()*.3))});}
  // Today: the shift is open with a few sales, so the visitor can weigh right away.
  day(0,{count:9,firstHour:12,lastHour:13,op:ops[0],close:false,cancel:true,sangria:5000});
  for(const [id,stock] of prods.map((id,i)=>[id,[38,24,11,57][i]]))upd('UPDATE products SET stock=? WHERE id=?',stock,id);
  s.setOperator(ops[0]);
  s.db.prepare('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)').run('demo_seed_day',today);
  // sql.js opens plain database files; leave WAL so the bytes are self-contained.
  s.db.exec('PRAGMA journal_mode=DELETE');
  s.close();
  return today;
}
module.exports={seed};
