// Runs the PDV server inside the page: /api/* requests go to the same server.js, store and scale.js
// used in the store, over an in-browser SQLite database saved in this browser's localStorage.
const KEY='luminor-pdv-demo';const PORT=3187;const DAY_MS=86400000;
const NO_SERIAL='Na demonstração online a balança é simulada. No computador da loja, a Toledo Prix 3 Fit conecta pela porta serial.';
const localDay=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const dayMs=s=>Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10));
const toBase64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(s);};
const fromBase64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
function readSaved(){try{const raw=localStorage.getItem(KEY);return raw?JSON.parse(raw):null;}catch(_){return null;}}

// Moves the example data so its last day is the visitor's today and nothing in the open shift is in the future.
function moveToToday(db){
  const seedDay=db.prepare("SELECT v FROM settings WHERE k='demo_seed_day'").get()?.v;if(!seedDay)return;
  const shift=(table,cols,amount,where='1=1')=>db.exec(`UPDATE ${table} SET ${cols.map(c=>`${c}=CASE WHEN ${c} IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ',${c},'${amount}') END`).join(',')} WHERE ${where}`);
  const days=Math.round((dayMs(localDay(new Date()))-dayMs(seedDay))/DAY_MS);
  if(days>0)for(const [table,cols] of [['shifts',['opened_at','closed_at']],['sales',['created_at','canceled_at']],['cash_events',['created_at']],['employees',['created_at']],['draft_sales',['created_at','updated_at','completed_at']],['draft_sale_items',['created_at']],['draft_sale_events',['created_at']]])shift(table,cols,`+${days} days`);
  const open=db.prepare('SELECT id FROM shifts WHERE closed_at IS NULL').get();
  if(open){
    const latest=db.prepare('SELECT MAX(t) AS t FROM (SELECT MAX(COALESCE(canceled_at,created_at)) AS t FROM sales WHERE shift_id=? UNION ALL SELECT MAX(created_at) FROM cash_events WHERE shift_id=? UNION ALL SELECT MAX(updated_at) FROM draft_sales WHERE shift_id=?)').get(open.id,open.id,open.id).t;
    const ahead=latest?Math.ceil((Date.parse(latest)-Date.now())/1000)+300:0;
    if(ahead>0){const back=`-${ahead} seconds`;shift('shifts',['opened_at'],back,`id=${open.id}`);shift('sales',['created_at','canceled_at'],back,`shift_id=${open.id}`);shift('cash_events',['created_at'],back,`shift_id=${open.id}`);
      const drafts=`(SELECT id FROM draft_sales WHERE shift_id=${open.id})`;
      shift('draft_sales',['created_at','updated_at','completed_at'],back,`shift_id=${open.id}`);shift('draft_sale_items',['created_at'],back,`draft_sale_id IN ${drafts}`);shift('draft_sale_events',['created_at'],back,`draft_sale_id IN ${drafts}`);}
  }
  db.prepare("DELETE FROM settings WHERE k='demo_seed_day'").run();
}

const backend=(async()=>{
  const SQL=await initSqlJs({locateFile:file=>'/vendor/'+file});
  const DatabaseSync=createDatabaseSync(SQL);
  const require=makeRequire({
    'node:fs':{mkdirSync(){}},
    'node:path':{resolve:()=>'/',join:(...parts)=>parts.join('/'),dirname:p=>p},
    'node:sqlite':{DatabaseSync},
    'node:crypto':{randomUUID:()=>crypto.randomUUID(),randomBytes:n=>{const a=crypto.getRandomValues(new Uint8Array(n));return {toString:()=>Array.from(a,b=>b.toString(16).padStart(2,'0')).join('')};}},
    'node:http':{createServer:handler=>({handler,address:()=>({port:PORT})})}
  });
  const {PdvStore}=require('./store');const {SQLiteAdapter}=require('./database/adapters/SQLiteAdapter');
  const {ScaleDriver}=require('./scale');const {createServer}=require('./server');
  const saved=readSaved();
  DatabaseSync.load=saved?.db?fromBase64(saved.db):new Uint8Array(await (await fetch('/demo-seed.sqlite',{cache:'no-store'})).arrayBuffer());
  const raw=new DatabaseSync();raw.exec('PRAGMA foreign_keys=ON');
  if(!saved)moveToToday(raw);
  const db=await PdvStore.open(new SQLiteAdapter(raw));
  const scale=new ScaleDriver();scale.demo();
  const {handler}=createServer({db,scale});
  const save=()=>{try{localStorage.setItem(KEY,JSON.stringify({db:toBase64(raw.export())}));}catch(_){}};
  if(!saved)save();
  return {save,call:(method,url,headers,body)=>new Promise(resolve=>{
    const res={status:200,writeHead(status){this.status=status;},end(text){resolve({status:this.status,text});}};
    const req={method,url,headers:{...headers,host:`127.0.0.1:${PORT}`},async *[Symbol.asyncIterator](){if(body)yield body;}};
    handler(req,res);
  })};
})();

const json=(status,payload)=>new Response(typeof payload==='string'?payload:JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});
const networkFetch=window.fetch.bind(window);
window.fetch=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url,location.href);
  if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return networkFetch(input,init);
  if(url.pathname==='/api/scale/ports'||url.pathname==='/api/scale/connect')return json(400,{error:NO_SERIAL});
  let api;try{api=await backend;}catch(e){console.error(e);return json(503,{error:'Não foi possível iniciar a demonstração neste navegador.'});}
  const method=(init.method||'GET').toUpperCase();
  const headers={};new Headers(init.headers||{}).forEach((v,k)=>{headers[k]=v;});
  const r=await api.call(method,url.pathname+url.search,headers,typeof init.body==='string'?init.body:'');
  if(method==='POST'&&r.status===200)api.save();
  return json(r.status,r.text);
};

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('demo-reset')?.addEventListener('click',async()=>{
    const go=typeof ask==='function'?await ask('Restaurar os dados de exemplo?','As vendas, funcionários e ajustes feitos nesta demonstração serão apagados deste navegador.',{confirmLabel:'Restaurar',tone:'danger-solid'}):confirm('Restaurar os dados de exemplo?');
    if(!go)return;try{localStorage.removeItem(KEY);}catch(_){}location.reload();
  });
});
