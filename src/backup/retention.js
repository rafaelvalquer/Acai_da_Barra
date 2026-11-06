'use strict';
// Which automatic backups to keep: the newest of each of the last 7 days, of the last 4 weeks and of the last 3 months
// (grandfather-father-son). Weeks start on Monday. Everything else can be deleted. Entries are {name, day} with day
// the store-calendar date (YYYY-MM-DD) the backup was made; names sort in time order.
const isoWeek=day=>{
  const t=Date.UTC(+day.slice(0,4),+day.slice(5,7)-1,+day.slice(8,10));const d=new Date(t);const dow=(d.getUTCDay()+6)%7;
  const thursday=new Date(t-dow*86400000+3*86400000);const year=thursday.getUTCFullYear();
  const week=1+Math.floor((thursday-Date.UTC(year,0,1))/86400000/7);return `${year}-W${String(week).padStart(2,'0')}`;
};
function selectToKeep(entries,{daily=7,weekly=4,monthly=3}={}){
  const sorted=[...entries].sort((a,b)=>b.name.localeCompare(a.name));const keep=new Set();
  const pick=(bucketOf,limit)=>{const seen=new Set();for(const e of sorted){const b=bucketOf(e.day);if(seen.has(b))continue;if(seen.size>=limit)break;seen.add(b);keep.add(e.name);}};
  pick(day=>day,daily);pick(isoWeek,weekly);pick(day=>day.slice(0,7),monthly);
  return keep;
}
module.exports={selectToKeep,isoWeek};
