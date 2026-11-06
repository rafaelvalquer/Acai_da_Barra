'use strict';
// What changed in the local database since the last send to the cloud copy. It exists only while the cloud copy is
// on: the table sync_outbox plus, on every PDV table, triggers that note which row changed (table and key). A trigger
// runs inside the same transaction as the change, so a sale that was saved is always noted too, power cut or not.
// The triggers call no function (trusted_schema is off) and copy no data: each row is read as it is when it is sent.
// Backups never carry any of this (BackupManager removes it from its copy), so restoring one sends everything again.
const {TABLES}=require('../database/schema');const {canonical}=require('../database/migration-tools/ExportLocalData');
const OUTBOX='sync_outbox';
const OPS=['insert','update','delete'];
const IN_CHUNK=500;
const triggerName=(table,op)=>`sync_${table}_${op}`;
function triggersSql(){
  return TABLES.map(({name:t,key:k})=>[
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(t,'insert')} AFTER INSERT ON ${t} BEGIN INSERT INTO ${OUTBOX}(tbl,pk) VALUES('${t}',NEW.${k}); END;`,
    // A row whose key changes is sent under the new key and removed under the old one.
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(t,'update')} AFTER UPDATE ON ${t} BEGIN INSERT INTO ${OUTBOX}(tbl,pk) VALUES('${t}',NEW.${k}); INSERT INTO ${OUTBOX}(tbl,pk) SELECT '${t}',OLD.${k} WHERE OLD.${k} IS NOT NEW.${k}; END;`,
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(t,'delete')} AFTER DELETE ON ${t} BEGIN INSERT INTO ${OUTBOX}(tbl,pk) VALUES('${t}',OLD.${k}); END;`
  ].join('\n')).join('\n');
}
async function isInstalled(q){return !!(await q.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='${OUTBOX}'`));}
// pk has no declared type, so each key keeps its own (integer ids, text ids of open sales, setting names).
async function install(q){await q.exec(`CREATE TABLE IF NOT EXISTS ${OUTBOX}(seq INTEGER PRIMARY KEY AUTOINCREMENT,tbl TEXT NOT NULL,pk);\n${triggersSql()}`);}
async function remove(q){await q.exec([...TABLES.flatMap(t=>OPS.map(op=>`DROP TRIGGER IF EXISTS ${triggerName(t.name,op)};`)),`DROP TABLE IF EXISTS ${OUTBOX};`].join('\n'));}
async function lastSeq(q){return (await q.get(`SELECT MAX(seq) AS s FROM ${OUTBOX}`))?.s??0;}
// Everything noted up to now, as the rows are at this moment: rows that exist are written to the cloud, rows that
// are gone are deleted there. Read with the PDV paused (store.exclusive), so it is one consistent moment.
async function readBatch(q){
  const maxSeq=await lastSeq(q);if(!maxSeq)return null;
  const keys=await q.all(`SELECT DISTINCT tbl,pk FROM ${OUTBOX} WHERE seq<=?`,[maxSeq]);
  const byTable=new Map();for(const k of keys){if(!byTable.has(k.tbl))byTable.set(k.tbl,[]);byTable.get(k.tbl).push(k.pk);}
  const tables=[];
  for(const t of TABLES){
    const pks=byTable.get(t.name);if(!pks)continue;const rows=[];
    for(let i=0;i<pks.length;i+=IN_CHUNK){
      const part=pks.slice(i,i+IN_CHUNK);
      rows.push(...await q.all(`SELECT ${t.columns.join(',')} FROM ${t.name} WHERE ${t.key} IN (${part.map(()=>'?').join(',')})`,part));
    }
    const found=new Set(rows.map(r=>String(r[t.key])));
    tables.push({table:t,upserts:rows.map(r=>Object.fromEntries(t.columns.map(c=>[c,canonical(c,r[c])]))),deletes:pks.filter(pk=>!found.has(String(pk)))});
  }
  return {maxSeq,changes:keys.length,tables};
}
// Removes what the cloud already has; anything noted after maxSeq stays for the next send.
async function clear(q,maxSeq){await q.run(`DELETE FROM ${OUTBOX} WHERE seq<=?`,[maxSeq]);}
// What is still waiting: rows changed and, among them, finished sales (what the till shows).
async function pending(q){
  const r=await q.get(`SELECT COUNT(DISTINCT tbl||':'||pk) AS changes,COUNT(DISTINCT CASE WHEN tbl='sales' THEN pk END) AS sales FROM ${OUTBOX}`);
  return {changes:Number(r?.changes||0),sales:Number(r?.sales||0)};
}
module.exports={OUTBOX,install,remove,isInstalled,readBatch,clear,pending,lastSeq};
