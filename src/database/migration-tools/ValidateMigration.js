'use strict';
// Step 3, mandatory: reconciles the copy with the original. Every table must have the same number of rows and the
// same content (row by row, compared through a SHA-256 of the canonical values), and the business totals (sales,
// cash, stock, open sales) must match. Any difference fails the migration and is listed in the report.
const crypto=require('node:crypto');
const {TABLES}=require('../schema');const {readTable}=require('./ExportLocalData');const {summarize}=require('../summary');
const digest=rows=>crypto.createHash('sha256').update(rows.map(r=>JSON.stringify(r)).join('\n')).digest('hex');
function firstDifference(a,b,key){
  const byKey=new Map(b.map(r=>[String(r[key]),r]));
  for(const r of a){const o=byKey.get(String(r[key]));if(!o)return {key:r[key],problem:'falta no destino'};
    for(const c of Object.keys(r))if(JSON.stringify(r[c])!==JSON.stringify(o[c]))return {key:r[key],column:c,source:r[c],target:o[c]};}
  return a.length!==b.length?{problem:'linhas a mais no destino'}:null;
}
function flatten(o,prefix='',out={}){for(const [k,v] of Object.entries(o||{}))if(v&&typeof v==='object')flatten(v,prefix+k+'.',out);else out[prefix+k]=v;return out;}
async function validateMigration(source,target,{skip=[]}={}){
  const tables=[];
  for(const t of TABLES.filter(t=>!skip.includes(t.name))){
    const a=await readTable(source,t),b=await readTable(target,t);const ha=digest(a),hb=digest(b);
    tables.push({table:t.name,source:a.length,target:b.length,ok:a.length===b.length&&ha===hb,sha256:ha,difference:ha===hb?null:firstDifference(a,b,t.key)});
  }
  const sa=flatten(await summarize(source)),sb=flatten(await summarize(target));
  const totals=Object.keys(sa).map(k=>({item:k,source:sa[k],target:sb[k],ok:sa[k]===sb[k]}));
  return {ok:tables.every(t=>t.ok)&&totals.every(t=>t.ok),checkedAt:new Date().toISOString(),tables,totals};
}
module.exports={validateMigration};
