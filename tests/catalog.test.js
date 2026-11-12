'use strict';
// Produtos avulsos: search, channel (shop counter or delivery), categories and favorites. P01–P08 and P18 run the
// filter used by the till (public/product-filter.js); the others go through the store and the HTTP API, on SQLite
// and, with `npm run test:postgres`, on PostgreSQL.
const test=require('node:test'),assert=require('node:assert/strict');
const PF=require('../public/product-filter');
const {CATEGORIES,categoryOf,channelOf}=require('../src/database/catalog');
const {SCHEMA_VERSION}=require('../src/database/schema');
const {tempStore,isPostgres,sql}=require('./helpers');
const {boot,ok,openShift,active}=require('./app-helpers');

let next=1;
const P=(name,{category=categoryOf(name),channel=channelOf(name),fav=0,available=10,price=1000}={})=>({id:next++,name,category,channel,is_favorite:fav,available,stock:available,reserved:0,price_cents:price});
const CATALOG=[
  P('Açaí 300 ml'),P('Açaí 500 ml',{fav:1}),P('Açaí 500 ml (delivery)',{fav:1}),P('Açaí 700 ml (delivery)'),
  P('Coca-Cola Zero 350 ml'),P('Coca-Cola 350 ml (delivery)'),P('Água sem gás',{fav:1}),
  P('Suco de Laranja 500 ml'),P('Vitamina de Banana (DELIVERY)'),P('Caldo de Mandioca'),P('Crepe de Frango'),
  P('Brownie de Chocolate'),P('Combo Casal - 2 Açaís 500 ml (delivery)'),P('Turbo Fitness - Pré-Treino',{category:'Açaís'}),
  {...P('Produto antigo'),category:'Categoria que não existe'}];
const names=list=>list.map(p=>p.name);
const find=(filters,list=CATALOG)=>names(PF.filterProducts(list,{search:'',channel:'loja',category:PF.ALL,...filters}));

test('P01 a busca ignora acentos, maiúsculas e espaços a mais',()=>{
  for(const q of ['acai','AÇAÍ','  Açai  ','aÇaÍ'])assert.deepEqual(find({search:q}),['Açaí 300 ml','Açaí 500 ml']);
  assert.deepEqual(find({search:'pre-treino'}),['Turbo Fitness - Pré-Treino']);
  assert.deepEqual(find({search:'agua'}),['Água sem gás']);
});

test('P02 a busca acha parte do nome, palavras em qualquer ordem, sabor e tamanho',()=>{
  assert.deepEqual(find({search:'500 acai'}),['Açaí 500 ml']);
  assert.deepEqual(find({search:'coca zero'}),['Coca-Cola Zero 350 ml']);
  assert.deepEqual(find({search:'mandi'}),['Caldo de Mandioca']);
  assert.deepEqual(find({search:'chocolate'}),['Brownie de Chocolate']);
  assert.deepEqual(find({search:'350'}),['Coca-Cola Zero 350 ml']);
  assert.deepEqual(find({search:'xyz'}),[]);
});

test('P03 loja física e delivery não se misturam',()=>{
  const loja=PF.filterProducts(CATALOG,{search:'',channel:'loja',category:PF.ALL}),delivery=PF.filterProducts(CATALOG,{search:'',channel:'delivery',category:PF.ALL});
  assert.ok(loja.every(p=>p.channel==='loja')&&delivery.every(p=>p.channel==='delivery'));
  assert.equal(loja.length+delivery.length,CATALOG.length);
  assert.deepEqual(find({channel:'delivery',search:'acai 500'}),['Açaí 500 ml (delivery)','Combo Casal - 2 Açaís 500 ml (delivery)']);
  // The suffix decides the channel, whatever the case.
  assert.equal(channelOf('Vitamina de Banana (DELIVERY)'),'delivery');assert.equal(channelOf('Açaí (delivery) grande'),'loja');
});

test('P04 o filtro de categoria mostra só a categoria escolhida, e Todos mostra o canal inteiro',()=>{
  assert.deepEqual(find({category:'Açaís'}),['Açaí 300 ml','Açaí 500 ml','Turbo Fitness - Pré-Treino']);
  assert.deepEqual(find({category:'Bebidas'}),['Coca-Cola Zero 350 ml','Água sem gás']);
  assert.equal(find({category:PF.ALL}).length,CATALOG.filter(p=>p.channel==='loja').length);
});

test('P05 Favoritos vem primeiro e abre o caixa quando o canal tem favoritos; sem favoritos abre em Todos',()=>{
  const chips=PF.categoryChips(CATALOG,'loja');
  assert.deepEqual(chips.slice(0,2),[{id:PF.FAVORITES,count:2},{id:PF.ALL,count:10}]);
  assert.equal(PF.defaultCategory(CATALOG,'loja'),PF.FAVORITES);assert.deepEqual(find({category:PF.FAVORITES}),['Açaí 500 ml','Água sem gás']);
  const noFav=CATALOG.map(p=>({...p,is_favorite:0}));
  assert.equal(PF.defaultCategory(noFav,'loja'),PF.ALL);assert.ok(!PF.categoryChips(noFav,'loja').some(c=>c.id===PF.FAVORITES));
});

test('P06 busca, canal e categoria juntos; sem busca aparece tudo do filtro',()=>{
  assert.deepEqual(find({channel:'delivery',category:'Açaís',search:'700'}),['Açaí 700 ml (delivery)']);
  assert.deepEqual(find({channel:'delivery',category:PF.FAVORITES,search:'acai'}),['Açaí 500 ml (delivery)']);
  assert.deepEqual(find({category:'Bebidas',search:'acai'}),[]);
  assert.deepEqual(find({category:'Caldos',search:''}),['Caldo de Mandioca']);
});

test('P07 os chips seguem a ordem das categorias, com a contagem do canal; categoria desconhecida vai para Outros',()=>{
  const chips=PF.categoryChips(CATALOG,'loja').slice(2);
  assert.deepEqual(chips.map(c=>c.id),CATEGORIES.filter(c=>chips.some(x=>x.id===c)));
  assert.deepEqual(chips.find(c=>c.id==='Outros'),{id:'Outros',count:1});
  assert.equal(PF.categoryOf({category:'Categoria que não existe'}),'Outros');
  assert.deepEqual(find({category:'Outros'}),['Produto antigo']);
  assert.ok(!PF.categoryChips(CATALOG,'delivery').some(c=>c.id==='Caldos'),'categoria sem produto no canal não aparece');
});

test('P08 o card mostra o nome sem "(delivery)", e uma categoria que sumiu do canal volta para o padrão',()=>{
  assert.equal(PF.displayName('Açaí 500 ml (delivery)'),'Açaí 500 ml');assert.equal(PF.displayName('Suco (Delivery) '),'Suco');assert.equal(PF.displayName('Açaí 300 ml'),'Açaí 300 ml');
  assert.equal(PF.validCategory(CATALOG,'delivery','Caldos'),PF.FAVORITES);
  assert.equal(PF.validCategory(CATALOG,'loja','Caldos'),'Caldos');
  assert.equal(PF.validCategory(CATALOG,'loja',null),PF.FAVORITES);
  assert.equal(PF.validCategory([],'loja',PF.FAVORITES),PF.ALL);
});

test('P18 filtrar 600 produtos leva menos de 100 ms',()=>{
  const words=['Açaí','Suco','Crepe','Caldo','Coca-Cola','Brownie','Combo','Vitamina','Tostex','Água'];
  const many=Array.from({length:600},(_,i)=>P(`${words[i%10]} ${['tradicional','zero','de morango','de frango','especial'][i%5]} ${300+(i%5)*100} ml${i%2?' (delivery)':''}`,{fav:i%17===0?1:0}));
  for(const q of ['a','acai','acai 500','coca zero 400','xyz'])for(const channel of ['loja','delivery']){
    const t0=process.hrtime.bigint();
    const category=PF.validCategory(many,channel,null);PF.categoryChips(many,channel);const found=PF.filterProducts(many,{search:q,channel,category:PF.ALL});
    const ms=Number(process.hrtime.bigint()-t0)/1e6;assert.ok(ms<100,`"${q}" em ${channel}: ${ms.toFixed(1)} ms`);
    assert.ok(found.every(p=>p.channel===channel));assert.ok(category);
  }
});

test('a categoria automática segue o nome; o que não dá para saber fica em Outros',()=>{
  const cases={'Açaí 500 ml':'Açaís','Suco de Laranja 500 ml (delivery)':'Sucos e Vitaminas','Vitamina de Banana':'Sucos e Vitaminas','Coca-Cola 350 ml':'Bebidas',
    'Água de coco':'Bebidas','Caldo de Mandioca':'Caldos','Crepe de Frango':'Crepes e Lanches','Tostex Misto':'Crepes e Lanches','Brownie de Chocolate':'Sobremesas',
    'Combo Família':'Combos','Açaí 500 ml + Água':'Combos','Turbo Fitness - Pré-Treino':'Outros','Especial da Casa - Paçoca Power - 550 ml (delivery)':'Outros'};
  for(const [name,category] of Object.entries(cases))assert.equal(categoryOf(name),category,name);
});

// Store and API ----------------------------------------------------------------------------------------------------
async function withStore(fn){const box=await tempStore();try{const op=(await box.s.saveEmployee({name:'Ana'})).id;await fn(box.s,op,box);}finally{await box.clean();}}

test('P09 o produto achado pela busca entra na venda como antes, com categoria, canal e favorito no cadastro',()=>withStore(async(s,op)=>{
  await s.openShift('0',op);
  const {id}=await s.product({name:'Açaí 500 ml (delivery)',price:'24,00',stock:5});
  const p=(await s.listProducts()).find(x=>x.id===id);
  assert.deepEqual({category:p.category,channel:p.channel,is_favorite:p.is_favorite},{category:'Açaís',channel:'delivery',is_favorite:0});
  const found=PF.filterProducts(await s.listProducts(),{search:'acai 500',channel:'delivery',category:PF.ALL});assert.equal(found.length,1);
  const sale=await s.activeSaleId();await s.addUnit(sale,found[0].id,2);
  const cart=(await s.getDraftSale(sale)).items;assert.equal(cart.length,1);assert.equal(cart[0].quantity,2);assert.equal(cart[0].totalCents,4800);
  assert.equal((await s.listProducts()).find(x=>x.id===id).available,3);
}));

test('P10 produto sem estoque continua bloqueado, com ou sem filtro',()=>withStore(async(s,op)=>{
  await s.openShift('0',op);const {id}=await s.product({name:'Coca-Cola 350 ml',price:'7,00',stock:0,favorite:true});
  await assert.rejects(s.addUnit(await s.activeSaleId(),id,1),/estoque/i);
}));

test('P11 cada venda aberta guarda seus itens ao trocar de venda, qualquer que seja o canal',()=>withStore(async(s,op)=>{
  await s.openShift('0',op);
  const loja=(await s.product({name:'Água sem gás',price:'5,00',stock:9})).id,delivery=(await s.product({name:'Açaí 700 ml (delivery)',price:'30,00',stock:9})).id;
  const a=await s.activeSaleId();await s.addUnit(a,loja,1);
  const b=(await s.createDraftSale()).id;await s.addUnit(b,delivery,2);
  await s.selectDraftSale(a);
  assert.deepEqual((await s.getDraftSale(a)).items.map(i=>[i.label,i.quantity]),[['Água sem gás',1]]);
  assert.deepEqual((await s.getDraftSale(b)).items.map(i=>[i.label,i.quantity]),[['Açaí 700 ml (delivery)',2]]);
}));

test('P17 a venda cobrada baixa o estoque do produto filtrado',()=>withStore(async(s,op)=>{
  await s.openShift('0',op);const {id}=await s.product({name:'Brownie de Chocolate',price:'9,00',stock:4});
  const sale=await s.activeSaleId();await s.addUnit(sale,id,3);await s.checkoutDraftSale(sale,'pix',require('node:crypto').randomUUID());
  const p=(await s.listProducts()).find(x=>x.id===id);assert.equal(p.stock,1);assert.equal(p.available,1);
}));

test('o cadastro valida categoria e canal, e a edição mantém o que não veio',()=>withStore(async s=>{
  await assert.rejects(s.product({name:'Água',price:'5,00',stock:1,category:'Bolos'}),/Categoria inválida/);
  await assert.rejects(s.product({name:'Água',price:'5,00',stock:1,channel:'ifood'}),/Canal inválido/);
  await assert.rejects(s.product({name:'Água',price:'5,00',stock:1,favorite:'sim'}),/Favorito inválido/);
  const {id}=await s.product({name:'Turbo Fitness - Pré-Treino',price:'22,00',stock:5,category:'Açaís',channel:'delivery',favorite:true});
  const get=async()=>(await s.listProducts()).find(x=>x.id===id);
  assert.deepEqual([(await get()).category,(await get()).channel,(await get()).is_favorite],['Açaís','delivery',1]);
  // An edit from an older screen (name, price and stock only) keeps the rest.
  await s.product({id,name:'Turbo Fitness - Pré-Treino',price:'23,00',stock:6});
  assert.deepEqual([(await get()).category,(await get()).channel,(await get()).is_favorite,(await get()).price_cents],['Açaís','delivery',1,2300]);
  await s.product({id,name:'Turbo Fitness - Pré-Treino',price:'23,00',stock:6,category:'Outros',channel:'loja',favorite:false});
  assert.deepEqual([(await get()).category,(await get()).channel,(await get()).is_favorite],['Outros','loja',0]);
  // A new one without category or channel is classified by its name.
  const n=(await s.product({name:'Suco de Uva (delivery)',price:'10,00',stock:1,category:''})).id;
  const p=(await s.listProducts()).find(x=>x.id===n);assert.deepEqual([p.category,p.channel,p.is_favorite],['Sucos e Vitaminas','delivery',0]);
}));

test('a estrela muda só o favorito: estoque e preço ficam como estão',()=>withStore(async s=>{
  const {id}=await s.product({name:'Água sem gás',price:'5,00',stock:7});
  await sql(s,'UPDATE products SET stock=3 WHERE id=?',[id]);// a sale changed the stock after the screen loaded
  assert.deepEqual(await s.favoriteProduct(id,true),{id,favorite:true});
  let p=(await s.listProducts()).find(x=>x.id===id);assert.equal(p.is_favorite,1);assert.equal(p.stock,3);assert.equal(p.price_cents,500);
  await s.favoriteProduct(id,false);p=(await s.listProducts()).find(x=>x.id===id);assert.equal(p.is_favorite,0);
  await assert.rejects(s.favoriteProduct(id,'x'),/Favorito inválido/);
  await assert.rejects(s.favoriteProduct(99999,true),/não encontrado/);
  await s.deleteProduct(id);await assert.rejects(s.favoriteProduct(id,true),/não encontrado/);
}));

test('P13 a atualização do banco (versão 4 para 5) classifica os produtos e não muda preço, estoque nem vendas',async()=>{
  const box=await tempStore();try{
    let s=box.s;const op=(await s.saveEmployee({name:'Ana'})).id;await s.openShift('0',op);
    const ids={};for(const [name,price,stock] of [['Açaí 500 ml (delivery)','24,00',8],['Coca-Cola 350 ml','7,00',5],['Turbo Fitness - Pré-Treino','22,00',3],['Caldo de Mandioca (Delivery)','16,00',2]])ids[name]=(await s.product({name,price,stock})).id;
    const sale=await s.activeSaleId();await s.addUnit(sale,ids['Coca-Cola 350 ml'],2);await s.checkoutDraftSale(sale,'cash',require('node:crypto').randomUUID(),'20,00');
    const open=await s.activeSaleId();await s.addUnit(open,ids['Açaí 500 ml (delivery)'],1);
    const snapshot=async()=>({products:await s.adapter.all('SELECT id,name,price_cents,stock,active FROM products ORDER BY id'),
      sales:await s.adapter.all('SELECT id,total_cents,method,status FROM sales ORDER BY id'),items:await s.adapter.all('SELECT id,product_id,quantity,total_cents FROM sale_items ORDER BY id'),
      draft:(await s.getDraftSale(open)).items.map(i=>[i.label,i.quantity])});
    const before=await snapshot();
    // Back to how version 4 stored products.
    for(const c of ['category','channel','is_favorite'])await sql(s,`ALTER TABLE products DROP COLUMN ${c}`);
    // (version 6 came later and is applied again too)
    if(isPostgres){await sql(s,'DROP TABLE employee_permissions');await sql(s,'DELETE FROM schema_migrations WHERE version>=5');}else await s.adapter.exec('PRAGMA user_version=4');
    s=await box.reopen();
    assert.equal(await s.adapter.schemaVersion(),SCHEMA_VERSION);assert.deepEqual(await snapshot(),before);
    const got=Object.fromEntries((await s.adapter.all('SELECT name,category,channel,is_favorite FROM products')).map(p=>[p.name,[p.category,p.channel,p.is_favorite]]));
    assert.deepEqual(got,{'Açaí 500 ml (delivery)':['Açaís','delivery',0],'Coca-Cola 350 ml':['Bebidas','loja',0],'Turbo Fitness - Pré-Treino':['Outros','loja',0],'Caldo de Mandioca (Delivery)':['Caldos','delivery',0]});
    // Opening again changes nothing (the migration ran once).
    await sql(s,"UPDATE products SET category='Açaís' WHERE name='Turbo Fitness - Pré-Treino'");s=await box.reopen();
    assert.equal((await s.adapter.get("SELECT category FROM products WHERE name='Turbo Fitness - Pré-Treino'")).category,'Açaís');
    await assert.rejects(sql(s,"UPDATE products SET channel='ifood'"));
  }finally{await box.clean();}
});

test('a API devolve os novos campos, grava o favorito e mantém /api/cart/unit igual',{skip:isPostgres&&'a API de teste roda no banco local'},async()=>{
  const t=await boot();try{
    await openShift(t);
    const id=ok(await t.post('/api/products/save',{name:'Açaí 500 ml (delivery)',price:'24,00',stock:4,favorite:true})).id;
    const water=ok(await t.post('/api/products/save',{name:'Água sem gás',price:'5,00',stock:4,category:'Bebidas',channel:'loja'})).id;
    let p=(await t.get('/api/state')).body.products.find(x=>x.id===id);
    assert.deepEqual([p.category,p.channel,p.is_favorite,p.available],['Açaís','delivery',1,4]);
    assert.deepEqual(ok(await t.post('/api/products/favorite',{id:water,favorite:true})),{id:water,favorite:true});
    assert.equal((await t.get('/api/state')).body.products.find(x=>x.id===water).is_favorite,1);
    const r=await t.post('/api/products/save',{name:'Água',price:'5,00',stock:1,channel:'ifood'});assert.equal(r.status,400);assert.match(r.body.error,/Canal inválido/);
    const saleId=await active(t);const sale=ok(await t.post('/api/cart/unit',{saleId,id,quantity:1}));assert.equal(sale.items.length,1);
    p=(await t.get('/api/state')).body.products.find(x=>x.id===id);assert.equal(p.available,3);
  }finally{await t.stop();}
});
