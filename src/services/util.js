'use strict';
// Rules shared by the services: validation, dates on the store's calendar and small formatting helpers.
const DAY_MS=86400000;
function now(){return new Date().toISOString();}
function assert(condition,msg){if(!condition)throw Error(msg);}
function integer(v,name,min=0,max=1000000){const n=Number(v);assert(Number.isSafeInteger(n)&&n>=min&&n<=max,`${name} inválido`);return n;}
const TIMEZONE=()=>(typeof process!=='undefined'&&process.env&&process.env.LUMINOR_TIMEZONE)||'America/Sao_Paulo';
const localDay=d=>new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE(),year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
function dateRangeToday(){return localDay(new Date());}
// Calendar math on YYYY-MM-DD strings, independent of the server timezone.
function parseDay(s){const t=/^\d{4}-\d{2}-\d{2}$/.test(String(s))?Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10)):NaN;assert(!Number.isNaN(t)&&new Date(t).toISOString().slice(0,10)===s,'Data inválida');return t;}
function fmtDay(t){return new Date(t).toISOString().slice(0,10);}
function addDays(s,n){return fmtDay(parseDay(s)+n*DAY_MS);}
function periodRange(period,date){
  const t=parseDay(date),d=new Date(t);
  if(period==='day')return {from:date,to:date};
  if(period==='week'){const from=fmtDay(t-((d.getUTCDay()+6)%7)*DAY_MS);return {from,to:addDays(from,6)};}
  if(period==='month')return {from:fmtDay(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)),to:fmtDay(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0))};
  throw Error('Período inválido');
}
// UTC timestamps are fetched with a one-day margin and then filtered by local calendar day.
function inRange(rows,from,to,field='created_at'){return rows.filter(x=>{const d=localDay(new Date(x[field]));return d>=from&&d<=to;});}
const emptyMethods=()=>({cash:0,pix:0,debit:0,credit:0});
const pad2=n=>String(n).padStart(2,'0');
const sameName=(a,b)=>a.toLocaleLowerCase('pt-BR')===b.toLocaleLowerCase('pt-BR');
// Names are ordered here rather than in SQL, so SQLite and PostgreSQL list them the same way.
const byName=(a,b)=>a.name.localeCompare(b.name,'pt-BR',{sensitivity:'base'})||a.id-b.id;
module.exports={DAY_MS,now,assert,integer,localDay,dateRangeToday,parseDay,fmtDay,addDays,periodRange,inRange,emptyMethods,pad2,sameName,byName};
