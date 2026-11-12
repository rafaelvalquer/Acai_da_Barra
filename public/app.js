'use strict';
let TOKEN='',state={},activeTab='vendas',currentReport=null,currentSale=null,seenAlert='',cashControlKey=null,payMethod='pix',manualMode='weight',checkingOut=false,reportPeriod='day',reportDate='',lastActive=null,renameId=null,transferFrom=null,transferKey=null,transferTo=null;
const $=id=>document.getElementById(id);
const money=c=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((c||0)/100);
const signed=c=>(c>0?'+ ':c<0?'− ':'')+money(Math.abs(c||0));
const price=c=>(c/100).toFixed(2).replace('.',',');
const weight=g=>(g/1000).toFixed(3).replace('.',',');
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>s?new Date(s).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'';
const time=s=>s?new Date(s).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'';
const icon=(name,cls='')=>`<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const emptyState=(name,title,text)=>`<div class="empty">${icon(name,'lg')}<strong>${title}</strong>${text?`<span>${text}</span>`:''}</div>`;
const initials=n=>String(n).split(' ').filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
const plural=(n,one,many)=>`${n} ${n===1?one:many}`;
// Produtos avulsos: the filters live only on this screen (they never change a sale). The channel is remembered per
// open sale during the session, so going back to a delivery order shows the delivery products again.
const productFilters={search:'',channel:'loja',category:null};const channelBySale=new Map();
// The product form picks the channel from a "(delivery)" at the end of a new name, until the operator chooses one.
let formChannelTouched=false;
const CAT_TONE={'Açaís':'c-acai','Bebidas':'c-bebida','Sucos e Vitaminas':'c-suco','Sobremesas':'c-doce','Caldos':'c-caldo','Crepes e Lanches':'c-lanche','Combos':'c-combo','Outros':'c-outro'};
const PF=()=>window.ProductFilter;
const PAY={pix:'Pix',cash:'Dinheiro',debit:'Débito',credit:'Crédito'};
const WEEK=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const MONTHS=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
// Calendar helpers on YYYY-MM-DD strings (the server decides what "today" is).
const utc=s=>Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10));
const iso=t=>new Date(t).toISOString().slice(0,10);
const br=s=>`${s.slice(8,10)}/${s.slice(5,7)}/${s.slice(0,4)}`;
const dayShort=s=>`${WEEK[new Date(utc(s)).getUTCDay()]} ${s.slice(8,10)}/${s.slice(5,7)}`;
const localToday=()=>new Date().toLocaleDateString('en-CA');
function stepPeriod(s,period,step){if(period==='month'){const d=new Date(utc(s));return iso(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+step,1));}return iso(utc(s)+step*(period==='week'?7:1)*86400000);}
// Same format the server accepts ("50", "50,00", "R$ 50,00"); null when it doesn't parse.
const parseMoney=v=>{const m=String(v).trim().replace(/^R\$\s*/,'').match(/^(\d{1,6})(?:[.,](\d{1,2}))?$/);return m?Number(m[1])*100+Number((m[2]||'').padEnd(2,'0')):null;};
// Notes a customer is likely to hand over: R$ 31,54 → R$ 40, R$ 50, R$ 100.
const quickBills=t=>[...new Set([1000,2000,5000,10000,20000].map(b=>Math.ceil(t/b)*b))].filter(v=>v>t).slice(0,3);
function itemLine(kind,grams,quantity,unitCents){return kind==='weight'?`${weight(grams)} kg × ${money(unitCents)}/kg`:kind==='value'?'Valor digitado':`${quantity} un. × ${money(unitCents)}`;}
// Skips identical re-renders from the polling loop so focus, hover and animations survive.
function paint(id,html){const el=$(id);if(el._html!==html){el.innerHTML=html;el._html=html;}}
function flash(msg,error=false){const t=$('toast');t.textContent=msg;t.className='show'+(error?' error':'');setTimeout(()=>{if(t.textContent===msg)t.className='';},3600);}
function ask(title,message,{confirmLabel='Confirmar',tone='primary',input=null,details=null,alert=false}={}){
 const d=$('confirm-dialog');if(d.open)return Promise.resolve(false);
 $('confirm-title').textContent=title;$('confirm-message').textContent=message||'';$('confirm-message').classList.toggle('hidden',!message);
 $('confirm-ok').textContent=confirmLabel;$('confirm-ok').className=tone;$('confirm-cancel').classList.toggle('hidden',alert);
 $('confirm-icon').innerHTML=icon(tone==='danger-solid'?'alert':tone==='success'?'check':'info');
 d.classList.toggle('is-danger',tone==='danger-solid');d.classList.toggle('is-success',tone==='success');
 $('confirm-details').innerHTML=details?details.map(([label,value,cls])=>`<div class="rowline"><span>${safe(label)}</span><strong class="${cls||''}">${safe(value)}</strong></div>`).join(''):'';
 const field=$('confirm-input');$('confirm-field').classList.toggle('hidden',!input);field.required=!!input;field.minLength=input?3:0;field.value='';
 if(input){$('confirm-field-label').textContent=input.label;field.placeholder=input.placeholder||'';}
 d.returnValue='';d.showModal();(input?field:tone==='danger-solid'&&!alert?$('confirm-cancel'):$('confirm-ok')).focus();
 return new Promise(resolve=>d.addEventListener('close',()=>resolve(d.returnValue!=='ok'?false:input?field.value.trim():true),{once:true}));
}
// A 401 means nobody is signed in at the till (the session ended, was locked or replaced): back to the sign-in.
// The server answers 401/403 before doing anything, so nothing half-done is left behind.
async function get(path){const r=await fetch(path,{cache:'no-store'});const x=await r.json().catch(()=>({}));
 if(!r.ok){if(r.status===401)signedOut();throw Object.assign(Error(x.error||'Falha de conexão'),{status:r.status,data:x});}return x;}
async function post(path,obj={},retry=true){
 const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':TOKEN},body:JSON.stringify(obj)});const x=await r.json().catch(()=>({}));
 // The page token changes when the PDV restarts: fetched again once.
 if(r.status===403&&retry&&/Sessão de segurança/.test(x.error||'')){TOKEN=(await get('/api/session')).token;return post(path,obj,false);}
 if(!r.ok){if(r.status===401&&!path.startsWith('/api/auth/'))signedOut();throw Object.assign(Error(x.error||'Falha ao salvar'),{status:r.status,data:x});}return x;}
// What the person signed in may do (the server decides; this only hides what would be refused anyway).
const can=p=>!!state.auth?.permissions?.includes(p);
async function run(path,obj,done){try{const r=await post(path,obj);if(done)done(r.result);await refresh();return r.result;}catch(e){flash(e.message,true);return null;}}
function statusDisplay(s){return ({stable:'Estável',waiting:'Sem leitura',offline:'Desconectado',unstable:'Instável',negative:'Peso negativo',overload:'Sobrecarga',invalid:'Leitura inválida'})[s]||s;}
function setPay(m){payMethod=m;document.querySelectorAll('[data-pay]').forEach(b=>{const on=b.dataset.pay===m;b.setAttribute('aria-checked',on);b.tabIndex=on?0:-1;});render();}
function cashState(){const raw=$('cash-received').value.trim(),total=state.cartTotalCents,received=raw?parseMoney(raw):null;
 return {raw,total,received,invalid:!!raw&&received===null,short:received!==null&&received<total};}
// Change is recomputed on every render, so a weighing added after typing updates it too. Returns true while checkout must wait.
function renderCashBox(){
 const on=payMethod==='cash';$('cash-box').classList.toggle('hidden',!on);if(!on)return false;
 const {raw,total,received,invalid,short}=cashState();
 paint('cash-quick',total?[`<button type="button" data-received="${price(total)}">Exato</button>`,...quickBills(total).map(v=>`<button type="button" data-received="${price(v)}">R$ ${v/100}</button>`)].join(''):'');
 paint('cash-change',!raw||!total?'<span class="cash-hint">Informe o valor recebido para calcular o troco</span>':invalid?'<span class="cash-hint neg">Use valor como 50,00</span>'
  :short?`<span>Faltam</span><strong class="neg">${money(total-received)}</strong>`:`<span>Troco</span><strong class="pos">${money(received-total)}</strong>`);
 return invalid||short;
}
function render(){
 if(!state.scale)return;
 applyAccess();
 const s=state.scale,c=state.config,shift=state.cash.shift,person=state.auth?.person,sell=can('sales.create');
 // Configurações shows a dot when a backup failed (red) or needs attention (yellow).
 const alert=state.system?.alert;$('config-dot').className='nav-dot'+(alert?' '+alert:' hidden');
 if(state.system?.version)$('app-version').textContent='v'+state.system.version;
 $('cash-badge').textContent=shift?'Caixa aberto':'Caixa fechado';$('cash-badge').className='pill '+(shift?'on':'warn');
 $('connection').textContent=s.mode==='demo'?'Simulador ativo':s.mode==='serial'?'Balança conectada':'Balança offline';$('connection').className='pill '+(s.mode==='offline'?'warn':'on');
 cloudBadge(state.system?.sync);
 $('operator-name').textContent=person?person.name:'Entrar';$('operator-role').textContent=person?.kind==='admin'?'Administrador':'Operador';$('operator-btn').classList.toggle('warn',!person);
 paint('operator-avatar',!person?icon('user'):person.kind==='admin'?icon('shield'):safe(initials(person.name)));
 $('closed-banner').classList.toggle('hidden',!!shift);
 renderSales();
 // Without readings from the scale the manual entry takes the main spot, so service never stops.
 const scaleDown=s.mode==='offline'||['offline','waiting','invalid'].includes(s.status);
 $('weight-actions').classList.toggle('attention',scaleDown);
 $('btn-manual').querySelector('span').textContent=scaleDown?'Balança sem comunicação? Digite o peso':'Digitar peso ou valor';
 $('weight-mode').textContent=s.mode.toUpperCase();$('scale-note').textContent=s.mode==='demo'?'Simulação de pesagem':s.mode==='serial'?'Balança Toledo conectada':'Ative o modo demonstração na aba Balança';
 $('weight-value').textContent=weight(s.grams||0);$('weight-status').textContent=statusDisplay(s.status);$('weight-status').className='chip '+(s.status==='stable'?'on':'warn');
 $('weight-instructions').textContent=!shift?'Abra o caixa para vender':scaleDown?'Use o lançamento manual':s.ready?'Pronto para adicionar':s.armed?'Aguardando peso estável':'Retire o prato para nova pesagem';
 $('weight-price').textContent=money(Math.round((s.grams||0)*c.priceKgCents/1000));
 // The price per kilo and the automatic capture: only who may change the configuration edits them.
 const cfg=can('config.manage');$('price-kg').readOnly=!cfg;$('btn-price').classList.toggle('hidden',!cfg);$('auto-capture-row').classList.toggle('hidden',!cfg);
 if(document.activeElement!==$('price-kg'))$('price-kg').value=price(c.priceKgCents);
 $('auto-capture').checked=c.autoCapture;
 $('btn-capture').disabled=!sell||!shift||!s.ready||!state.activeSale;
 $('btn-manual').classList.toggle('hidden',!can('sales.manual_weight')&&!can('sales.manual_value'));$('btn-manual').disabled=!shift||!state.activeSale;
 const pend=state.pendingCaptures||[];$('capture-pending').classList.toggle('hidden',!pend.length);
 paint('capture-pending',pend.map(p=>`<div class="pending-row">${icon('alert')}<div class="grow"><strong>Pesagem de ${weight(p.grams)} kg não foi gravada${p.label?` em ${safe(p.label)}`:''}</strong><small>${safe(p.error)}</small></div><button type="button" class="accent" data-retry="${safe(p.captureId)}">Tentar de novo</button><button type="button" class="secondary" data-drop="${safe(p.captureId)}">Descartar</button></div>`).join(''));
 renderQuickProducts();
 const n=state.cart.length;$('cart-count').textContent=plural(n,'item','itens');$('cart-total').textContent=money(state.cartTotalCents);
 if(!renameId)$('sale-name-text').textContent=state.activeSale?.label||'—';$('sale-name').disabled=!state.activeSale||!sell;
 const moving=can('sales.transfer');
 paint('cart-items',n?state.cart.map(p=>`<div class="cart-item"><span class="ci-icon ${p.manual?'is-manual':p.kind==='weight'?'is-weight':''}">${icon(p.manual?'keyboard':p.kind==='unit'?'box':'cup')}</span><div class="ci-main"><strong>${safe(p.label)}</strong><small>${itemLine(p.kind,p.grams,p.quantity,p.unitCents)}</small></div>${p.kind==='unit'&&sell?`<div class="qty"><button data-qty="${safe(p.key)}" data-to="${p.quantity-1}" ${p.quantity<2?'disabled':''} aria-label="Diminuir quantidade">${icon('minus')}</button><span>${p.quantity}</span><button data-qty="${safe(p.key)}" data-to="${p.quantity+1}" aria-label="Aumentar quantidade">${icon('plus')}</button></div>`:''}<span class="ci-total">${money(p.totalCents)}</span><div class="ci-actions">${moving?`<button class="move" data-move="${safe(p.key)}" aria-label="Transferir ${safe(p.label)} para outra venda" title="Transferir para outra venda">${icon('swap')}</button>`:''}${sell?`<button class="remove" data-remove="${safe(p.key)}" aria-label="Remover ${safe(p.label)}" title="Remover">${icon('x')}</button>`:''}</div></div>`).join(''):emptyState('cup','Nenhum item ainda','Coloque o copo na balança ou toque em um produto avulso.'));
 const cashBlocked=renderCashBox(),pay=can('sales.checkout');
 $('btn-checkout').disabled=!pay||!shift||n===0||checkingOut||cashBlocked;$('checkout-label').textContent=!pay?'Cobrar: peça a quem tem permissão':n?`Cobrar esta venda · ${money(state.cartTotalCents)}`:'Cobrar esta venda';
 $('btn-discard').classList.toggle('hidden',!can('sales.discard'));$('btn-discard').disabled=!state.activeSale||(n===0&&state.openSales.length<2);
 $('btn-new-sale').disabled=!sell;
 renderCash();renderProducts();renderEmployees();renderScaleAccess();
 if(s.lastError&&s.lastError!==seenAlert){seenAlert=s.lastError;flash(s.lastError,true);}
 if(state.lastAutoError&&state.lastAutoError!==seenAlert){seenAlert=state.lastAutoError;flash(state.lastAutoError,true);}
}
// The tab bar: every open sale with its total. The active one is where the scale weighs, and only the operator
// changes it (after a sale is paid or discarded the server moves to an empty sale, never to another customer's).
function renderSales(){
 const shift=state.cash.shift,sales=state.openSales||[],active=state.activeSaleId,locked=!state.canSwitch;
 $('sales-bar').classList.toggle('hidden',!shift);$('switch-hint').classList.toggle('hidden',!shift||!locked||sales.length<2);
 $('weigh-target').classList.toggle('hidden',!state.activeSale);$('weigh-target-name').textContent=state.activeSale?.label||'—';
 const bar=$('sale-tabs'),left=bar.scrollLeft,focused=bar.contains(document.activeElement)?document.activeElement.dataset.sale:null;
 paint('sale-tabs',sales.map(d=>{const on=d.id===active;return `<button type="button" role="tab" class="sale-tab${on?' active':''}${locked&&!on?' locked':''}" data-sale="${d.id}" aria-selected="${on}" tabindex="${on?0:-1}" title="${on?'Venda selecionada · clique para renomear':locked?'Retire o produto da balança para trocar de venda':'Selecionar esta venda'}">${on?icon('scale'):''}<span class="st-name">${safe(d.label)}</span><span class="st-total">${money(d.total_cents)}</span></button>`;}).join(''));
 // Repaints keep the bar's scroll position and the keyboard focus.
 bar.scrollLeft=left;if(focused&&!bar.contains(document.activeElement))bar.querySelector(`[data-sale="${focused}"]`)?.focus();
 if(active!==lastActive){
  // Another customer: an amount typed for the previous one no longer applies.
  if(lastActive!==null)$('cash-received').value='';
  lastActive=active;finishRename(false);
  // Each sale shows the products of its own channel; a new one starts at the shop counter.
  productFilters.channel=channelBySale.get(active)||'loja';productFilters.category=null;
  const on=bar.querySelector('.sale-tab.active');if(on&&(on.offsetLeft<bar.scrollLeft||on.offsetLeft+on.offsetWidth>bar.scrollLeft+bar.clientWidth))bar.scrollLeft=on.offsetLeft-16;
 }
}
function selectSale(id){
 if(id===state.activeSaleId)return startRename();
 if(!state.canSwitch)return flash('Retire o produto da balança para trocar de venda.',true);
 return run('/api/open-sales/select',{saleId:id});
}
function startRename(){const sale=state.activeSale;if(!sale)return;renameId=sale.id;const input=$('sale-name-input');input.value=sale.label;$('sale-name').classList.add('hidden');input.classList.remove('hidden');input.focus();input.select();}
async function finishRename(save){
 if(!renameId)return;const id=renameId,input=$('sale-name-input'),name=input.value.trim();renameId=null;
 input.classList.add('hidden');$('sale-name').classList.remove('hidden');
 const sale=state.openSales.find(d=>d.id===id);if(save&&sale&&name&&name!==sale.label)await run('/api/open-sales/rename',{saleId:id,label:name},r=>flash(`Venda renomeada: ${r.label}`));
}
function openTransfer(key){
 const item=state.cart.find(x=>x.key===key),from=state.activeSale;if(!item||!from)return;transferFrom=from.id;transferKey=key;transferTo=null;
 $('transfer-item').textContent=`${item.label} · ${itemLine(item.kind,item.grams,item.quantity,item.unitCents)} · ${money(item.totalCents)}. Está em ${from.label}.`;
 $('transfer-options').innerHTML=[...state.openSales.filter(d=>d.id!==from.id).map(d=>`<button type="button" role="radio" aria-checked="false" class="transfer-option" data-to="${d.id}"><strong>${safe(d.label)}</strong><small>${plural(d.item_count,'item','itens')} · ${money(d.total_cents)}</small></button>`),
  `<button type="button" role="radio" aria-checked="false" class="transfer-option is-new" data-to="new"><strong>${icon('plus')}Nova venda</strong><small>Abre uma venda só com este item</small></button>`].join('');
 $('transfer-ok').disabled=true;$('transfer-dialog').showModal();$('transfer-options').querySelector('button')?.focus();
}
// The cash screen. Without "cash.view_expected" the server sends no amounts at all (state.cash.blind): the close is
// blind, and the screen shows what the person does, never a number that is not there.
const CLOSE_STATUS={CONFERIDO:['Conferido','pos','O dinheiro contado bate com o esperado.'],
 FALTA:['Falta dinheiro','neg','O dinheiro contado é menor que o esperado. O administrador vê os detalhes do fechamento.'],
 SOBRA:['Sobra dinheiro','warn','O dinheiro contado é maior que o esperado. O administrador vê os detalhes do fechamento.']};
function renderCash(){
 const cash=state.cash,shift=cash.shift,blind=!!cash.blind,events=cash.events;
 const opened=shift?`<span class="chip on">Aberto às ${time(shift.opened_at)}${shift.opened_by_name?` por ${safe(shift.opened_by_name)}`:''}</span>`:'';
 const turn=`Vendas do turno · ${plural(cash.salesCount||0,'venda','vendas')}${cash.canceledCount?` · ${plural(cash.canceledCount,'cancelada','canceladas')}`:''}`;
 paint('cash-summary',!shift?emptyState('lock','Caixa fechado',can('cash.open')?'Informe o fundo inicial em dinheiro e abra o turno.':'Quem tem permissão de abrir o caixa precisa abrir o turno.')
  :blind?`${opened}<div class="notice blind-note">${icon('lock')}<span><strong>Fechamento cego.</strong> No fechamento, conte o dinheiro da gaveta e digite o valor: o sistema confere e mostra se está certo, se falta ou se sobra.</span></div><div class="section-label spaced">${turn}</div>`
  :`${opened}<div class="highlight"><small>Dinheiro esperado em caixa</small><strong>${money(cash.expectedCents)}</strong></div><div class="rowline"><span>Fundo inicial</span><strong>${money(shift.opening_cents)}</strong></div><div class="rowline"><span>Vendas em dinheiro</span><strong>${money(cash.cashSalesCents)}</strong></div><div class="rowline"><span>Suprimentos</span><strong>${money(cash.suppliesCents)}</strong></div><div class="rowline"><span>Sangrias</span><strong>${money(cash.withdrawalsCents)}</strong></div>
  <div class="section-label spaced">${turn}</div><div class="method-grid">${['pix','cash','debit','credit'].map(m=>`<div><small>${PAY[m]}</small><strong>${money(cash.methods[m])}</strong></div>`).join('')}<div class="method-total"><small>Total vendido</small><strong>${money(cash.totalCents)}</strong></div></div>`);
 const allowed=['cash.open','cash.move','cash.close'].filter(can).join();
 const key=shift?`open:${shift.id}:${allowed}:${blind}`:`closed:${allowed}:${state.auth?.person?.name||''}`;
 if(cashControlKey!==key){cashControlKey=key;
  const move=can('cash.move')?`<div class="section-label">Nova movimentação</div><div class="grid2"><label>Tipo de movimentação<select id="movement-kind"><option value="withdrawal">Sangria (retirada)</option><option value="supply">Suprimento (entrada)</option></select></label><label>Valor (R$)<input id="movement-amount" placeholder="20,00" inputmode="decimal"></label></div><label>Descrição<input id="movement-note" placeholder="Ex.: retirada para cofre"></label><button class="secondary" id="btn-move">${icon('swap')}Registrar movimentação</button>`:'';
  const close=can('cash.close')?`<div class="section-label">Fechamento do turno</div><label>${blind?'Dinheiro contado na gaveta (R$)':'Dinheiro contado no fechamento (R$)'}<input id="close-counted" inputmode="decimal" placeholder="0,00" autocomplete="off"></label><button class="danger" id="btn-close">${icon('lock')}Fechar turno</button>`:'';
  $('cash-controls').innerHTML=shift?(move||close?`<div class="form">${move}${move&&close?'<div class="hline"></div>':''}${close}</div>`:`<div class="notice">${icon('info')}<span>Sangrias, suprimentos e o fechamento ficam com quem tem permissão. Peça ao administrador.</span></div>`)
   :can('cash.open')?`<div class="form"><p class="minor">O turno é aberto em nome de <strong>${safe(state.auth?.person?.name||'')}</strong>.</p><label>Fundo inicial em dinheiro (R$)<input id="opening-amount" placeholder="100,00" value="0,00" inputmode="decimal"></label><button class="primary big" id="btn-open">${icon('unlock')}Abrir caixa</button></div>`
   :`<div class="notice">${icon('info')}<span>Você não tem permissão para abrir o caixa. Peça ao administrador.</span></div>`;}
 const open=(state.openSales||[]).filter(d=>d.item_count>0);
 paint('cash-open-sales',shift&&open.length?`<div class="notice warn">${icon('alert')}<span><strong>${open.length===1?'1 venda em aberto':`${open.length} vendas em aberto`}.</strong> Cobre ou descarte antes de fechar o caixa.</span></div><div class="open-sales-list">${open.map(d=>`<button type="button" class="secondary" data-open-sale="${d.id}">${safe(d.label)} · ${money(d.total_cents)}${icon('arrow-right')}</button>`).join('')}</div>`:'');
 // The movements of the shift only for who records them or sees the cash history.
 const seesEvents=can('cash.view_history')||can('cash.move');$('cash-events-card').classList.toggle('hidden',!seesEvents);
 paint('cash-events',!seesEvents?'':events?.length?events.map(e=>{const out=e.kind==='withdrawal';return `<div class="rowline"><span class="ev-icon ${out?'out':'in'}">${icon(out?'arrow-down':'arrow-up')}</span><div class="grow"><strong>${out?'Sangria':'Suprimento'}</strong><small>${safe(e.note)||'Sem descrição'} · ${time(e.created_at)}${e.operator_name?` · ${safe(e.operator_name)}`:''}</small></div><strong class="${out?'neg':'pos'}">${out?'−':'+'} ${money(e.amount_cents)}</strong></div>`;}).join(''):emptyState('swap','Nenhuma movimentação','Sangrias e suprimentos do turno aparecem aqui.'));
}
// Produtos avulsos at the till: what the search, the channel and the category leave, from the products already loaded
// (no request per key). Only what changed is repainted, so the search keeps its text, cursor and focus through the
// automatic refresh, and adding a product works exactly as before (/api/cart/unit with the same saleId, id, quantity).
function renderQuickProducts(){
 const pf=PF(),f=productFilters,all=state.products||[],shift=state.cash.shift;
 f.category=pf.validCategory(all,f.channel,f.category);
 document.querySelectorAll('[data-channel]').forEach(b=>{const on=b.dataset.channel===f.channel;b.setAttribute('aria-selected',on);b.tabIndex=on?0:-1;});
 const chips=pf.categoryChips(all,f.channel),cats=$('qp-cats'),focused=cats.contains(document.activeElement)?document.activeElement.dataset.cat:null;
 paint('qp-cats',all.length?chips.map(c=>{const on=c.id===f.category;return `<button type="button" role="tab" class="qp-cat${c.id===pf.FAVORITES?' fav':''}" data-cat="${safe(c.id)}" aria-selected="${on}" tabindex="${on?0:-1}">${c.id===pf.FAVORITES?icon('star'):''}${safe(c.id)}<small>${c.count}</small></button>`;}).join(''):'');
 if(focused&&!cats.contains(document.activeElement))[...cats.querySelectorAll('[data-cat]')].find(b=>b.dataset.cat===focused)?.focus();
 const list=pf.filterProducts(all,f),inChannel=all.some(p=>p.channel===f.channel);
 $('qp-count').textContent=!all.length?'Toque para adicionar':!shift?'Abra o caixa para vender':plural(list.length,'produto','produtos');
 paint('quick-products',!all.length?emptyState('box','Nenhum produto avulso','Cadastre itens como água e refrigerante na aba Produtos.')
  :!inChannel?emptyState(f.channel==='delivery'?'bike':'store',f.channel==='delivery'?'Nenhum produto de delivery':'Nenhum produto da loja física','Na aba Produtos, escolha o canal de venda de cada item.')
  :!list.length?noProductFound(all,f):list.map(p=>productCard(p,shift&&can('sales.create'))).join(''));
}
function productCard(p,shift){
 const pf=PF(),why=p.available>0?plural(p.available,'disponível','disponíveis'):p.stock>0?'Reservado em vendas abertas':'Sem estoque';
 return `<button type="button" class="product-button ${CAT_TONE[pf.categoryOf(p)]}" data-add="${p.id}" title="${safe(p.name)} · ${money(p.price_cents)} · ${why}" aria-label="${safe(p.name)}, ${money(p.price_cents)}, ${why}" ${p.available<1||!shift?'disabled':''}><span class="pb-name">${pf.isFavorite(p)?icon('star','pb-fav'):''}${safe(pf.displayName(p.name))}</span><span class="pb-foot"><strong>${money(p.price_cents)}</strong><small class="${p.available<1?'out':p.available<=3?'low':''}">${p.available>0?`${p.available} disp.`:p.stock>0?'Reservado':'Sem estoque'}</small><span class="pb-add">${icon('plus')}</span></span></button>`;
}
// Nothing found: says where it looked and offers the way out (all categories, the other channel, or no filters).
function noProductFound(all,f){
 const pf=PF(),other=f.channel==='loja'?'delivery':'loja',search=f.search.trim();
 const inAll=f.category!==pf.ALL?pf.filterProducts(all,{...f,category:pf.ALL}).length:0;
 const inOther=search?pf.filterProducts(all,{...f,channel:other,category:pf.ALL}).length:0;
 const where=f.category===pf.ALL?pf.CHANNEL_LABEL[f.channel]:`${f.category} · ${pf.CHANNEL_LABEL[f.channel]}`;
 return `<div class="empty qp-empty">${icon('search','lg')}<strong>Nenhum produto encontrado</strong><span>${search?`“${safe(search)}” em `:''}${safe(where)}</span><div class="qp-empty-actions">${inAll?`<button type="button" class="secondary" data-qp-cat="${pf.ALL}">Ver ${plural(inAll,'resultado','resultados')} em Todos</button>`:''}${inOther?`<button type="button" class="secondary" data-qp-channel="${other}">Ver ${inOther} ${other==='delivery'?'no Delivery':'na Loja física'}</button>`:''}<button type="button" class="link-btn" data-qp-reset>Limpar filtros</button></div></div>`;
}
function setChannel(channel,category=null){productFilters.channel=channel;productFilters.category=category;if(state.activeSaleId)channelBySale.set(state.activeSaleId,channel);renderQuickProducts();}
function clearSearch(){$('qp-search').value='';productFilters.search='';$('qp-clear').classList.add('hidden');renderQuickProducts();}
function addProduct(id){return run('/api/cart/unit',{saleId:state.activeSaleId,id:Number(id),quantity:1});}
// Arrow keys, Home and End move through a row of tabs and select the one reached (focus first: the repaint that
// follows the click puts the focus back on the chip that has it).
function tabKeys(container,e){
 const list=[...container.querySelectorAll('[role="tab"]')],i=list.indexOf(document.activeElement);if(i<0)return;
 const next={ArrowRight:i+1,ArrowLeft:i-1,Home:0,End:list.length-1}[e.key];if(next===undefined)return;e.preventDefault();const b=list[(next+list.length)%list.length];b.focus();b.click();
}
function renderProducts(){
 const pf=PF(),all=state.products,words=pf.normalizeSearch($('product-list-search').value).split(' ').filter(Boolean),manage=can('products.manage');
 $('product-form-card').classList.toggle('hidden',!manage);
 const list=words.length?all.filter(p=>{const text=pf.normalizeSearch(`${p.name} ${pf.categoryOf(p)} ${pf.CHANNEL_LABEL[p.channel]||''}`);return words.every(w=>text.includes(w));}):all;
 $('product-list-count').textContent=!all.length?'':list.length===all.length?plural(all.length,'produto','produtos'):`${list.length} de ${all.length}`;
 paint('product-list',!all.length?emptyState('box','Nenhum produto cadastrado','Use o formulário ao lado para cadastrar o primeiro item.'):!list.length?emptyState('search','Nenhum produto encontrado','Busque por outro nome, categoria ou canal.')
  :list.map(p=>{const fav=pf.isFavorite(p),label=fav?'Remover dos favoritos':'Marcar como favorito';return `<div class="rowline"><span class="tone-dot ${CAT_TONE[pf.categoryOf(p)]}"></span><div class="grow"><strong>${safe(p.name)}</strong><small>${money(p.price_cents)} · ${safe(pf.categoryOf(p))} · ${pf.CHANNEL_LABEL[p.channel]||safe(p.channel)}${p.reserved?` · ${p.reserved} em vendas abertas`:''}</small></div><span class="stock ${p.stock<1?'out':p.stock<=5?'low':''}">${p.stock<1?'Sem estoque':p.stock+' un.'}</span>${manage?`<div class="row-buttons"><button type="button" class="star-btn${fav?' on':''}" data-fav="${p.id}" aria-pressed="${fav}" aria-label="${label}: ${safe(p.name)}" title="${label}">${icon('star')}</button><button class="secondary" data-edit="${p.id}">Editar</button><button class="danger" data-delete="${p.id}" aria-label="Excluir ${safe(p.name)}" title="Excluir">${icon('trash')}</button></div>`:''}</div>`;}).join(''));
}
// The Balança screen: connecting the scale needs "scale.manage"; the simulator card shows only where it works.
function renderScaleAccess(){
 const manage=can('scale.manage');$('scale-connect-card').classList.toggle('hidden',!manage);$('scale-locked').classList.toggle('hidden',manage);
 $('demo-scale-card').classList.toggle('hidden',!state.simulator);
}
function renderEmployees(){
 const manage=can('employees.manage');$('employee-form-card').classList.toggle('hidden',!manage);
 paint('employee-list',!manage?`<div class="notice">${icon('lock')}<span>O cadastro da equipe fica com o administrador.</span></div>`:state.employees.length?state.employees.map(e=>`<div class="rowline"><span class="avatar">${safe(initials(e.name))}</span><div class="grow"><strong>${safe(e.name)}</strong>${state.operator?.id===e.id?'<small class="pos">No caixa agora</small>':''}</div><div class="row-buttons"><button class="secondary" data-emp-edit="${e.id}">Editar</button><button class="danger" data-emp-remove="${e.id}" aria-label="Desativar ${safe(e.name)}" title="Desativar">${icon('trash')}</button></div></div>`).join(''):emptyState('users','Nenhum funcionário','Cadastre quem vai operar o caixa.'));
}
function setManualMode(m){
 manualMode=m;document.querySelectorAll('[data-manual]').forEach(b=>b.setAttribute('aria-selected',b.dataset.manual===m));
 $('manual-label').textContent=m==='weight'?'Peso do copo':'Valor a cobrar';$('manual-prefix').textContent=m==='weight'?'':'R$';$('manual-unit').textContent=m==='weight'?'kg':'';
 $('manual-input').placeholder=m==='weight'?'0,450':'25,00';updateManualPreview();
}
function updateManualPreview(){
 const v=$('manual-input').value.trim(),kg=state.config.priceKgCents;let text;
 if(manualMode==='weight'){const m=v.replace(/\s*kg$/i,'').match(/^(\d{1,2})(?:[.,](\d{1,3}))?$/);const g=m?Number(m[1])*1000+Number((m[2]||'').padEnd(3,'0')):0;text=g?`${weight(g)} kg × ${money(kg)}/kg = ${money(Math.round(g*kg/1000))}`:`Digite em quilos, ex.: 0,450 · preço atual ${money(kg)}/kg`;}
 else text='Para cobrar um valor fechado quando não for possível pesar.';
 $('manual-preview').textContent=text;
}
function openManual(){if(!state.cash.shift||!state.activeSale)return flash('Abra o caixa para vender',true);
 // Weight typed and value typed are separate permissions: only the allowed ones are offered.
 const w=can('sales.manual_weight'),v=can('sales.manual_value');if(!w&&!v)return flash('Você não tem permissão para esta operação. Peça ao administrador.',true);
 document.querySelector('[data-manual="weight"]').classList.toggle('hidden',!w);document.querySelector('[data-manual="value"]').classList.toggle('hidden',!v);
 if(!w)manualMode='value';else if(!v)manualMode='weight';
 $('manual-target').textContent=state.activeSale.label;$('manual-input').value='';setManualMode(manualMode);$('manual-dialog').showModal();$('manual-input').focus();}
async function renderHistory(){
 try{const p=new URLSearchParams();const q=$('hist-q').value.trim();
 if(q)p.set('q',q);else{p.set('from',$('hist-from').value);p.set('to',$('hist-to').value);if($('hist-status').value)p.set('status',$('hist-status').value);}
 const r=await get('/api/sales?'+p);const done=r.sales.filter(x=>x.status==='done'),canceled=r.sales.length-done.length;
 // Without the reports permission the server lists only the sales of the open shift.
 $('hist-summary').innerHTML=`${r.shiftOnly?`<span class="tag">${icon('lock')}Só as vendas do caixa aberto</span>`:''}<span>${plural(r.sales.length,'venda','vendas')}</span><span>Concluídas: <strong>${money(done.reduce((s,x)=>s+x.total_cents,0))}</strong></span>${canceled?`<span class="neg">${plural(canceled,'cancelada','canceladas')}</span>`:''}${r.sales.length>=500?'<span>Mostrando as 500 mais recentes</span>':''}`;
 $('hist-list').innerHTML=r.sales.length?`<div class="table-wrap"><table class="table clickable"><thead><tr><th>Venda</th><th>Data e hora</th><th>Operador</th><th>Itens</th><th>Pagamento</th><th>Total</th><th>Situação</th></tr></thead><tbody>${r.sales.map(x=>`<tr data-sale="${x.id}" tabindex="0"><td><strong>#${x.id}</strong></td><td>${date(x.created_at)}</td><td>${safe(x.operator_name||'—')}</td><td>${x.item_count}${x.has_manual?' <span class="tag warn">digitado</span>':''}</td><td><span class="tag">${safe(PAY[x.method])}</span></td><td><strong class="${x.status==='canceled'?'strike':''}">${money(x.total_cents)}</strong></td><td>${x.status==='canceled'?'<span class="tag off">Cancelada</span>':'<span class="tag on">Concluída</span>'}</td></tr>`).join('')}</tbody></table></div>`:emptyState('receipt','Nenhuma venda encontrada',r.shiftOnly?'Aparecem aqui só as vendas do caixa aberto. As anteriores ficam nos relatórios.':'Ajuste as datas, a situação ou o número da venda.');
 }catch(e){flash(e.message,true);}
}
async function openSale(id){
 try{const s=await get('/api/sales/detail?id='+id);currentSale=s;
 $('sale-title').innerHTML=`Venda #${s.id} ${s.status==='canceled'?'<span class="tag off">Cancelada</span>':'<span class="tag on">Concluída</span>'}`;
 $('sale-body').innerHTML=`<div class="sale-meta"><div><small>Data e hora</small><strong>${date(s.created_at)}</strong></div><div><small>Operador</small><strong>${safe(s.operator_name||'—')}</strong></div><div><small>Pagamento</small><strong>${safe(PAY[s.method])}</strong></div><div><small>Itens</small><strong>${s.items.length}</strong></div>${s.draft_label?`<div><small>Atendimento</small><strong>${safe(s.draft_label)}</strong></div>`:''}</div>
  <div class="sale-items">${s.items.map(i=>`<div class="rowline"><div class="grow"><strong>${safe(i.label)}${i.manual?' <span class="tag warn">digitado</span>':''}</strong><small>${itemLine(i.kind,i.grams,i.quantity,i.unit_cents)}</small></div><strong>${money(i.total_cents)}</strong></div>`).join('')}</div>
  <div class="sale-total ${s.status==='canceled'?'is-canceled':''}"><span>Total</span><strong>${money(s.total_cents)}</strong></div>
  ${s.received_cents!=null?`<div class="sale-change"><div class="rowline"><span>Valor recebido</span><strong>${money(s.received_cents)}</strong></div><div class="rowline"><span>Troco</span><strong>${money(s.change_cents)}</strong></div></div>`:''}
  ${s.status==='canceled'?`<div class="notice danger">${icon('alert')}<span><strong>Cancelada por ${safe(s.canceled_by_name||'—')}</strong> em ${date(s.canceled_at)}.<br/>Motivo: ${safe(s.cancel_reason)}</span></div>`:!s.cancelable?`<div class="notice">${icon('info')}<span>Vendas de caixas já fechados não podem ser canceladas, para não alterar um fechamento já conferido.</span></div>`:''}`;
 const cancel=can('sales.cancel'),correct=can('sales.correct');$('btn-sale-cancel').classList.toggle('hidden',!cancel);$('btn-sale-correct').classList.toggle('hidden',!correct);
 $('sale-actions').classList.toggle('hidden',!s.cancelable||(!cancel&&!correct));$('sale-dialog').showModal();
 }catch(e){flash(e.message,true);}
}
function periodLabel(r){
 if(r.period==='day')return r.from===r.today?`Hoje, ${br(r.from).slice(0,5)}`:`${dayShort(r.from)}/${r.from.slice(0,4)}`;
 if(r.period==='week')return `${br(r.from).slice(0,5)} a ${br(r.to)}`;
 return `${MONTHS[+r.from.slice(5,7)-1]} de ${r.from.slice(0,4)}`;
}
async function renderReports(){
 try{const r=await get(`/api/report?period=${reportPeriod}${reportDate?'&date='+reportDate:''}`);currentReport=r;reportDate=r.date;
 document.querySelectorAll('[data-period]').forEach(b=>b.setAttribute('aria-selected',b.dataset.period===reportPeriod));
 $('report-label').textContent=periodLabel(r);$('report-next').disabled=r.to>=r.today;
 // Without "cash.view_expected" the report comes without the totals per payment method (r.blind).
 const methods=r.methods?[['Pix',money(r.methods.pix),'pix','t-green'],['Dinheiro',money(r.methods.cash),'cash','t-yellow'],['Débito',money(r.methods.debit),'card','t-orange'],['Crédito',money(r.methods.credit),'card','t-lilac']]:[];
 $('report-stats').innerHTML=[['Total vendido',money(r.totalCents),'chart','t-berry feature'],['Vendas',r.count,'receipt','t-lilac'],['Ticket médio',money(r.avgTicketCents),'tag','t-pink'],['Açaí pesado',`${weight(r.grams)} kg`,'scale','t-lime'],...methods,['Cancelamentos',r.canceled.count,'x','t-red',money(r.canceled.totalCents)],['Lançamentos digitados',r.manual.count,'keyboard','t-yellow',money(r.manual.totalCents)]]
  .map(([label,value,ic,cls,sub])=>`<div class="stat ${cls}"><span class="stat-icon">${icon(ic)}</span><small>${label}</small><strong>${value}</strong>${sub!==undefined?`<small class="sub">${sub}</small>`:''}</div>`).join('');
 renderChart(r);
 const best=Math.max(...r.byOperator.map(o=>o.totalCents),0);
 $('report-operators').innerHTML=r.byOperator.length?r.byOperator.map(o=>`<div class="rowline"><span class="avatar">${safe(initials(o.name))}</span><div class="grow"><strong>${safe(o.name)}</strong><small>${plural(o.count,'venda','vendas')}</small><span class="share"><span data-w="${best?Math.round(o.totalCents/best*100):0}"></span></span></div><strong>${money(o.totalCents)}</strong></div>`).join(''):emptyState('users','Sem vendas no período','');
 const closedAt=x=>x.closed_at?(new Date(x.closed_at).toDateString()===new Date(x.opened_at).toDateString()?time:date)(x.closed_at)+(x.closed_by_name&&x.closed_by_name!==x.opened_by_name?' · '+safe(x.closed_by_name):''):'<span class="tag on">Aberto</span>';
 // The closings: only with "cash.view_history"; their amounts only with "cash.view_expected" (otherwise only whether
 // the count matched).
 $('report-shifts').innerHTML=!can('cash.view_history')?emptyState('lock','Fechamentos com o administrador','Os fechamentos de caixa aparecem para quem tem a permissão de ver o histórico do caixa.')
  :!r.shifts.length?emptyState('wallet','Nenhum caixa no período','')
  :r.blind?`<div class="table-wrap"><table class="table"><thead><tr><th>Abertura</th><th>Operador</th><th>Fechamento</th><th>Conferência</th></tr></thead><tbody>${r.shifts.map(x=>{const st=CLOSE_STATUS[x.status];return `<tr><td>${date(x.opened_at)}</td><td>${safe(x.opened_by_name||'—')}</td><td>${closedAt(x)}</td><td>${st?`<span class="tag ${st[1]==='pos'?'on':st[1]==='neg'?'off':'warn'}">${st[0]}</span>`:'—'}</td></tr>`;}).join('')}</tbody></table></div>`
  :`<div class="table-wrap"><table class="table"><thead><tr><th>Abertura</th><th>Operador</th><th>Fechamento</th><th>Esperado</th><th>Contado</th><th>Diferença</th></tr></thead><tbody>${r.shifts.map(x=>`<tr><td>${date(x.opened_at)}</td><td>${safe(x.opened_by_name||'—')}</td><td>${closedAt(x)}</td><td>${x.closed_at?money(x.expected_cents):'—'}</td><td>${x.closed_at?money(x.counted_cents):'—'}</td><td><strong class="${x.difference_cents<0?'neg':x.difference_cents>0?'pos':''}">${x.closed_at?signed(x.difference_cents):'—'}</strong></td></tr>`).join('')}</tbody></table></div>`;
 // Widths/heights go through CSSOM: the page CSP blocks inline style attributes.
 document.querySelectorAll('#report-operators [data-w]').forEach(el=>el.style.width=el.dataset.w+'%');
 }catch(e){flash(e.message,true)}
}
function renderChart(r){
 const card=$('report-chart-card');card.classList.toggle('hidden',r.period==='day');if(r.period==='day')return;
 const max=Math.max(...r.byDay.map(d=>d.totalCents),0);const top=max?r.byDay.find(d=>d.totalCents===max):null;
 $('chart-note').textContent=top?`Melhor dia: ${dayShort(top.day)} · ${money(top.totalCents)}`:'Sem vendas no período';
 $('report-chart').className='bars '+r.period;
 $('report-chart').innerHTML=r.byDay.map(d=>{const dd=+d.day.slice(8);const label=r.period==='week'?WEEK[new Date(utc(d.day)).getUTCDay()]:(dd===1||dd%5===0?dd:'');const h=max?Math.max(d.totalCents/max*100,d.totalCents?1.5:0):0;
  return `<div class="bar-col${d.day===r.today?' today':''}" tabindex="0" aria-label="${dayShort(d.day)}: ${money(d.totalCents)}, ${plural(d.count,'venda','vendas')}"><div class="bar-tip">${dayShort(d.day)}<strong>${money(d.totalCents)}</strong>${plural(d.count,'venda','vendas')}</div><div class="bar-track"><div class="bar${d===top?' top':''}" data-h="${h.toFixed(1)}" data-v="${money(d.totalCents)}"></div></div><span class="bar-x">${label}</span></div>`;}).join('');
 document.querySelectorAll('#report-chart .bar').forEach(el=>el.style.height=el.dataset.h+'%');
 $('report-chart-table').innerHTML=`<div class="table-wrap"><table class="table"><thead><tr><th>Dia</th><th>Vendas</th><th>Total</th></tr></thead><tbody>${r.byDay.map(d=>`<tr><td>${dayShort(d.day)}</td><td>${d.count}</td><td><strong>${money(d.totalCents)}</strong></td></tr>`).join('')}</tbody></table></div>`;
}
// The cloud copy, in a discreet badge: only while something waits to be sent and the internet failed (or the send
// takes over a minute). Selling never depends on it; the badge goes away by itself once everything was sent.
function cloudBadge(s){
 const b=$('cloud-badge');const show=!!s&&s.pendingChanges>0&&(s.state!=='enviando'||s.waitingMs>60000);
 b.classList.toggle('hidden',!show);if(!show)return;
 // On a narrow screen only the short part shows: "Sem internet · 2 vendas" (or just "Sem internet").
 const head=s.state==='sem-conexao'?'Sem internet':s.state==='enviando'?'Enviando à nuvem':'Nuvem com problema';
 b.className='pill cloud-badge'+(s.state==='erro'||s.state==='outro-dono'?' bad':'');
 b.innerHTML=s.pendingSales?`${head} · ${plural(s.pendingSales,'venda','vendas')}<span class="cloud-more"> aguardando envio</span>`
  :`${head}<span class="cloud-more"> · dados aguardando envio</span>`;
 b.title=s.state==='sem-conexao'?'As vendas continuam normalmente e ficam guardadas neste computador. Elas vão para a nuvem sozinhas quando a internet voltar.'
  :s.state==='enviando'?'As vendas estão sendo enviadas para a nuvem.':'As vendas continuam normalmente. Avise o administrador: a cópia na nuvem precisa de atenção.';
}
// A problem with the server or the database shows as a banner on every screen (not a toast every 850 ms); it goes
// away by itself when the next refresh works. The Admin area keeps working meanwhile.
function systemBanner(e){
 const b=$('system-banner');b.classList.toggle('hidden',!e);if(!e)return;
 const offline=!e.status;$('system-banner-title').textContent=offline?'Sem comunicação com o Luminor PDV':e.status===503&&/Restaur|Copiando|Ativando|Voltando/.test(e.message)?'Aguarde um instante':'Vendas pausadas';
 $('system-banner-text').textContent=offline?'Verifique se o programa está aberto neste computador. A tela volta sozinha quando ele responder.':e.message;
}
// One refresh at a time: with a slow database (cloud), a new request every 850 ms on top of the unanswered ones would
// pile up on the server and make every sale wait behind them. A refresh asked while one is on its way (for example
// right after a sale) runs once more when it ends, so the screen never stays with data from before the change.
let refreshing=null,refreshAgain=null;
// A 401 is not a server problem: the sign-in screen takes over (get() already opened it).
async function loadState(){try{state=await get('/api/state');systemBanner(null);render();}catch(e){systemBanner(e.status===401?null:e);}}
function refresh(){
 if(!refreshing){refreshing=loadState().finally(()=>{refreshing=null;});return refreshing;}
 if(!refreshAgain)refreshAgain=refreshing.then(()=>{refreshAgain=null;return refresh();});
 return refreshAgain;
}
// The next automatic refresh is scheduled only after the previous one answered.
// Slower while nobody is signed in: the screen only waits for someone to sign in.
async function poll(){await refresh();setTimeout(poll,document.hidden?3000:loginOpen()||setupMode?2500:850);}
// Screens: only the ones this person may open (state.auth.screens, decided on the server).
const allowedTab=name=>setupMode?name==='configuracoes':!!state.auth?.screens?.includes(name);
function showPanel(name){activeTab=name;document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.querySelectorAll('main section.panel').forEach(el=>el.classList.toggle('hidden',el.id!==name));window.scrollTo({top:0});}
function tab(name){
 if(!allowedTab(name))return flash('Esta tela não está liberada para você. Peça ao administrador.',true);
 showPanel(name);if(name==='relatorios')renderReports();if(name==='historico')renderHistory();if(name==='configuracoes')window.LuminorAdmin?.open();
}
// The menu shows only the allowed screens; a screen no longer allowed (permission removed) gives way to the first one.
function applyAccess(){
 const screens=setupMode?['configuracoes']:state.auth?.screens||[];
 document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('hidden',!screens.includes(b.dataset.tab)));
 document.querySelectorAll('.sidebar-head').forEach(h=>{const tabs=[];for(let n=h.nextElementSibling;n&&!n.classList.contains('sidebar-head');n=n.nextElementSibling)if(n.dataset.tab)tabs.push(n.dataset.tab);h.classList.toggle('hidden',!tabs.some(t=>screens.includes(t)));});
 if(!screens.length){if(activeTab!=='sem-acesso')showPanel('sem-acesso');}else if(!screens.includes(activeTab))tab(screens[0]);
}

// --- Who is at the till: sign-in with the PIN, the administrator, lock and sign-out -------------------------------
// The session is an HttpOnly cookie this page cannot read; the screen only learns who is signed in from the server.
const L={mode:'people',person:null,locked:null,options:null,adminState:null};
let setupMode=false,loginTicket=0;
const loginOpen=()=>!$('login-screen').classList.contains('hidden');
function signedOut(){if(setupMode||loginOpen())return;showLogin();}
// What the previous person saw does not stay in the page for the next one.
function forget(){
 state={};currentReport=null;currentSale=null;cashControlKey=null;lastActive=null;
 for(const id of ['hist-list','hist-summary','report-stats','report-operators','report-shifts','report-chart','report-chart-table','sale-body','cash-summary','cash-events','cash-controls','cash-open-sales','cart-items','product-list','employee-list','quick-products','capture-pending']){const el=$(id);if(el){el.innerHTML='';el._html=undefined;}}
 $('cash-received').value='';$('product-form').reset();$('employee-form').reset();
}
async function showLogin(){
 const ticket=++loginTicket;
 if(!loginOpen()){forget();document.querySelectorAll('dialog[open]').forEach(d=>d.close());$('login-screen').classList.remove('hidden');document.body.classList.add('signed-out');background(false);}
 L.mode='people';L.person=null;L.locked=null;loginError('');
 const [s,o,adm]=await Promise.all([get('/api/auth/session').catch(()=>null),get('/api/auth/options').catch(e=>({operators:[],admin:false,error:e.message})),
  fetch('/api/admin/session',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null)]);
 if(ticket!==loginTicket)return;
 L.options=o;L.adminState=adm?.state||null;
 if(s?.authenticated){hideLogin();await refresh();return goHome(activeTab);}
 if(s?.locked){L.locked=s.person;if(s.person.kind==='admin')L.mode='admin';else{L.person=o.operators.find(x=>x.uuid===s.person.uuid)||null;L.mode=L.person?'pin':'people';}}
 else if(!o.operators.length&&o.admin)L.mode='admin';
 drawLogin();
}
function drawLogin(focus=true){
 const o=L.options||{operators:[]},people=o.operators||[],mode=L.mode,locked=mode!=='people'&&L.locked;
 $('login-title').textContent=locked?'Caixa bloqueado':mode==='admin'?'Acesso do administrador':'Quem está no caixa?';
 $('login-sub').textContent=locked?`Bloqueado por ${locked.name}. As vendas abertas e a balança continuam como estavam.`:mode==='pin'?'Digite o seu PIN para entrar.':mode==='admin'?'Usuário e senha do administrador do sistema.':people.length?'Toque no seu nome e digite o seu PIN.':'';
 $('login-icon').innerHTML=icon(locked?'lock':mode==='admin'?'shield':'user');
 const note=o.error||(mode==='admin'&&L.adminState==='inicial'?'Primeiro acesso: usuário admin e senha admin. Em seguida você cria a senha definitiva.'
  :mode==='admin'&&L.adminState==='recuperacao'?'A senha do administrador precisa ser redefinida: toque em "Esqueci a senha do administrador".'
  :!people.length?'Nenhum funcionário tem PIN para o caixa ainda. O administrador define o PIN de cada pessoa em Configurações › Administração do sistema › Usuários e permissões.':'');
 $('login-notice').textContent=note;$('login-notice').classList.toggle('hidden',!note);
 $('login-people').classList.toggle('hidden',mode!=='people');
 paint('login-people',people.map(p=>`<button type="button" class="op-option" data-login="${safe(p.uuid)}"><span class="avatar">${safe(initials(p.name))}</span><span>${safe(p.name)}</span></button>`).join(''));
 $('login-pin-form').classList.toggle('hidden',mode!=='pin');$('login-admin-form').classList.toggle('hidden',mode!=='admin');
 if(mode==='pin'&&L.person){$('login-name').textContent=L.person.name;$('login-avatar').textContent=initials(L.person.name);$('login-other').textContent=locked?'Entrar com outra pessoa':'Outra pessoa';$('login-other').classList.toggle('hidden',!locked&&people.length<2);}
 if(mode==='admin'&&locked?.kind==='admin'&&!$('login-admin-user').value)$('login-admin-user').value=locked.username||'';
 $('login-back').classList.toggle('hidden',mode!=='admin'||!people.length);$('login-back').lastChild.textContent=locked?'Entrar com outra pessoa':'Voltar';
 $('login-admin-link').classList.toggle('hidden',mode==='admin'||!o.admin);
 $('login-admin-forgot').classList.toggle('hidden',mode!=='admin'||!!o.demo||!L.adminState);
 $('login-demo').classList.toggle('hidden',!o.demo?.hint);$('login-demo').textContent=o.demo?.hint||'';
 if(focus)(mode==='pin'?$('login-pin'):mode==='admin'?($('login-admin-user').value?$('login-admin-password'):$('login-admin-user')):$('login-people').querySelector('button'))?.focus();
}
function loginError(msg){for(const id of ['login-error','login-admin-error']){$(id).textContent=msg;$(id).classList.toggle('hidden',!msg||(id==='login-error')!==(L.mode==='pin'));}}
// Behind the sign-in nothing can be reached with the keyboard or a screen reader.
function background(on){for(const el of document.querySelectorAll('.topbar,.shell'))el.inert=!on;}
function hideLogin(){++loginTicket;$('login-screen').classList.add('hidden');document.body.classList.remove('signed-out');background(true);$('login-pin').value='';$('login-admin-password').value='';loginError('');}
// The first screen this person may open (or where they were, when the same person unlocks the till).
function goHome(prefer){const screens=state.auth?.screens||[];if(!screens.length)return showPanel('sem-acesso');tab(prefer&&screens.includes(prefer)?prefer:screens[0]);}
async function signIn(body,btn){
 if(btn.disabled)return;btn.disabled=true;btn.classList.add('busy');loginError('');const before=L.locked;
 try{
  const r=(await post('/api/auth/login',body)).result;
  // The administrator's first access (or a forced change): the new password first, in the Admin area.
  if(r.mustChangePassword)return enterSetup('password',body.password);
  hideLogin();await refresh();
  const same=before&&r.session.person&&before.kind===r.session.person.kind&&before.name===r.session.person.name;
  goHome(same?activeTab:null);flash(`Olá, ${r.session.person?.name||''}`);
 }catch(e){loginError(e.message);const f=body.pin?$('login-pin'):$('login-admin-password');f.value='';f.focus();}
 finally{btn.disabled=false;btn.classList.remove('busy');}
}
// Setup: the administrator creates the definitive password (or recovers the access) in the Admin area, before the till.
function enterSetup(view,current=null){
 setupMode=true;hideLogin();forget();document.body.classList.add('setup');applyAccess();showPanel('configuracoes');
 $('operator-name').textContent='Entrar';$('operator-role').textContent='Operador';
 window.LuminorAdmin?.start(view,{current});
}
function leaveSetup(){setupMode=false;document.body.classList.remove('setup');}
// The administrator signed in to the Admin area (password set, recovered or typed): they take the till with the same
// sign-in, if nobody is signed in there.
window.addEventListener('luminor-admin-ready',async()=>{
 if(!setupMode&&state.auth?.authenticated)return;
 try{await post('/api/admin/pos-session');leaveSetup();hideLogin();await refresh();goHome('configuracoes');flash('Administrador no caixa');}
 catch(e){flash(e.message,true);}
});
window.addEventListener('luminor-admin-signed-out',()=>{if(setupMode){leaveSetup();showLogin();}});
function openOperatorMenu(){
 if(setupMode){leaveSetup();return showLogin();}
 const a=state.auth;if(!a?.authenticated)return showLogin();
 const admin=a.person.kind==='admin';$('operator-title').textContent=a.person.name;$('operator-menu-avatar').innerHTML=admin?icon('shield'):safe(initials(a.person.name));
 $('operator-menu-text').textContent=admin?'Você está no caixa como administrador: tudo fica liberado e vai para o registro administrativo. Bloqueie ou saia ao terminar.':'As vendas, sangrias e cancelamentos ficam registrados com o seu nome.';
 $('operator-dialog').showModal();$('btn-lock').focus();
}
async function lockTill(){try{await post('/api/auth/lock');$('operator-dialog').close();showLogin();}catch(e){flash(e.message,true);}}
async function signOut(){
 if(!state.canSwitch)return flash('Retire o produto da balança antes de sair.',true);
 try{await post('/api/auth/logout');$('operator-dialog').close();showLogin();}catch(e){flash(e.message,true);}
}
async function boot(){
 // "Automática" lets the server classify a new product by its name; editing shows the category it has.
 $('product-category').innerHTML='<option value="">Automática (pelo nome)</option>'+PF().CATEGORIES.map(c=>`<option value="${safe(c)}">${safe(c)}</option>`).join('');
 try{TOKEN=(await get('/api/session')).token;}catch(e){flash(e.message,true);}await poll();
 $('hist-from').value=$('hist-to').value=localToday();
 document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.tab)));
 document.addEventListener('click',e=>{const b=e.target.closest('[data-goto]');if(!b)return;b.closest('dialog')?.close();tab(b.dataset.goto);(b.dataset.goto==='caixa'?$('opening-amount'):b.dataset.goto==='funcionarios'?$('employee-name'):null)?.focus();});
 $('operator-btn').addEventListener('click',openOperatorMenu);
 $('btn-lock').addEventListener('click',lockTill);$('btn-logout').addEventListener('click',signOut);
 $('login-people').addEventListener('click',e=>{const b=e.target.closest('[data-login]');if(!b)return;L.person=(L.options?.operators||[]).find(x=>x.uuid===b.dataset.login)||null;if(!L.person)return;L.mode='pin';$('login-pin').value='';loginError('');drawLogin();});
 const otherPerson=()=>{L.mode='people';L.person=null;L.locked=null;loginError('');drawLogin();};
 $('login-other').addEventListener('click',otherPerson);$('login-back').addEventListener('click',otherPerson);
 $('login-admin-link').addEventListener('click',()=>{L.mode='admin';loginError('');drawLogin();});
 $('login-admin-forgot').addEventListener('click',()=>enterSetup('recover'));
 $('login-pin').addEventListener('input',e=>{const v=e.target.value.replace(/\D/g,'').slice(0,8);if(v!==e.target.value)e.target.value=v;});
 $('login-pin-form').addEventListener('submit',e=>{e.preventDefault();const pin=$('login-pin').value;if(!L.person)return otherPerson();
  if(!/^\d{6,8}$/.test(pin))return loginError('O PIN tem de 6 a 8 números.');signIn({employeeUuid:L.person.uuid,pin},$('login-pin-ok'));});
 $('login-admin-form').addEventListener('submit',e=>{e.preventDefault();const username=$('login-admin-user').value.trim(),password=$('login-admin-password').value;
  if(!username||!password)return loginError('Digite o usuário e a senha do administrador.');signIn({mode:'admin',username,password},$('login-admin-ok'));});
 $('btn-price').addEventListener('click',()=>run('/api/config',{priceKg:$('price-kg').value},()=>flash('Preço por quilo atualizado')));
 $('price-kg').addEventListener('keydown',e=>{if(e.key==='Enter')$('btn-price').click();});
 $('auto-capture').addEventListener('change',e=>run('/api/config',{autoCapture:e.target.checked},()=>flash('Configuração salva')));
 $('btn-capture').addEventListener('click',()=>run('/api/cart/weight',{saleId:state.activeSaleId},r=>flash(`Pesagem adicionada a ${r.label}`)));
 $('capture-pending').addEventListener('click',async e=>{const retry=e.target.closest('[data-retry]'),drop=e.target.closest('[data-drop]');
  if(retry)run('/api/scale/pending/retry',{captureId:retry.dataset.retry},r=>flash(`Pesagem gravada em ${r.label}`));
  if(drop&&await ask('Descartar esta pesagem?','Ela não entra em nenhuma venda. Se o cliente ainda estiver aqui, pese de novo ou digite o peso.',{confirmLabel:'Descartar pesagem',tone:'danger-solid'}))run('/api/scale/pending/discard',{captureId:drop.dataset.drop});});
 $('sale-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-sale]');if(b)selectSale(b.dataset.sale);});
 $('sale-tabs').addEventListener('keydown',e=>{const list=[...$('sale-tabs').querySelectorAll('[data-sale]')],i=list.indexOf(document.activeElement);if(i<0)return;
  const next={ArrowRight:i+1,ArrowLeft:i-1,Home:0,End:list.length-1}[e.key];if(next===undefined)return;e.preventDefault();list[(next+list.length)%list.length].focus();});
 $('btn-new-sale').addEventListener('click',()=>{if(!state.canSwitch)return flash('Retire o produto da balança para abrir outra venda.',true);run('/api/open-sales/create');});
 $('sale-name').addEventListener('click',startRename);
 $('sale-name-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finishRename(true);}if(e.key==='Escape'){e.preventDefault();finishRename(false);}});
 $('sale-name-input').addEventListener('blur',()=>finishRename(true));
 $('transfer-options').addEventListener('click',e=>{const b=e.target.closest('[data-to]');if(!b)return;transferTo=b.dataset.to;
  document.querySelectorAll('#transfer-options [data-to]').forEach(x=>x.setAttribute('aria-checked',x===b));$('transfer-ok').disabled=false;});
 $('transfer-options').addEventListener('dblclick',e=>{if(e.target.closest('[data-to]'))$('transfer-form').requestSubmit();});
 $('transfer-cancel').addEventListener('click',()=>$('transfer-dialog').close());
 $('transfer-form').addEventListener('submit',async e=>{e.preventDefault();if(!transferTo)return;
  const r=await run('/api/open-sales/transfer-item',{saleId:transferFrom,key:transferKey,toSaleId:transferTo},r=>flash(`Item transferido para ${r.to.label}`));if(r)$('transfer-dialog').close();});
 $('btn-discard').addEventListener('click',async()=>{const sale=state.activeSale,n=state.cart.length;if(!sale)return;
  if(n&&!await ask(`Descartar ${sale.label}?`,`${plural(n,'item','itens')} · ${money(state.cartTotalCents)}. Os itens saem da venda e nada é cobrado.`,{confirmLabel:'Descartar venda',tone:'danger-solid'}))return;
  run('/api/open-sales/discard',{saleId:sale.id},()=>flash(`${sale.label} descartada`));});
 $('cash-open-sales').addEventListener('click',e=>{const b=e.target.closest('[data-open-sale]');if(!b)return;tab('vendas');if(b.dataset.openSale!==state.activeSaleId)selectSale(b.dataset.openSale);});
 $('btn-manual').addEventListener('click',openManual);
 document.querySelectorAll('[data-manual]').forEach(b=>b.addEventListener('click',()=>{setManualMode(b.dataset.manual);$('manual-input').focus();}));
 $('manual-input').addEventListener('input',updateManualPreview);
 $('manual-cancel').addEventListener('click',()=>$('manual-dialog').close());
 $('manual-form').addEventListener('submit',async e=>{e.preventDefault();const v=$('manual-input').value;const weightMode=manualMode==='weight';
  const ok=await run(weightMode?'/api/cart/manual-weight':'/api/cart/manual-value',weightMode?{saleId:state.activeSaleId,weight:v}:{saleId:state.activeSaleId,amount:v},r=>flash(weightMode?`Peso digitado adicionado a ${r.label}`:`Valor digitado adicionado a ${r.label}`));
  if(ok)$('manual-dialog').close();else{$('manual-input').focus();$('manual-input').select();}});
 $('payment-method').addEventListener('click',e=>{const b=e.target.closest('[data-pay]');if(!b)return;setPay(b.dataset.pay);if(b.dataset.pay==='cash')$('cash-received').focus();});
 $('cash-received').addEventListener('input',render);
 $('cash-received').addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const c=cashState();if(c.invalid||c.short)return flash(c.invalid?'Use valor como 50,00':'Valor recebido menor que o total da venda',true);$('btn-checkout').click();});
 $('cash-quick').addEventListener('click',e=>{const b=e.target.closest('[data-received]');if(b){$('cash-received').value=b.dataset.received;render();}});
 $('payment-method').addEventListener('keydown',e=>{const step={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[e.key];if(!step)return;e.preventDefault();const list=[...document.querySelectorAll('[data-pay]')];const next=list[(list.findIndex(b=>b.dataset.pay===payMethod)+step+list.length)%list.length];setPay(next.dataset.pay);next.focus();});
 $('btn-checkout').addEventListener('click',async()=>{if(checkingOut)return;const sale=state.activeSale;if(!sale)return;const n=state.cart.length,total=state.cartTotalCents,revision=sale.revision;
  const received=payMethod==='cash'?cashState().received:null,others=state.openSales.length-1;
  if(!await ask(`Cobrar ${sale.label}?`,`${plural(n,'item','itens')} · pagamento em ${PAY[payMethod]}${others?`. ${others===1?'A outra venda continua aberta':`As outras ${others} vendas continuam abertas`}.`:''}`,{confirmLabel:`Cobrar ${money(total)}`,tone:'success',details:[['Total',money(total)],...(received!==null?[['Recebido',money(received)],['Troco',money(received-total),'pos']]:[])]}))return;
  // One request at a time, and the server charges only the total that was confirmed (revision).
  checkingOut=true;$('btn-checkout').disabled=true;
  try{const result=await run('/api/checkout',{saleId:sale.id,revision,method:payMethod,uuid:crypto.randomUUID(),...(received!==null&&{received:price(received)})});
   if(result){$('cash-received').value='';const change=result.sale.change_cents;flash(`${sale.label} cobrada · venda #${result.sale.id}${change!=null?` · troco ${money(change)}`:''}`);}}finally{checkingOut=false;render();}});
 $('quick-products').addEventListener('click',e=>{const b=e.target.closest('[data-add]');if(b)return addProduct(b.dataset.add);
  const cat=e.target.closest('[data-qp-cat]'),ch=e.target.closest('[data-qp-channel]');
  if(cat){productFilters.category=cat.dataset.qpCat;renderQuickProducts();}
  if(ch)setChannel(ch.dataset.qpChannel,PF().ALL);
  if(e.target.closest('[data-qp-reset]')){productFilters.category=null;clearSearch();$('qp-search').focus();}});
 const search=$('qp-search');
 search.addEventListener('input',()=>{productFilters.search=search.value;$('qp-clear').classList.toggle('hidden',!search.value);renderQuickProducts();});
 // Esc clears; Enter adds the product when the search left exactly one (the text stays selected: Enter again adds
 // one more, typing replaces it with the next search).
 search.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&search.value){e.preventDefault();clearSearch();}
  if(e.key!=='Enter')return;e.preventDefault();const cards=[...$('quick-products').querySelectorAll('[data-add]')];
  if(cards.length!==1)return cards.length&&flash(`${plural(cards.length,'produto encontrado','produtos encontrados')}: continue digitando ou toque no produto.`);
  if(cards[0].disabled)return flash(!state.cash.shift?'Abra o caixa para vender':`${cards[0].querySelector('.pb-name').textContent}: sem estoque disponível`,true);
  addProduct(cards[0].dataset.add).then(()=>{search.focus();search.select();});});
 $('qp-clear').addEventListener('click',()=>{clearSearch();search.focus();});
 $('qp-channel').addEventListener('click',e=>{const b=e.target.closest('[data-channel]');if(b&&b.dataset.channel!==productFilters.channel)setChannel(b.dataset.channel);});
 $('qp-channel').addEventListener('keydown',e=>tabKeys($('qp-channel'),e));
 $('qp-cats').addEventListener('click',e=>{const b=e.target.closest('[data-cat]');if(!b)return;productFilters.category=b.dataset.cat;renderQuickProducts();});
 $('qp-cats').addEventListener('keydown',e=>tabKeys($('qp-cats'),e));
 $('cart-items').addEventListener('click',e=>{const saleId=state.activeSaleId;const m=e.target.closest('[data-move]');if(m)return openTransfer(m.dataset.move);
  const r=e.target.closest('[data-remove]');if(r)return run('/api/cart/remove',{saleId,key:r.dataset.remove});const q=e.target.closest('[data-qty]');if(q)run('/api/cart/quantity',{saleId,key:q.dataset.qty,quantity:Number(q.dataset.to)});});
 $('cash-controls').addEventListener('click',async e=>{
  const id=e.target.closest('button')?.id;
  // The shift opens in the name of whoever is signed in (the server takes it from the session).
  if(id==='btn-open')run('/api/shift/open',{opening:$('opening-amount').value},()=>flash('Caixa aberto'));
  if(id==='btn-move')run('/api/shift/move',{kind:$('movement-kind').value,amount:$('movement-amount').value,note:$('movement-note').value},()=>flash('Movimentação registrada'));
  const open=(state.openSales||[]).filter(d=>d.item_count>0);
  if(id==='btn-close'&&open.length)return ask(open.length===1?'Existe 1 venda em aberto':`Existem ${open.length} vendas em aberto`,open.length===1?'Cobre ou descarte essa venda para fechar o caixa. Toque nela na lista acima para abri-la.':'Cobre ou descarte essas vendas para fechar o caixa. Toque em cada uma na lista acima para abri-la.',{alert:true,confirmLabel:'Entendi',details:open.map(d=>[d.label,money(d.total_cents)])});
  if(id!=='btn-close')return;
  const shift=state.cash.shift,counted=$('close-counted').value.trim(),blind=!!state.cash.blind;if(!shift)return;
  if(parseMoney(counted)===null)return flash(counted?'Use valor como 250,00':'Digite o dinheiro contado na gaveta.',true);
  if(!await ask('Fechar o caixa agora?',blind?`Dinheiro contado: ${money(parseMoney(counted))}. Confira antes de continuar: depois de fechado, o turno não é reaberto.`:'Confira o dinheiro contado antes de continuar. O turno será encerrado.',{confirmLabel:'Fechar turno',tone:'danger-solid'}))return;
  // shiftId: the shift that was counted. A second close (double click, another screen) is refused, never applied to the next one.
  run('/api/shift/close',{counted,shiftId:shift.id},r=>{const st=CLOSE_STATUS[r.status]||['Fechado','',''];
   if(r.blind)return ask('Caixa fechado',st[2],{alert:true,confirmLabel:'Concluir',tone:r.status==='CONFERIDO'?'success':'primary',details:[['Conferência',st[0],st[1]]]});
   return ask('Caixa fechado','Resumo do turno para conferência.',{alert:true,confirmLabel:'Concluir',tone:'success',details:[
    ['Total vendido',money(r.totalCents)],['Vendas',String(r.salesCount)+(r.canceledCount?` (${plural(r.canceledCount,'cancelada','canceladas')})`:'')],['Pix',money(r.methods.pix)],['Dinheiro',money(r.methods.cash)],['Débito',money(r.methods.debit)],['Crédito',money(r.methods.credit)],
    ['Fundo inicial',money(r.openingCents)],['Suprimentos',money(r.suppliesCents)],['Sangrias','− '+money(r.withdrawalsCents)],['Dinheiro esperado',money(r.expectedCents)],['Dinheiro contado',money(r.countedCents)],['Diferença',signed(r.differenceCents),r.differenceCents<0?'neg':r.differenceCents>0?'pos':''],['Conferência',st[0],st[1]]]});});
 });
 $('product-form').addEventListener('submit',e=>{e.preventDefault();run('/api/products/save',{id:$('product-id').value?Number($('product-id').value):undefined,name:$('product-name').value,price:$('product-price').value,stock:Number($('product-stock').value),
  category:$('product-category').value,channel:$('product-channel').value,favorite:$('product-favorite').checked},()=>{e.target.reset();flash('Produto salvo');});});
 $('product-form').addEventListener('reset',()=>{$('product-id').value='';formChannelTouched=false;$('product-form-title').textContent='Cadastrar produto';});
 $('product-channel').addEventListener('change',()=>{formChannelTouched=true;});
 $('product-name').addEventListener('input',()=>{const v=$('product-name').value.trim();if(!$('product-id').value&&!formChannelTouched)$('product-channel').value=PF().displayName(v)!==v?'delivery':'loja';});
 $('product-list-search').addEventListener('input',renderProducts);
 $('product-list-search').addEventListener('keydown',e=>{if(e.key==='Escape'&&e.target.value){e.preventDefault();e.target.value='';renderProducts();}});
 $('product-list').addEventListener('click',async e=>{const edit=e.target.closest('[data-edit]');const del=e.target.closest('[data-delete]');const fav=e.target.closest('[data-fav]');if(fav){const p=state.products.find(x=>x.id===Number(fav.dataset.fav));if(p){const on=!PF().isFavorite(p);run('/api/products/favorite',{id:p.id,favorite:on},()=>flash(on?`${p.name} está nos favoritos`:`${p.name} saiu dos favoritos`));}return;}
  if(edit){const p=state.products.find(x=>x.id===Number(edit.dataset.edit));if(!p)return;$('product-id').value=p.id;$('product-name').value=p.name;$('product-price').value=price(p.price_cents);$('product-stock').value=p.stock;$('product-category').value=PF().categoryOf(p);$('product-channel').value=p.channel==='delivery'?'delivery':'loja';$('product-favorite').checked=PF().isFavorite(p);formChannelTouched=true;$('product-form-title').textContent=`Editando: ${p.name}`;$('product-form').scrollIntoView({behavior:'smooth',block:'center'});$('product-name').focus({preventScroll:true});}if(del){const p=state.products.find(x=>x.id===Number(del.dataset.delete));if(await ask('Excluir produto?',`${p?p.name:'O produto'} será removido do catálogo.`,{confirmLabel:'Excluir',tone:'danger-solid'}))run('/api/products/remove',{id:Number(del.dataset.delete)});}});
 $('employee-form').addEventListener('submit',e=>{e.preventDefault();run('/api/employees/save',{id:$('employee-id').value?Number($('employee-id').value):undefined,name:$('employee-name').value},()=>{e.target.reset();flash('Funcionário salvo');});});
 $('employee-form').addEventListener('reset',()=>{$('employee-id').value='';$('employee-form-title').textContent='Cadastrar funcionário';});
 $('employee-list').addEventListener('click',async e=>{const edit=e.target.closest('[data-emp-edit]'),del=e.target.closest('[data-emp-remove]');
  if(edit){const p=state.employees.find(x=>x.id===Number(edit.dataset.empEdit));if(!p)return;$('employee-id').value=p.id;$('employee-name').value=p.name;$('employee-form-title').textContent=`Editando: ${p.name}`;$('employee-name').focus();}
  if(del){const p=state.employees.find(x=>x.id===Number(del.dataset.empRemove));if(await ask('Desativar funcionário?',`${p?p.name:'O funcionário'} sai da lista do caixa. As vendas já registradas continuam com o nome.`,{confirmLabel:'Desativar',tone:'danger-solid'}))run('/api/employees/remove',{id:Number(del.dataset.empRemove)},()=>flash('Funcionário desativado'));}});
 $('history-filters').addEventListener('submit',e=>{e.preventDefault();renderHistory();});
 $('hist-list').addEventListener('click',e=>{const row=e.target.closest('[data-sale]');if(row)openSale(Number(row.dataset.sale));});
 $('hist-list').addEventListener('keydown',e=>{const row=e.target.closest('[data-sale]');if(row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openSale(Number(row.dataset.sale));}});
 $('btn-sale-cancel').addEventListener('click',async()=>{const s=currentSale;$('sale-dialog').close();
  const reason=await ask(`Cancelar a venda #${s.id}?`,`${money(s.total_cents)} em ${PAY[s.method]}. O estoque volta e a venda sai dos totais do caixa.`,{confirmLabel:'Cancelar venda',tone:'danger-solid',input:{label:'Motivo do cancelamento',placeholder:'Ex.: cliente desistiu'}});
  if(reason&&await run('/api/sales/cancel',{id:s.id,reason},()=>flash(`Venda #${s.id} cancelada`)))renderHistory();});
 $('btn-sale-correct').addEventListener('click',async()=>{const s=currentSale;$('sale-dialog').close();
  const reason=await ask(`Corrigir a venda #${s.id}?`,'A venda é cancelada e os itens vão para uma nova venda aberta, para você ajustar e cobrar de novo. As outras vendas não mudam.',{confirmLabel:'Cancelar e corrigir',tone:'primary',input:{label:'O que precisa corrigir?',placeholder:'Ex.: peso errado'}});
  if(reason&&await run('/api/sales/correct',{id:s.id,reason},r=>flash(r.selected?`Itens em ${r.draft.label}. Ajuste e cobre novamente.`:`Itens em ${r.draft.label}. Retire o produto da balança e selecione essa venda.`)))tab('vendas');});
 document.querySelectorAll('[data-period]').forEach(b=>b.addEventListener('click',()=>{reportPeriod=b.dataset.period;renderReports();}));
 $('report-prev').addEventListener('click',()=>{reportDate=stepPeriod(reportDate,reportPeriod,-1);renderReports();});
 $('report-next').addEventListener('click',()=>{reportDate=stepPeriod(reportDate,reportPeriod,1);if(currentReport&&reportDate>currentReport.today)reportDate=currentReport.today;renderReports();});
 $('btn-demo').addEventListener('click',()=>run('/api/scale/demo',{},()=>flash('Simulador ativo')));
 document.querySelectorAll('[data-grams]').forEach(b=>b.addEventListener('click',()=>run('/api/scale/demo-weight',{grams:Number(b.dataset.grams)})));
 $('btn-ports').addEventListener('click',async()=>{try{const p=(await get('/api/scale/ports')).ports;$('serial-port').innerHTML=p.length?p.map(x=>`<option value="${safe(x.path)}">${safe(x.path)} ${safe(x.manufacturer||'')}</option>`).join(''):'<option value="">Nenhuma porta encontrada</option>';flash(`${p.length} porta(s) encontrada(s)`);}catch(e){flash(e.message,true);}});
 $('btn-connect').addEventListener('click',()=>run('/api/scale/connect',{path:$('serial-port').value,baudRate:Number($('baud').value)},()=>flash('Porta serial conectada')));
 $('btn-disconnect').addEventListener('click',()=>run('/api/scale/disconnect',{},()=>flash('Balança desconectada')));
}
boot();
