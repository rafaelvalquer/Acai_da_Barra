'use strict';
// The cloud copy (src/sync): the till always sells on the local database, with or without internet, and the cloud
// receives every change by itself, in order, never twice and never half written. The "Supabase" is PGlite.
const test=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const {decodeBackup}=require('../src/backup/BackupFormat');
const {isPostgres,until,wait}=require('./helpers');
const {boot,newHome,ok,setupAdmin,login,openShift,active,sell,closeShift,backup,backupFile,keyOf,restore,salesCount,adminAudit}=require('./app-helpers');
const {confirm,FAST,fakeCloud,connectTest,syncOf,settled,sameAsCloud,withCopy,oldCloudMode}=require('./cloud-helpers');
const SKIP=isPostgres&&'a cópia na nuvem usa o próprio PostgreSQL de teste';
// Time a request takes, in milliseconds.
const timed=async p=>{const t0=Date.now();const r=await p;return {r,ms:Date.now()-t0};};

test('sem internet a venda não para, e tudo chega à nuvem quando ela volta',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud);try{
    await openShift(t);await sell(t,'10,00');await settled(t);assert.equal(await cloud.count('sales'),1);
    cloud.down=true;
    // Weighing, typed value, a product, payment with change, a cash withdrawal: all at local speed.
    ok(await t.post('/api/scale/demo'));
    const steps=[
      ()=>t.post('/api/scale/demo-weight',{grams:486}),()=>t.post('/api/scale/demo-weight',{grams:0}),
      async()=>t.post('/api/cart/manual-value',{saleId:await active(t),amount:'5,00'}),
      async()=>t.post('/api/checkout',{saleId:await active(t),method:'cash',uuid:randomUUID(),received:'50,00'}),
      ()=>t.post('/api/shift/move',{kind:'withdrawal',amount:'10,00',note:'Troco'})];
    for(const step of steps){const {r,ms}=await timed(step());assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(ms<300,`${ms} ms`);}
    await sell(t,'3,00');
    // The till shows that sales are waiting; nothing is lost and nothing reached the cloud yet.
    const badge=async()=>(await t.get('/api/state')).body.system.sync;
    await until(async()=>{const b=await badge();return b.state==='sem-conexao'&&b.pendingSales===2;});assert.ok((await badge()).pendingChanges>2);
    assert.equal(await salesCount(t),3);assert.equal(await cloud.count('sales'),1);
    await closeShift(t);
    cloud.down=false;await settled(t);await sameAsCloud(t,cloud);
    assert.equal((await t.get('/api/state')).body.system.sync.pendingSales,0);
    assert.ok(t.log.lines.some(l=>/conexão restabelecida/.test(l)));
  }finally{await t.stop();}
});

test('com a nuvem sem responder (internet travada) o caixa não espera por ela',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud);try{
    await openShift(t);cloud.hang=1500;
    await sell(t,'4,00');await until(()=>t.app.system.sync.queue.busy>0);// a send is stuck waiting for the cloud
    const saleId=await active(t);
    for(const step of [()=>t.post('/api/cart/manual-value',{saleId,amount:'6,00'}),()=>t.get('/api/state'),()=>t.post('/api/checkout',{saleId,method:'pix',uuid:randomUUID()})]){
      const {r,ms}=await timed(step());assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(ms<300,`${ms} ms`);
    }
    cloud.hang=0;await settled(t);await sameAsCloud(t,cloud);
  }finally{await t.stop();}
});

test('todo tipo de alteração chega à nuvem: inclusão, alteração, exclusão e item trocado de venda',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud);try{
    await openShift(t);
    const water=ok(await t.post('/api/products/save',{name:'Água',price:'4,00',stock:10})).id;
    const a=await active(t);
    ok(await t.post('/api/cart/unit',{saleId:a,id:water,quantity:2}));ok(await t.post('/api/cart/manual-value',{saleId:a,amount:'9,00'}));ok(await t.post('/api/cart/manual-value',{saleId:a,amount:'1,00'}));
    const b=ok(await t.post('/api/open-sales/create')).id;
    let items=(await t.app.db.getDraftSale(a)).items;
    ok(await t.post('/api/open-sales/transfer-item',{saleId:a,key:items[1].key,toSaleId:b}));// moved to another customer
    ok(await t.post('/api/cart/remove',{saleId:a,key:items[2].key}));// deleted
    await settled(t);await sameAsCloud(t,cloud);
    assert.equal(Number((await cloud.db.query('SELECT COUNT(*) AS n FROM draft_sale_items WHERE id=$1',[items[2].key])).rows[0].n),0);
    ok(await t.post('/api/open-sales/select',{saleId:a}));
    const sale=ok(await t.post('/api/checkout',{saleId:a,method:'debit',uuid:randomUUID(),revision:(await t.app.db.getDraftSale(a)).revision})).sale;
    ok(await t.post('/api/sales/cancel',{id:sale.id,reason:'Cliente desistiu'}));
    ok(await t.post('/api/config',{priceKg:'72,90'}));ok(await t.post('/api/products/remove',{id:water}));
    ok(await t.post('/api/open-sales/discard',{saleId:b}));await closeShift(t);
    await settled(t);await sameAsCloud(t,cloud);
    assert.equal((await cloud.db.query('SELECT status FROM sales WHERE id=$1',[sale.id])).rows[0].status,'canceled');
  }finally{await t.stop();}
});

test('uma queda entre a gravação na nuvem e a limpeza aqui não duplica nada',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud);try{
    await openShift(t);
    // The cloud commits, then the power goes before the notes are removed here.
    let cut=false;t.app.db.adapter.onQuery=sql=>{if(!cut&&/DELETE FROM sync_outbox/.test(sql)){cut=true;throw Error('energia caiu');}};
    await sell(t,'12,00');await sell(t,'8,00');
    await until(()=>cut);await settled(t);
    assert.equal(await cloud.count('sales'),2);assert.equal(Number((await cloud.db.query('SELECT COUNT(DISTINCT uuid) AS n FROM sales')).rows[0].n),2);
    await sameAsCloud(t,cloud);
  }finally{await t.stop();}
});

test('uma falha no meio do envio não deixa nada pela metade na nuvem, e o envio seguinte completa',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud);try{
    await openShift(t);await settled(t);const before=await cloud.count('sales');
    cloud.failOn=/INSERT INTO sale_items\b/;// the connection drops after the sales were written, before their items
    await sell(t,'15,00');await until(()=>syncOf(t).state==='sem-conexao');
    assert.equal(await cloud.count('sales'),before);assert.equal(await cloud.count('sale_items'),0);
    cloud.failOn=null;await settled(t);await sameAsCloud(t,cloud);
  }finally{await t.stop();}
});

test('restaurar um backup envia tudo de novo, e os backups não levam o registro de alterações',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud);try{
    await openShift(t);await sell(t,'10,00');await closeShift(t);await settled(t);
    const b=await backup(t);
    // Inside the backup: the PDV's tables only (the validator refuses any trigger).
    const {database}=decodeBackup(backupFile(t,b.name),keyOf(t));const f=path.join(t.home,'tmp','dentro-do-backup.sqlite');fs.writeFileSync(f,database);
    const d=new DatabaseSync(f,{readOnly:true});
    try{assert.deepEqual(d.prepare("SELECT type,name FROM sqlite_master WHERE type='trigger' OR name LIKE 'sync%'").all(),[]);}finally{d.close();}
    await openShift(t,'Bia');await sell(t,'5,00');await sell(t,'6,00');await closeShift(t);await settled(t);assert.equal(await cloud.count('sales'),3);
    const rr=await restore(t,backupFile(t,b.name));ok(await rr.confirm());
    assert.equal(await salesCount(t),1);
    await settled(t);await sameAsCloud(t,cloud);assert.equal(await cloud.count('sales'),1);
    assert.ok((await adminAudit(t)).includes('nuvem_envio_completo'));
    // Selling goes on as before.
    await openShift(t,'Caio');await sell(t,'2,00');await settled(t);await sameAsCloud(t,cloud);
  }finally{await t.stop();}
});

test('outro computador não sobrescreve a cópia na nuvem sem confirmar a substituição',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const a=await withCopy(cloud);let b;try{
    await openShift(a);await sell(a,'10,00');await settled(a);
    b=await boot(newHome(),{connect:cloud.connect,syncTiming:FAST});await setupAdmin(b);ok(await connectTest(b));ok(await b.post('/api/admin/database/prepare',confirm));
    let r=await b.post('/api/admin/database/sync/enable',confirm);
    assert.equal(r.status,409);assert.equal(r.body.needsReplace,true);assert.match(r.body.error,/outro computador/);
    await sameAsCloud(a,cloud);assert.equal(syncOf(b).enabled,false);
    // Confirmed: b takes the cloud over and its data replaces what was there.
    ok(await b.post('/api/admin/database/sync/enable',{...confirm,replace:true}));await settled(b);await sameAsCloud(b,cloud);
    // a keeps selling, keeps everything locally and stops sending, with a clear message.
    await sell(a,'3,00');await until(()=>syncOf(a).state==='outro-dono');
    assert.match(syncOf(a).problem.message,/outro computador/);assert.equal(await salesCount(a),2);await sameAsCloud(b,cloud);
    const ov=(await a.get('/api/admin/overview')).body;assert.equal(ov.sync.state,'outro-dono');
  }finally{await a.stop();await b?.stop();}
});

test('a instalação do modo antigo (vendendo direto na nuvem) passa sozinha para o banco deste computador',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const home=await oldCloudMode(cloud);
  const t=await boot(home,{connect:cloud.connect,syncTiming:FAST});try{
    assert.equal(await t.app.converting,true);
    assert.equal(t.app.db.adapter.dialect,'sqlite');assert.equal((await t.app.system.settings.database()).provider,'sqlite');
    // The sale made on the cloud and the shift still open there came along.
    assert.equal(await salesCount(t),2);const st=(await t.get('/api/state')).body;assert.equal(st.cash.shift.opened_by_name,'Bia');assert.equal(st.cash.shift.closed_at,null);
    assert.ok(fs.readdirSync(t.config.paths.data).some(f=>f.includes('antes-da-volta')));
    assert.ok(fs.readdirSync(path.join(home,'backups','seguranca')).length>0);
    await settled(t);await sameAsCloud(t,cloud);
    const audit=await adminAudit(t);for(const x of ['banco_local_ativado','modo_offline_ativado'])assert.ok(audit.includes(x),x);
    // From now on the till does not need the cloud.
    cloud.down=true;await sell(t,'4,00');assert.equal(await salesCount(t),3);cloud.down=false;await settled(t);await sameAsCloud(t,cloud);
  }finally{await t.stop();}
  // A restart keeps the local database and the copy.
  const t2=await boot(home,{connect:cloud.connect,syncTiming:FAST});try{
    assert.equal(await t2.app.converting,false);assert.equal(t2.app.db.adapter.dialect,'sqlite');assert.equal(syncOf(t2).enabled,true);assert.equal(await salesCount(t2),3);
  }finally{await t2.stop();}
});

test('no modo antigo com a nuvem fora do ar ao iniciar, a passagem acontece quando ela volta',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const home=await oldCloudMode(cloud);cloud.down=true;
  const t=await boot(home,{connect:cloud.connect,syncTiming:FAST});try{
    assert.equal(await t.app.converting,false);assert.equal((await t.get('/api/state')).status,503);
    ok(await login(t));const info=(await t.get('/api/admin/database')).body;assert.equal(info.provider,'postgres');assert.equal(info.postgres.connected,false);
    // The cloud is back: the next reconnection attempt moves everything here.
    cloud.down=false;t.app.databases.retryMs=20;t.app.databases.retry(t.app.databases.active);
    await until(()=>t.app.db.adapter.dialect==='sqlite',8000);await until(()=>syncOf(t).enabled);
    await settled(t);assert.equal(await salesCount(t),2);await sameAsCloud(t,cloud);
    assert.equal((await t.get('/api/state')).status,200);
  }finally{await t.stop();}
});

test('uma alteração feita direto na nuvem é percebida na conferência e corrigida',{skip:SKIP},async()=>{
  const cloud=await fakeCloud();const t=await withCopy(cloud,{timing:{...FAST,firstCheck:0,check:50}});try{
    await openShift(t);await sell(t,'10,00');await settled(t);
    await cloud.db.query('UPDATE sales SET total_cents=1');
    await until(async()=>Number((await cloud.db.query('SELECT SUM(total_cents) AS n FROM sales')).rows[0].n)===1000,8000);
    await settled(t);await sameAsCloud(t,cloud);
    assert.ok((await adminAudit(t)).includes('nuvem_divergente'));await until(()=>syncOf(t).lastCheck?.ok===true);
  }finally{await t.stop();}
});
