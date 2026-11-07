'use strict';
// Finding a product at the till: search by any part of the name (accents and case ignored), sales channel (shop
// counter or delivery), category and favorites. Runs in the browser over the products already loaded, with no request
// per key, and in the tests (Node). Only the screen changes: the products and the sales stay as they are.
(function(root){
  // Same list and order as src/database/catalog.js.
  const CATEGORIES=['Açaís','Bebidas','Sucos e Vitaminas','Sobremesas','Caldos','Crepes e Lanches','Combos','Outros'];
  const FAVORITES='Favoritos',ALL='Todos',OTHER='Outros';
  const CHANNEL_LABEL={loja:'Loja física',delivery:'Delivery'};
  function normalizeSearch(text){return String(text??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();}
  // A product without a known category is shown in "Outros", never hidden.
  const categoryOf=p=>CATEGORIES.includes(p.category)?p.category:OTHER;
  const isFavorite=p=>p.is_favorite===1||p.is_favorite===true;
  // Every word typed must be somewhere in the name, in any order: "coca zero" finds "Coca-Cola Zero", "500" the sizes.
  function matcher(search){
    const words=normalizeSearch(search).split(' ').filter(Boolean);
    return p=>words.every(w=>normalizeSearch(p.name).includes(w));
  }
  function inCategory(p,category){return category===FAVORITES?isFavorite(p):category===ALL||categoryOf(p)===category;}
  function filterProducts(products,filters){
    const match=matcher(filters.search);
    return products.filter(p=>p.channel===filters.channel&&inCategory(p,filters.category)&&match(p));
  }
  // The chips of one channel: favorites (when there are any), all, then the categories that have products, in order.
  function categoryChips(products,channel){
    const own=products.filter(p=>p.channel===channel);const counts={};for(const p of own)counts[categoryOf(p)]=(counts[categoryOf(p)]||0)+1;
    const favorites=own.filter(isFavorite).length;
    return [...(favorites?[{id:FAVORITES,count:favorites}]:[]),{id:ALL,count:own.length},...CATEGORIES.filter(c=>counts[c]).map(c=>({id:c,count:counts[c]}))];
  }
  // Where the till starts in a channel: its favorites when it has some, otherwise everything.
  const defaultCategory=(products,channel)=>products.some(p=>p.channel===channel&&isFavorite(p))?FAVORITES:ALL;
  // A category that has nothing left in the channel (a channel switch, a favorite removed) falls back to the default.
  function validCategory(products,channel,category){
    return category&&categoryChips(products,channel).some(c=>c.id===category)?category:defaultCategory(products,channel);
  }
  // On the card the "(delivery)" suffix is redundant (the channel is already chosen); the full name stays in the title.
  const displayName=name=>String(name??'').replace(/\s*\(\s*delivery\s*\)\s*$/i,'');
  const api={CATEGORIES,FAVORITES,ALL,OTHER,CHANNEL_LABEL,normalizeSearch,categoryOf,isFavorite,matcher,filterProducts,categoryChips,defaultCategory,validCategory,displayName};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ProductFilter=api;
})(typeof window!=='undefined'?window:globalThis);
