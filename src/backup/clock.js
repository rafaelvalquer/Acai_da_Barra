'use strict';
// Store-calendar time for backups: file names and the daily schedule follow the store's clock
// (LUMINOR_TIMEZONE, default America/Sao_Paulo), whatever the computer's own time zone.
const TIMEZONE=()=>process.env.LUMINOR_TIMEZONE||'America/Sao_Paulo';
function parts(date){
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:TIMEZONE(),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const o={};for(const p of f.formatToParts(date))o[p.type]=p.value;
  return {day:`${o.year}-${o.month}-${o.day}`,time:`${o.hour}:${o.minute}:${o.second}`};
}
// 2026-11-06_14-03-59: sorts in time order and is valid in Windows file names.
function stamp(date){const p=parts(date);return `${p.day}_${p.time.replace(/:/g,'-')}`;}
// Offset of the store's zone from UTC at a given instant, in milliseconds.
function offsetAt(t){const p=parts(new Date(t));const asUtc=Date.UTC(+p.day.slice(0,4),+p.day.slice(5,7)-1,+p.day.slice(8,10),+p.time.slice(0,2),+p.time.slice(3,5),+p.time.slice(6,8));return asUtc-Math.floor(t/1000)*1000;}
// The instant when the store's clock shows `hhmm` on `day` (YYYY-MM-DD).
function instantOf(day,hhmm){
  const guess=Date.UTC(+day.slice(0,4),+day.slice(5,7)-1,+day.slice(8,10),+hhmm.slice(0,2),+hhmm.slice(3,5));
  let t=guess-offsetAt(guess);t=guess-offsetAt(t);return t;
}
// The latest scheduled time (today's or yesterday's) that is not after `now`.
function lastScheduled(now,hhmm){
  const today=parts(now).day;let t=instantOf(today,hhmm);
  if(t>now.getTime()){const y=new Date(Date.UTC(+today.slice(0,4),+today.slice(5,7)-1,+today.slice(8,10))-86400000).toISOString().slice(0,10);t=instantOf(y,hhmm);}
  return new Date(t);
}
module.exports={parts,stamp,instantOf,lastScheduled};
