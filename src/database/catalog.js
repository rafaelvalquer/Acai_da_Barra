'use strict';
// What a product is besides name, price and stock: its category (fixed list), its sales channel (the shop counter or
// delivery) and whether it is a favorite (shown first at the till). The first classification comes from the name:
// a "(delivery)" suffix means delivery, and only clear words choose a category; anything unclear goes to "Outros",
// to be set in the product form. Used by the migration to version 5 and when a product is saved without a category.
const CATEGORIES=['Açaís','Bebidas','Sucos e Vitaminas','Sobremesas','Caldos','Crepes e Lanches','Combos','Outros'];
const OTHER='Outros';
const CHANNELS=['loja','delivery'];
const plain=s=>String(s??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
const DELIVERY=/\(\s*delivery\s*\)\s*$/i;
const channelOf=name=>DELIVERY.test(String(name??'').trim())?'delivery':'loja';
// Checked on the product's family, the part of the name before " - " ("Caldo especial - Canja" → "caldo especial"),
// so a flavor or an ingredient in the rest of the name ("Suco especial - Açaí") does not decide the category.
const RULES=[
  ['Combos',/^combo\b|\+/],
  ['Sucos e Vitaminas',/\b(sucos?|vitaminas?|milk ?shakes?|shakes?)\b/],
  ['Bebidas',/\b(aguas?|refrigerantes?|coca|guarana|cha|cafe|cervejas?|energetico|lata)\b/],
  ['Caldos',/\b(caldos?|sopas?|canja)\b/],
  ['Crepes e Lanches',/\b(crepes?|tostex|waffles?|lanches?|sanduiches?|misto|pao)\b/],
  ['Sobremesas',/\b(brownies?|fondue|sorvetes?|sobremesas?|pudim|bolos?|tortas?)\b/],
  ['Açaís',/\bacai\b/]
];
function categoryOf(name){
  const base=plain(name).replace(/\(\s*delivery\s*\)\s*$/,'').trim();const family=base.split(' - ')[0].trim();
  for(const [category,rule] of RULES)if(rule.test(family))return category;
  // Several products joined in one name ("Experiência Completa - Caldo + Fondue") are a combo.
  return /\s\+\s/.test(base)?'Combos':OTHER;
}
// Step of the migration to version 5 (SQLite and PostgreSQL): existing products get their first classification.
async function classifyProducts(q){
  for(const p of await q.all('SELECT id,name FROM products'))
    await q.run('UPDATE products SET category=?,channel=? WHERE id=?',[categoryOf(p.name),channelOf(p.name),p.id]);
}
module.exports={CATEGORIES,CHANNELS,OTHER,categoryOf,channelOf,classifyProducts,plain};
