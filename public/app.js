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
const TONES=['t-yellow','t-orange','t-lime','t-pink'];
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
async function get(path){const r=await fetch(path,{cache:'no-store'});const x=await r.json();if(!r.ok)throw Object.assign(Error(x.error||'Falha de conexão'),{status:r.status});return x;}
async function post(path,obj={}){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Luminor-Token':TOKEN},body:JSON.stringify(obj)});const x=await r.json();if(!r.ok)throw Error(x.error||'Falha ao salvar');return x;}
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
 const s=state.scale,c=state.config,shift=state.cash.shift,op=state.operator;
 // Configurações shows a dot when a backup failed (red) or needs attention (yellow).
 const alert=state.system?.alert;$('config-dot').className='nav-dot'+(alert?' '+alert:' hidden');
 if(state.system?.version)$('app-version').textContent='v'+state.system.version;
 $('cash-badge').textContent=shift?'Caixa aberto':'Caixa fechado';$('cash-badge').className='pill '+(shift?'on':'warn');
 $('connection').textContent=s.mode==='demo'?'Simulador ativo':s.mode==='serial'?'Balança conectada':'Balança offline';$('connection').className='pill '+(s.mode==='offline'?'warn':'on');
 $('operator-name').textContent=op?op.name:'Selecionar';$('operator-btn').classList.toggle('warn',!op);
 paint('operator-avatar',op?safe(initials(op.name)):icon('user'));
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
 if(document.activeElement!==$('price-kg'))$('price-kg').value=price(c.priceKgCents);
 $('auto-capture').checked=c.autoCapture;
 $('btn-capture').disabled=!shift||!s.ready||!state.activeSale;$('btn-manual').disabled=!shift||!state.activeSale;
 const pend=state.pendingCaptures||[];$('capture-pending').classList.toggle('hidden',!pend.length);
 paint('capture-pending',pend.map(p=>`<div class="pending-row">${icon('alert')}<div class="grow"><strong>Pesagem de ${weight(p.grams)} kg não foi gravada${p.label?` em ${safe(p.label)}`:''}</strong><small>${safe(p.error)}</small></div><button type="button" class="accent" data-retry="${safe(p.captureId)}">Tentar de novo</button><button type="button" class="secondary" data-drop="${safe(p.captureId)}">Descartar</button></div>`).join(''));
 paint('quick-products',state.products.length?state.products.map((p,i)=>`<button class="product-button ${TONES[i%4]}" data-add="${p.id}" ${p.available<1||!shift?'disabled':''}><span class="pb-plus">${icon('plus')}</span><span class="pb-name">${safe(p.name)}</span><small>${p.available>0?plural(p.available,'disponível','disponíveis'):p.stock>0?'Reservado em vendas abertas':'Sem estoque'}</small><strong>${money(p.price_cents)}</strong></button>`).join(''):emptyState('box','Nenhum produto avulso','Cadastre itens como água e refrigerante na aba Produtos.'));
 const n=state.cart.length;$('cart-count').textContent=plural(n,'item','itens');$('cart-total').textContent=money(state.cartTotalCents);
 if(!renameId)$('sale-name-text').textContent=state.activeSale?.label||'—';$('sale-name').disabled=!state.activeSale;
 paint('cart-items',n?state.cart.map(p=>`<div class="cart-item"><span class="ci-icon ${p.manual?'is-manual':p.kind==='weight'?'is-weight':''}">${icon(p.manual?'keyboard':p.kind==='unit'?'box':'cup')}</span><div class="ci-main"><strong>${safe(p.label)}</strong><small>${itemLine(p.kind,p.grams,p.quantity,p.unitCents)}</small></div>${p.kind==='unit'?`<div class="qty"><button data-qty="${safe(p.key)}" data-to="${p.quantity-1}" ${p.quantity<2?'disabled':''} aria-label="Diminuir quantidade">${icon('minus')}</button><span>${p.quantity}</span><button data-qty="${safe(p.key)}" data-to="${p.quantity+1}" aria-label="Aumentar quantidade">${icon('plus')}</button></div>`:''}<span class="ci-total">${money(p.totalCents)}</span><div class="ci-actions"><button class="move" data-move="${safe(p.key)}" aria-label="Transferir ${safe(p.label)} para outra venda" title="Transferir para outra venda">${icon('swap')}</button><button class="remove" data-remove="${safe(p.key)}" aria-label="Remover ${safe(p.label)}" title="Remover">${icon('x')}</button></div></div>`).join(''):emptyState('cup','Nenhum item ainda','Coloque o copo na balança ou toque em um produto avulso.'));
 const cashBlocked=renderCashBox();
 $('btn-checkout').disabled=!shift||n===0||checkingOut||cashBlocked;$('checkout-label').textContent=n?`Cobrar esta venda · ${money(state.cartTotalCents)}`:'Cobrar esta venda';
 $('btn-discard').disabled=!state.activeSale||(n===0&&state.openSales.length<2);
 renderCash();renderProducts();renderEmployees();
 if($('operator-dialog').open)renderOperatorOptions();
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
function renderCash(){
 const {shift,expectedCents,events,cashSalesCents,suppliesCents,withdrawalsCents,methods,totalCents,salesCount,canceledCount}=state.cash;
 paint('cash-summary',shift?`<span class="chip on">Aberto às ${time(shift.opened_at)}${shift.opened_by_name?` por ${safe(shift.opened_by_name)}`:''}</span><div class="highlight"><small>Dinheiro esperado em caixa</small><strong>${money(expectedCents)}</strong></div><div class="rowline"><span>Fundo inicial</span><strong>${money(shift.opening_cents)}</strong></div><div class="rowline"><span>Vendas em dinheiro</span><strong>${money(cashSalesCents)}</strong></div><div class="rowline"><span>Suprimentos</span><strong>${money(suppliesCents)}</strong></div><div class="rowline"><span>Sangrias</span><strong>${money(withdrawalsCents)}</strong></div>
  <div class="section-label spaced">Vendas do turno · ${plural(salesCount,'venda','vendas')}${canceledCount?` · ${plural(canceledCount,'cancelada','canceladas')}`:''}</div><div class="method-grid">${['pix','cash','debit','credit'].map(m=>`<div><small>${PAY[m]}</small><strong>${money(methods[m])}</strong></div>`).join('')}<div class="method-total"><small>Total vendido</small><strong>${money(totalCents)}</strong></div></div>`:emptyState('lock','Caixa fechado','Escolha o operador, informe o fundo inicial em dinheiro e abra o turno.'));
 const key=shift?`open:${shift.id}`:`closed:${state.employees.map(e=>e.id+e.name).join()}:${state.operator?.id||''}`;
 if(cashControlKey!==key){cashControlKey=key;$('cash-controls').innerHTML=shift?`<div class="form"><div class="section-label">Nova movimentação</div><div class="grid2"><label>Tipo de movimentação<select id="movement-kind"><option value="withdrawal">Sangria (retirada)</option><option value="supply">Suprimento (entrada)</option></select></label><label>Valor (R$)<input id="movement-amount" placeholder="20,00" inputmode="decimal"></label></div><label>Descrição<input id="movement-note" placeholder="Ex.: retirada para cofre"></label><button class="secondary" id="btn-move">${icon('swap')}Registrar movimentação</button><div class="hline"></div><div class="section-label">Fechamento do turno</div><label>Dinheiro contado no fechamento (R$)<input id="close-counted" inputmode="decimal" placeholder="0,00"></label><button class="danger" id="btn-close">${icon('lock')}Fechar turno</button></div>`
  :state.employees.length?`<div class="form"><label>Operador do caixa<select id="opening-operator">${state.employees.map(e=>`<option value="${e.id}" ${state.operator?.id===e.id?'selected':''}>${safe(e.name)}</option>`).join('')}</select></label><label>Fundo inicial em dinheiro (R$)<input id="opening-amount" placeholder="100,00" value="0,00" inputmode="decimal"></label><button class="primary big" id="btn-open">${icon('unlock')}Abrir caixa</button></div>`
  :`<div class="notice">${icon('users')}<span><strong>Cadastre a equipe primeiro.</strong> O caixa é aberto em nome de um funcionário.</span></div><button class="primary big top-gap" data-goto="funcionarios">${icon('users')}Cadastrar funcionários</button>`;}
 const open=(state.openSales||[]).filter(d=>d.item_count>0);
 paint('cash-open-sales',shift&&open.length?`<div class="notice warn">${icon('alert')}<span><strong>${open.length===1?'1 venda em aberto':`${open.length} vendas em aberto`}.</strong> Cobre ou descarte antes de fechar o caixa.</span></div><div class="open-sales-list">${open.map(d=>`<button type="button" class="secondary" data-open-sale="${d.id}">${safe(d.label)} · ${money(d.total_cents)}${icon('arrow-right')}</button>`).join('')}</div>`:'');
 paint('cash-events',events?.length?events.map(e=>{const out=e.kind==='withdrawal';return `<div class="rowline"><span class="ev-icon ${out?'out':'in'}">${icon(out?'arrow-down':'arrow-up')}</span><div class="grow"><strong>${out?'Sangria':'Suprimento'}</strong><small>${safe(e.note)||'Sem descrição'} · ${time(e.created_at)}${e.operator_name?` · ${safe(e.operator_name)}`:''}</small></div><strong class="${out?'neg':'pos'}">${out?'−':'+'} ${money(e.amount_cents)}</strong></div>`;}).join(''):emptyState('swap','Nenhuma movimentação','Sangrias e suprimentos do turno aparecem aqui.'));
}
function renderProducts(){
 paint('product-list',state.products.length?state.products.map((p,i)=>`<div class="rowline"><span class="tone-dot ${TONES[i%4]}"></span><div class="grow"><strong>${safe(p.name)}</strong><small>${money(p.price_cents)}${p.reserved?` · ${p.reserved} em vendas abertas`:''}</small></div><span class="stock ${p.stock<1?'out':p.stock<=5?'low':''}">${p.stock<1?'Sem estoque':p.stock+' un.'}</span><div class="row-buttons"><button class="secondary" data-edit="${p.id}">Editar</button><button class="danger" data-delete="${p.id}" aria-label="Excluir ${safe(p.name)}" title="Excluir">${icon('trash')}</button></div></div>`).join(''):emptyState('box','Nenhum produto cadastrado','Use o formulário ao lado para cadastrar o primeiro item.'));
}
function renderEmployees(){
 paint('employee-list',state.employees.length?state.employees.map(e=>`<div class="rowline"><span class="avatar">${safe(initials(e.name))}</span><div class="grow"><strong>${safe(e.name)}</strong>${state.operator?.id===e.id?'<small class="pos">No caixa agora</small>':''}</div><div class="row-buttons"><button class="secondary" data-emp-edit="${e.id}">Editar</button><button class="danger" data-emp-remove="${e.id}" aria-label="Desativar ${safe(e.name)}" title="Desativar">${icon('trash')}</button></div></div>`).join(''):emptyState('users','Nenhum funcionário','Cadastre quem vai operar o caixa.'));
}
function renderOperatorOptions(){
 paint('operator-options',state.employees.length?state.employees.map(e=>`<button class="op-option ${state.operator?.id===e.id?'current':''}" data-operator="${e.id}"><span class="avatar">${safe(initials(e.name))}</span><span>${safe(e.name)}</span></button>`).join(''):`${emptyState('users','Nenhum funcionário cadastrado','Cadastre a equipe para identificar quem opera o caixa.')}<button class="primary" data-goto="funcionarios">${icon('users')}Cadastrar funcionários</button>`);
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
function openManual(){if(!state.cash.shift||!state.activeSale)return flash('Abra o caixa para vender',true);$('manual-target').textContent=state.activeSale.label;$('manual-input').value='';setManualMode(manualMode);$('manual-dialog').showModal();$('manual-input').focus();}
async function renderHistory(){
 try{const p=new URLSearchParams();const q=$('hist-q').value.trim();
 if(q)p.set('q',q);else{p.set('from',$('hist-from').value);p.set('to',$('hist-to').value);if($('hist-status').value)p.set('status',$('hist-status').value);}
 const r=await get('/api/sales?'+p);const done=r.sales.filter(x=>x.status==='done'),canceled=r.sales.length-done.length;
 $('hist-summary').innerHTML=`<span>${plural(r.sales.length,'venda','vendas')}</span><span>Concluídas: <strong>${money(done.reduce((s,x)=>s+x.total_cents,0))}</strong></span>${canceled?`<span class="neg">${plural(canceled,'cancelada','canceladas')}</span>`:''}${r.sales.length>=500?'<span>Mostrando as 500 mais recentes</span>':''}`;
 $('hist-list').innerHTML=r.sales.length?`<div class="table-wrap"><table class="table clickable"><thead><tr><th>Venda</th><th>Data e hora</th><th>Operador</th><th>Itens</th><th>Pagamento</th><th>Total</th><th>Situação</th></tr></thead><tbody>${r.sales.map(x=>`<tr data-sale="${x.id}" tabindex="0"><td><strong>#${x.id}</strong></td><td>${date(x.created_at)}</td><td>${safe(x.operator_name||'—')}</td><td>${x.item_count}${x.has_manual?' <span class="tag warn">digitado</span>':''}</td><td><span class="tag">${safe(PAY[x.method])}</span></td><td><strong class="${x.status==='canceled'?'strike':''}">${money(x.total_cents)}</strong></td><td>${x.status==='canceled'?'<span class="tag off">Cancelada</span>':'<span class="tag on">Concluída</span>'}</td></tr>`).join('')}</tbody></table></div>`:emptyState('receipt','Nenhuma venda encontrada','Ajuste as datas, a situação ou o número da venda.');
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
 $('sale-actions').classList.toggle('hidden',!s.cancelable);$('sale-dialog').showModal();
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
 $('report-stats').innerHTML=[['Total vendido',money(r.totalCents),'chart','t-berry feature'],['Vendas',r.count,'receipt','t-lilac'],['Ticket médio',money(r.avgTicketCents),'tag','t-pink'],['Açaí pesado',`${weight(r.grams)} kg`,'scale','t-lime'],['Pix',money(r.methods.pix),'pix','t-green'],['Dinheiro',money(r.methods.cash),'cash','t-yellow'],['Débito',money(r.methods.debit),'card','t-orange'],['Crédito',money(r.methods.credit),'card','t-lilac'],['Cancelamentos',r.canceled.count,'x','t-red',money(r.canceled.totalCents)],['Lançamentos digitados',r.manual.count,'keyboard','t-yellow',money(r.manual.totalCents)]]
  .map(([label,value,ic,cls,sub])=>`<div class="stat ${cls}"><span class="stat-icon">${icon(ic)}</span><small>${label}</small><strong>${value}</strong>${sub!==undefined?`<small class="sub">${sub}</small>`:''}</div>`).join('');
 renderChart(r);
 const best=Math.max(...r.byOperator.map(o=>o.totalCents),0);
 $('report-operators').innerHTML=r.byOperator.length?r.byOperator.map(o=>`<div class="rowline"><span class="avatar">${safe(initials(o.name))}</span><div class="grow"><strong>${safe(o.name)}</strong><small>${plural(o.count,'venda','vendas')}</small><span class="share"><span data-w="${best?Math.round(o.totalCents/best*100):0}"></span></span></div><strong>${money(o.totalCents)}</strong></div>`).join(''):emptyState('users','Sem vendas no período','');
 $('report-shifts').innerHTML=r.shifts.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Abertura</th><th>Operador</th><th>Fechamento</th><th>Esperado</th><th>Contado</th><th>Diferença</th></tr></thead><tbody>${r.shifts.map(x=>`<tr><td>${date(x.opened_at)}</td><td>${safe(x.opened_by_name||'—')}</td><td>${x.closed_at?(new Date(x.closed_at).toDateString()===new Date(x.opened_at).toDateString()?time:date)(x.closed_at)+(x.closed_by_name&&x.closed_by_name!==x.opened_by_name?' · '+safe(x.closed_by_name):''):'<span class="tag on">Aberto</span>'}</td><td>${x.closed_at?money(x.expected_cents):'—'}</td><td>${x.closed_at?money(x.counted_cents):'—'}</td><td><strong class="${x.difference_cents<0?'neg':x.difference_cents>0?'pos':''}">${x.closed_at?signed(x.difference_cents):'—'}</strong></td></tr>`).join('')}</tbody></table></div>`:emptyState('wallet','Nenhum caixa no período','');
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
async function loadState(){try{state=await get('/api/state');systemBanner(null);render();}catch(e){systemBanner(e);}}
function refresh(){
 if(!refreshing){refreshing=loadState().finally(()=>{refreshing=null;});return refreshing;}
 if(!refreshAgain)refreshAgain=refreshing.then(()=>{refreshAgain=null;return refresh();});
 return refreshAgain;
}
// The next automatic refresh is scheduled only after the previous one answered.
async function poll(){await refresh();setTimeout(poll,document.hidden?3000:850);}
function tab(name){activeTab=name;document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.querySelectorAll('main section.panel').forEach(el=>el.classList.toggle('hidden',el.id!==name));window.scrollTo({top:0});if(name==='relatorios')renderReports();if(name==='historico')renderHistory();if(name==='configuracoes')window.LuminorAdmin?.open();}
async function boot(){try{TOKEN=(await get('/api/session')).token;}catch(e){flash(e.message,true);}await poll();
 $('hist-from').value=$('hist-to').value=localToday();
 document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.tab)));
 document.addEventListener('click',e=>{const b=e.target.closest('[data-goto]');if(!b)return;b.closest('dialog')?.close();tab(b.dataset.goto);(b.dataset.goto==='caixa'?$('opening-amount'):b.dataset.goto==='funcionarios'?$('employee-name'):null)?.focus();});
 $('operator-btn').addEventListener('click',()=>{renderOperatorOptions();$('operator-dialog').showModal();});
 $('operator-options').addEventListener('click',e=>{const b=e.target.closest('[data-operator]');if(b)run('/api/operator',{id:Number(b.dataset.operator)},r=>{$('operator-dialog').close();flash(`Operador: ${r.name}`);});});
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
 $('quick-products').addEventListener('click',e=>{const b=e.target.closest('[data-add]');if(b)run('/api/cart/unit',{saleId:state.activeSaleId,id:Number(b.dataset.add),quantity:1});});
 $('cart-items').addEventListener('click',e=>{const saleId=state.activeSaleId;const m=e.target.closest('[data-move]');if(m)return openTransfer(m.dataset.move);
  const r=e.target.closest('[data-remove]');if(r)return run('/api/cart/remove',{saleId,key:r.dataset.remove});const q=e.target.closest('[data-qty]');if(q)run('/api/cart/quantity',{saleId,key:q.dataset.qty,quantity:Number(q.dataset.to)});});
 $('cash-controls').addEventListener('click',async e=>{
  const id=e.target.closest('button')?.id;
  if(id==='btn-open')run('/api/shift/open',{opening:$('opening-amount').value,operatorId:Number($('opening-operator').value)},()=>flash('Caixa aberto'));
  if(id==='btn-move')run('/api/shift/move',{kind:$('movement-kind').value,amount:$('movement-amount').value,note:$('movement-note').value},()=>flash('Movimentação registrada'));
  const open=(state.openSales||[]).filter(d=>d.item_count>0);
  if(id==='btn-close'&&open.length)return ask(open.length===1?'Existe 1 venda em aberto':`Existem ${open.length} vendas em aberto`,open.length===1?'Cobre ou descarte essa venda para fechar o caixa. Toque nela na lista acima para abri-la.':'Cobre ou descarte essas vendas para fechar o caixa. Toque em cada uma na lista acima para abri-la.',{alert:true,confirmLabel:'Entendi',details:open.map(d=>[d.label,money(d.total_cents)])});
  if(id==='btn-close'&&await ask('Fechar o caixa agora?','Confira o dinheiro contado antes de continuar. O turno será encerrado.',{confirmLabel:'Fechar turno',tone:'danger-solid'}))
   run('/api/shift/close',{counted:$('close-counted').value},r=>ask('Caixa fechado','Resumo do turno para conferência.',{alert:true,confirmLabel:'Concluir',tone:'success',details:[
    ['Total vendido',money(r.totalCents)],['Vendas',String(r.salesCount)+(r.canceledCount?` (${plural(r.canceledCount,'cancelada','canceladas')})`:'')],['Pix',money(r.methods.pix)],['Dinheiro',money(r.methods.cash)],['Débito',money(r.methods.debit)],['Crédito',money(r.methods.credit)],
    ['Fundo inicial',money(r.openingCents)],['Suprimentos',money(r.suppliesCents)],['Sangrias','− '+money(r.withdrawalsCents)],['Dinheiro esperado',money(r.expectedCents)],['Dinheiro contado',money(r.countedCents)],['Diferença',signed(r.differenceCents),r.differenceCents<0?'neg':r.differenceCents>0?'pos':'']]}));
 });
 $('product-form').addEventListener('submit',e=>{e.preventDefault();run('/api/products/save',{id:$('product-id').value?Number($('product-id').value):undefined,name:$('product-name').value,price:$('product-price').value,stock:Number($('product-stock').value)},()=>{e.target.reset();$('product-id').value='';flash('Produto salvo');});});
 $('product-form').addEventListener('reset',()=>{$('product-id').value='';$('product-form-title').textContent='Cadastrar produto';});
 $('product-list').addEventListener('click',async e=>{const edit=e.target.closest('[data-edit]');const del=e.target.closest('[data-delete]');if(edit){const p=state.products.find(x=>x.id===Number(edit.dataset.edit));if(!p)return;$('product-id').value=p.id;$('product-name').value=p.name;$('product-price').value=price(p.price_cents);$('product-stock').value=p.stock;$('product-form-title').textContent=`Editando: ${p.name}`;$('product-form').scrollIntoView({behavior:'smooth',block:'center'});$('product-name').focus({preventScroll:true});}if(del){const p=state.products.find(x=>x.id===Number(del.dataset.delete));if(await ask('Excluir produto?',`${p?p.name:'O produto'} será removido do catálogo.`,{confirmLabel:'Excluir',tone:'danger-solid'}))run('/api/products/remove',{id:Number(del.dataset.delete)});}});
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
