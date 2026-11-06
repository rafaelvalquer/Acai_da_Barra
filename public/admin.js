'use strict';
// Configurações > Administração do sistema. Everything here is decided on the server (/api/admin/*): this page only
// shows forms and results. The session lives in an HttpOnly cookie the page cannot read; the database password and
// the keys never come back to the browser. Uses the helpers of app.js ($, safe, icon, flash, money, plural).
(()=>{
const A={view:'home',status:null,ov:null,db:null,backup:null,access:null,diag:null,cloud:{test:null,prepared:false},lastBackup:null,restore:null,key:null,code:null,message:null,current:null,demo:false};
const root=()=>$('admin-root');
const when=s=>s?new Date(s).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'—';
const bytes=n=>n==null?'—':n<1024?`${n} B`:n<1048576?`${Math.round(n/1024)} KB`:n<1073741824?`${(n/1048576).toFixed(1).replace('.',',')} MB`:`${(n/1073741824).toFixed(1).replace('.',',')} GB`;
const duration=s=>s<3600?`${Math.max(1,Math.round(s/60))} min`:s<86400?`${Math.floor(s/3600)} h ${Math.round(s%3600/60)} min`:`${Math.floor(s/86400)} d ${Math.floor(s%86400/3600)} h`;
const KIND={manual:'Manual',automatico:'Automático',fechamento:'Fechamento do caixa',seguranca:'Segurança (antes de restaurar ou migrar)',atualizacao:'Antes de atualizar'};
const TABLES={settings:'Configurações',employees:'Funcionários',products:'Produtos',shifts:'Turnos de caixa',cash_events:'Movimentações de caixa',sales:'Vendas',sale_items:'Itens das vendas',
 draft_sales:'Vendas abertas',draft_sale_items:'Itens das vendas abertas',draft_sale_events:'Histórico das vendas abertas'};
const ACTIONS={login:'Entrada no painel',login_falhou:'Senha incorreta',login_bloqueado:'Acesso bloqueado',logout:'Saída',senha_alterada:'Senha alterada',usuario_alterado:'Usuário alterado',
 recuperacao_usada:'Código de recuperação usado',recuperacao_falhou:'Código de recuperação incorreto',codigo_recuperacao_gerado:'Novo código de recuperação',confirmacao_falhou:'Confirmação com senha incorreta'};
const SCALE={stable:'Estável',waiting:'Sem leitura',offline:'Desconectada',unstable:'Instável',negative:'Peso negativo',overload:'Sobrecarga',invalid:'Leitura inválida'};
const logLine=l=>typeof l==='string'?l:`${when(l.at)}  ${String(l.level||'').toUpperCase().padEnd(5)} ${l.message}`;
const rows=list=>`<div class="adm-rows">${list.filter(Boolean).map(([l,v,c])=>`<div class="rowline"><span>${safe(l)}</span><strong class="${c||''}">${safe(v)}</strong></div>`).join('')}</div>`;
const notice=(text,tone='',ic='info')=>`<div class="notice ${tone}">${icon(ic)}<span>${text}</span></div>`;
const alertList=list=>list?.length?`<div class="adm-alerts">${list.map(a=>`<div class="adm-alert ${a.level}">${icon(a.level==='erro'?'alert':'info')}<span>${safe(a.text)}</span></div>`).join('')}</div>`:'';

// --- Server -------------------------------------------------------------------------------------------------------
let token=null;
async function pageToken(force=false){if(!token||force)token=(await (await fetch('/api/session',{cache:'no-store'})).json()).token;return token;}
async function request(method,path,{body,binary,raw}={},retry=true){
 const headers={};if(method==='POST'){headers['X-Luminor-Token']=await pageToken();headers['Content-Type']=binary?'application/octet-stream':'application/json';}
 let r;try{r=await fetch('/api/admin/'+path,{method,headers,cache:'no-store',body:method==='POST'?(binary||JSON.stringify(body||{})):undefined});}
 catch(_){throw Object.assign(Error('Sem comunicação com o Luminor PDV. Verifique se o programa está aberto.'),{status:0});}
 if(r.ok&&raw)return r;
 const x=await r.json().catch(()=>({}));
 // The page token changes when the PDV restarts: fetched again once.
 if(r.status===403&&retry&&/Sessão de segurança/.test(x.error||'')){await pageToken(true);return request(method,path,{body,binary,raw},false);}
 if(!r.ok)throw Object.assign(Error(x.error||'Falha de comunicação'),{status:r.status,data:x,demo:r.status===404&&!!x.demo});
 return method==='GET'?x:x.result;
}
const apiGet=p=>request('GET',p);const apiPost=(p,body)=>request('POST',p,{body});
const status=()=>apiGet('session');
// The session ended (15 minutes idle, signed out elsewhere, too many wrong confirmations): back to the sign-in.
async function sessionLost(e){
 if(e.status===403&&/nova senha/.test(e.message)){go('password');return true;}
 if(e.status!==401)return false;
 const s=await status().catch(()=>null);if(s?.authenticated)return false;
 A.message='Sua sessão terminou. Entre de novo para continuar.';go('login');return true;
}
// Runs an action from a button: the button waits, errors become a message.
async function guard(button,fn){
 if(button){if(button.disabled)return null;button.disabled=true;button.classList.add('busy');}
 try{return await fn();}
 catch(e){if(!(await sessionLost(e)))flash(e.message,true);return null;}
 finally{if(button?.isConnected){button.disabled=false;button.classList.remove('busy');}}
}
// Asks the administrator password and runs the action with it inside the window, so a wrong password can be typed
// again. Resolves {result} or null when canceled.
function withPassword({title,message,details=null,confirmLabel='Confirmar',tone='primary',iconName='lock'},action){
 const d=$('admin-dialog');if(d.open)return Promise.resolve(null);
 $('admin-dialog-title').textContent=title;$('admin-dialog-message').textContent=message||'';$('admin-dialog-message').classList.toggle('hidden',!message);
 $('admin-dialog-details').innerHTML=details?details.map(([l,v,c])=>`<div class="rowline"><span>${safe(l)}</span><strong class="${c||''}">${safe(v)}</strong></div>`).join(''):'';
 $('admin-dialog-icon').innerHTML=icon(tone==='danger-solid'?'alert':iconName);d.classList.toggle('is-danger',tone==='danger-solid');
 const ok=$('admin-dialog-ok'),pw=$('admin-dialog-password'),err=$('admin-dialog-error'),form=$('admin-dialog-form'),cancelBtn=$('admin-dialog-cancel');
 ok.textContent=confirmLabel;ok.className=tone;pw.value='';err.classList.add('hidden');
 let busy=false;
 return new Promise(resolve=>{
  const finish=v=>{form.removeEventListener('submit',submit);cancelBtn.removeEventListener('click',cancel);d.removeEventListener('close',cancel);d.removeEventListener('cancel',hold);if(d.open)d.close();pw.value='';resolve(v);};
  const cancel=()=>{if(!busy)finish(null);};
  const hold=e=>{if(busy)e.preventDefault();};
  const submit=async e=>{e.preventDefault();if(busy)return;
   if(!pw.value){err.textContent='Digite a senha do administrador.';err.classList.remove('hidden');return pw.focus();}
   busy=true;ok.disabled=cancelBtn.disabled=true;ok.classList.add('busy');err.classList.add('hidden');
   try{const result=await action(pw.value);busy=false;finish({result});}
   catch(x){busy=false;
    if(await sessionLost(x))return finish(null);
    err.textContent=x.message;err.classList.remove('hidden');pw.select();}
   finally{ok.disabled=cancelBtn.disabled=false;ok.classList.remove('busy');}
  };
  form.addEventListener('submit',submit);cancelBtn.addEventListener('click',cancel);d.addEventListener('close',cancel);d.addEventListener('cancel',hold);
  d.showModal();pw.focus();
 });
}
// Downloads a file the server sends (backup, diagnostic). With the save window the person picks the folder or pen drive.
async function download(path,body,{description,extension,mime}){
 const r=await request('POST',path,{body,raw:true});
 const name=(/filename="([^"]+)"/.exec(r.headers.get('content-disposition')||'')||[])[1]||'arquivo'+extension;const blob=await r.blob();
 if(window.showSaveFilePicker){
  try{const h=await window.showSaveFilePicker({suggestedName:name,types:[{description,accept:{[mime]:[extension]}}]});const w=await h.createWritable();await w.write(blob);await w.close();return name;}
  catch(e){if(e.name==='AbortError')return null;}
 }
 const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
 return name;
}

// --- Navigation ---------------------------------------------------------------------------------------------------
const LOADERS={
 home:async()=>{A.status=await status();},login:async()=>{A.status=await status();},recover:async()=>{A.status=await status();},password:async()=>{A.status=await status();},
 panel:async()=>{[A.ov,A.status]=await Promise.all([apiGet('overview'),status()]);},
 banco:async()=>{A.db=await apiGet('database');},
 backup:async()=>{A.backup=await apiGet('backup');},
 seguranca:async()=>{[A.status,A.access]=await Promise.all([status(),apiGet('access-log')]);},
 manutencao:async()=>{A.diag=await apiGet('diagnostics');},preferencias:async()=>{[A.diag,A.backup]=await Promise.all([apiGet('diagnostics'),apiGet('backup')]);},
 sobre:async()=>{A.diag=await apiGet('diagnostics');}
};
let loading=0;
async function go(view){
 const ticket=++loading;
 try{await LOADERS[view]();}
 catch(e){
  if(ticket!==loading)return;
  if(e.demo){A.demo=true;A.view='demo';return draw();}
  if(e.status===401){A.view='login';A.status=await status().catch(()=>null);return draw();}
  if(e.status===403){A.view='password';A.status=await status().catch(()=>null);return draw();}
  A.view='erro';A.message=e.message;return draw();
 }
 if(ticket!==loading)return;
 if(view==='panel'&&A.status&&!A.status.authenticated)view='login';
 A.view=view;draw();
}
// Where the card "Administração do sistema" leads: the panel, the new password or the sign-in.
async function enter(){
 try{A.status=await status();}catch(e){if(e.demo){A.demo=true;A.view='demo';return draw();}return flash(e.message,true);}
 const u=A.status.user;go(!A.status.authenticated?'login':u.scope==='completo'?'panel':'password');
}
function draw(){
 const el=root();if(!el)return;const v=VIEWS[A.view]||VIEWS.home;el.innerHTML=v();el.dataset.view=A.view;
 const changed=el.dataset.shown!==A.view;el.dataset.shown=A.view;
 if(changed)window.scrollTo({top:0});
 const first=el.querySelector('[autofocus]');if(first)first.focus({preventScroll:true});
}
const head=(title,sub)=>`<div class="adm-head"><button type="button" class="secondary adm-back" data-act="go" data-to="panel">${icon('chevron-left')}Painel</button><div class="adm-head-text"><h2>${title}</h2>${sub?`<p>${sub}</p>`:''}</div><button type="button" class="link-btn adm-logout" data-act="logout">${icon('logout')}Sair</button></div>`;

// --- Views --------------------------------------------------------------------------------------------------------
const VIEWS={};
VIEWS.home=()=>{
 const s=A.status;const signed=s?.authenticated&&s.user.scope==='completo';
 return `<button type="button" class="adm-entry" data-act="enter">
  <span class="adm-entry-icon">${icon(signed?'unlock':'lock')}</span>
  <span class="adm-entry-text"><strong>Administração do sistema</strong><span>Banco de dados, backups, segurança e configurações avançadas.</span><small>${signed?`Conectado como ${safe(s.user.username)}`:'Acesso protegido por senha'}</small></span>
  <span class="adm-entry-go">${icon('arrow-right')}</span></button>
  <div class="adm-shortcuts"><button type="button" class="secondary" data-goto="funcionarios">${icon('users')}Funcionários</button><button type="button" class="secondary" data-goto="balanca">${icon('scale')}Balança Toledo</button></div>`;
};
VIEWS.demo=()=>`<div class="card adm-narrow">${notice('<strong>Esta é a demonstração online.</strong> A administração do sistema (banco de dados, backups, senhas e manutenção) existe só no PDV instalado no computador da loja.','','info')}<div class="form-actions top-gap"><button type="button" class="secondary" data-act="home">${icon('chevron-left')}Voltar</button></div></div>`;
VIEWS.erro=()=>`<div class="card adm-narrow">${notice(safe(A.message||'Falha ao carregar.'),'danger','alert')}<div class="form-actions top-gap"><button type="button" class="primary" data-act="enter">${icon('refresh')}Tentar de novo</button><button type="button" class="secondary" data-act="home">Voltar</button></div></div>`;
VIEWS.login=()=>{
 const st=A.status?.state;const msg=A.message;A.message=null;
 return `<div class="card adm-narrow adm-auth">
  <span class="adm-auth-icon">${icon('lock')}</span><h2>Acesso administrativo</h2><p class="minor">Somente para o responsável pelo sistema.</p>
  ${st==='inicial'?notice('<strong>Primeiro acesso:</strong> usuário <b>admin</b> e senha <b>admin</b>. Em seguida você cria a senha definitiva; a senha admin deixa de funcionar.','warn','key'):''}
  ${st==='recuperacao'?notice('<strong>A senha deste computador precisa ser redefinida.</strong> Use o código de recuperação de emergência anotado pelo administrador.','warn','alert'):''}
  ${msg?notice(safe(msg),'warn','info'):''}
  <form class="form" data-form="login" autocomplete="on">
   <label>Usuário<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus/></label>
   <label>Senha<input name="password" type="password" autocomplete="current-password" maxlength="128" required/></label>
   <p class="adm-error hidden" data-error role="alert"></p>
   <button type="submit" class="primary big">${icon('unlock')}Entrar</button>
  </form>
  <div class="adm-auth-links"><button type="button" class="link-btn" data-act="home">${icon('chevron-left')}Voltar</button><button type="button" class="link-btn" data-act="go" data-to="recover">Esqueci a senha</button></div>
 </div>`;
};
VIEWS.recover=()=>`<div class="card adm-narrow adm-auth">
  <span class="adm-auth-icon">${icon('key')}</span><h2>Recuperar o acesso</h2><p class="minor">Digite o código de recuperação de emergência (16 letras e números). Ele vale uma vez só.</p>
  <form class="form" data-form="recover">
   <label>Usuário<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required autofocus/></label>
   <label>Código de recuperação<input name="code" class="mono" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24" placeholder="XXXX-XXXX-XXXX-XXXX" required/></label>
   <p class="adm-error hidden" data-error role="alert"></p>
   <button type="submit" class="primary big">${icon('key')}Continuar</button>
  </form>
  ${notice('Sem o código: no computador da loja, um administrador do Windows pode gerar uma senha temporária com <code>npm run admin:redefinir -- --confirmar</code> na pasta do programa.','', 'info')}
  <div class="adm-auth-links"><button type="button" class="link-btn" data-act="go" data-to="login">${icon('chevron-left')}Voltar ao acesso</button></div>
 </div>`;
VIEWS.password=()=>{
 const u=A.status?.user;if(!u)return VIEWS.login();
 const first=A.status.state==='inicial'||A.current==='admin';const needsCurrent=u.scope!=='recuperacao'&&A.current===null;
 return `<div class="card adm-narrow adm-auth">
  <span class="adm-auth-icon">${icon('shield')}</span><h2>${first?'Crie a senha definitiva':'Crie uma nova senha'}</h2>
  <p class="minor">${first?'A senha inicial admin só serve para este primeiro acesso.':'Por segurança, defina uma senha nova antes de continuar.'} Usuário: <strong>${safe(u.username)}</strong>.</p>
  <form class="form" data-form="password">
   ${needsCurrent?`<label>Senha atual<input name="current" type="password" autocomplete="current-password" maxlength="128" required autofocus/></label>`:''}
   <label>Nova senha<input name="next" type="password" autocomplete="new-password" minlength="12" maxlength="128" required data-strength ${needsCurrent?'':'autofocus'}/></label>
   <label>Repita a nova senha<input name="repeat" type="password" autocomplete="new-password" maxlength="128" required data-strength/></label>
   <ul class="adm-rules" data-rules>
    <li data-rule="len">${icon('check')}Pelo menos 12 caracteres</li><li data-rule="user">${icon('check')}Sem o nome de usuário</li><li data-rule="same">${icon('check')}As duas senhas iguais</li>
   </ul>
   <p class="adm-error hidden" data-error role="alert"></p>
   <button type="submit" class="primary big">${icon('check')}Salvar senha</button>
  </form>
  ${notice('Dica: uma frase longa é mais fácil de lembrar e mais difícil de adivinhar, por exemplo <i>açaí com granola na barra 2026</i>. Anote em local seguro, fora do computador.','', 'info')}
  <div class="adm-auth-links"><button type="button" class="link-btn" data-act="logout">${icon('logout')}Sair</button></div>
 </div>`;
};
VIEWS.panel=()=>{
 const o=A.ov,s=A.status;const db=o.database;const local=db.provider==='sqlite';const last=o.backup.lastSuccess;
 const alerts=[...(o.backup.alerts||[])];
 if(s?.user&&!s.user.hasRecoveryCode)alerts.push({level:'aviso',text:'Gere o código de recuperação de emergência em Segurança e guarde fora do computador. Ele recupera o acesso se a senha for esquecida.'});
 if(!local&&!db.postgres?.connected)alerts.unshift({level:'erro',text:'O banco na nuvem está indisponível: as vendas estão pausadas. Abra Banco de dados para voltar ao banco local.'});
 if(o.maintenance)alerts.unshift({level:'aviso',text:o.maintenance});
 const cards=[
  ['banco','database','Banco de dados','SQLite e Supabase',local?'Local (SQLite) · funciona sem internet':db.postgres?.connected?`Nuvem · ${db.postgres.host}`:'Nuvem · indisponível',!local&&!db.postgres?.connected?'neg':''],
  ['backup','download','Backup e restauração','Exportar e recuperar',last?`Último: ${when(last.at)}`:'Nenhum backup ainda',o.backup.lastFailure?'neg':last?'':'warn'],
  ['seguranca','shield','Segurança','Alterar usuário e senha',`Usuário: ${o.user.username}`,''],
  ['manutencao','tool','Manutenção','Diagnósticos e logs',`Balança: ${o.scale.mode==='offline'?'desconectada':o.scale.mode==='demo'?'simulador':SCALE[o.scale.status]||o.scale.status}`,''],
  ['preferencias','sliders','Configurações','Preferências técnicas','Backup diário, pastas e endereço',''],
  ['sobre','info','Sobre o sistema','Versão e atualizações',`Versão ${o.version}`,'']];
 return `<div class="adm-head"><div class="adm-head-text"><h2>Painel administrativo</h2><p>Conectado como <strong>${safe(o.user.username)}</strong>. A sessão termina após 15 minutos sem uso.</p></div><button type="button" class="secondary adm-logout" data-act="logout">${icon('logout')}Sair</button></div>
  ${alertList(alerts)}
  <div class="adm-grid">${cards.map(([to,ic,title,sub,line,cls])=>`<button type="button" class="adm-card" data-act="go" data-to="${to}"><span class="adm-card-icon">${icon(ic)}</span><strong>${title}</strong><span class="adm-card-sub">${sub}</span><small class="${cls}">${safe(line)}</small></button>`).join('')}</div>`;
};
function cloudSteps(d){
 const p=d.pending,m=d.migration;const same=m&&p&&m.target&&['host','port','database','user'].every(k=>m.target[k]===p[k]);
 const tested=!!p,prepared=A.cloud.prepared||!!A.cloud.test?.prepared||!!same,migrated=!!(same&&m.ok);
 return {tested,prepared,migrated,same,list:[['Testar conexão',tested],['Preparar o banco',prepared],['Migrar e conferir',migrated],['Ativar',false]]};
}
VIEWS.banco=()=>{
 const d=A.db,local=d.provider==='sqlite',pg=d.postgres,ig=d.integrity;
 const current=`<div class="card"><div class="card-title"><span>Banco em uso</span><span class="adm-badge ${local?'on':pg?.connected?'cloud':'off'}">${icon(local?'database':'cloud')}${local?'Local (SQLite)':'Nuvem (PostgreSQL)'}</span></div>
  ${local?rows([['Arquivo',d.sqlite.path,'mono'],['Tamanho',bytes(d.sqlite.bytes)],['Funciona sem internet','Sim','pos']])
   :rows([['Servidor',`${pg.host}:${pg.port}`],['Banco',pg.database],['Usuário',pg.user],['Conexão',pg.connected?`Conectado desde ${when(pg.connectedAt)}`:`Indisponível${pg.lastError?` · ${pg.lastError.message}`:''}`,pg.connected?'pos':'neg']])}
  ${rows([['Integridade',ig?`${ig.ok?'OK':'Problema'} · ${ig.message} · ${when(ig.at)}`:'Ainda não verificada',ig?(ig.ok?'pos':'neg'):''],['Último backup',when(d.lastBackupAt)],['Versão da estrutura',String(d.schemaVersion??'—')]])}
  <div class="form-actions top-gap"><button type="button" class="secondary" data-act="integrity">${icon('shield')}Verificar integridade</button></div></div>`;
 if(!local){
  return `${head('Banco de dados','Onde as vendas, caixas, produtos e funcionários ficam gravados.')}
   <div class="columns">${current}
   <div class="card"><div class="card-title">Voltar para o banco local</div>
    <p class="minor">O PDV volta a gravar neste computador e a funcionar sem internet.</p>
    <div class="adm-options" role="radiogroup" aria-label="Como voltar">
     <label class="adm-option"><input type="radio" name="local-mode" value="copiar" ${pg.connected?'checked':'disabled'}/><span><strong>Copiar os dados da nuvem para este computador</strong><small>Recomendado. Tudo o que foi vendido na nuvem vem junto, conferido tabela por tabela.${pg.connected?'':' Indisponível: a nuvem está fora do ar.'}</small></span></label>
     <label class="adm-option"><input type="radio" name="local-mode" value="manter" ${pg.connected?'':'checked'}/><span><strong>Usar o banco local como estava na migração</strong><small>Para quando a nuvem está fora do ar. Vendas feitas na nuvem depois da migração não estarão nele.</small></span></label>
    </div>
    <button type="button" class="primary top-gap" data-act="db-local">${icon('database')}Voltar para o banco local</button>
   </div></div>`;
 }
 const steps=cloudSteps(d),t=A.cloud.test,m=d.migration;
 const stepper=`<ol class="adm-steps">${steps.list.map(([label,done],i)=>`<li class="${done?'done':steps.list.findIndex(x=>!x[1])===i?'current':''}"><span>${done?icon('check'):i+1}</span>${label}</li>`).join('')}</ol>`;
 const testBox=t?`<div class="adm-result ok">${icon('check')}<div><strong>Conexão funcionando</strong>${rows([['Servidor',t.server],['Tempo de resposta',`${t.latencyMs} ms`],['Conexão criptografada',t.tls===null?'—':t.tls?'Sim (TLS)':'Não',t.tls===false?'neg':''],['Conteúdo do banco',t.schema],['Vazio',t.empty?'Sim':'Não']])}</div></div>`:'';
 const migBox=m&&steps.same?`<div class="adm-result ${m.ok?'ok':'bad'}">${icon(m.ok?'check':'alert')}<div><strong>${m.ok?'Migração conferida':'A conferência encontrou diferenças'} · ${when(m.at)}</strong>
   <div class="table-wrap"><table class="table"><thead><tr><th>Tabela</th><th>Local</th><th>Nuvem</th><th></th></tr></thead><tbody>${m.tables.map(x=>`<tr><td>${safe(TABLES[x.table]||x.table)}</td><td>${x.source}</td><td>${x.target}</td><td>${x.ok?`<span class="tag on">OK</span>`:`<span class="tag off">Diferente</span>`}</td></tr>`).join('')}</tbody></table></div>
   ${m.totals?.length?`<p class="neg">${m.totals.map(x=>safe(`${x.item}: local ${x.source}, nuvem ${x.target}`)).join('<br/>')}</p>`:''}</div></div>`:'';
 return `${head('Banco de dados','Onde as vendas, caixas, produtos e funcionários ficam gravados.')}
  ${d.busy?notice('Uma operação de banco de dados está em andamento. Aguarde.','warn','alert'):''}
  <div class="columns">${current}
  <div class="card"><div class="card-title"><span>Banco na nuvem (Supabase)</span>${icon('cloud')}</div>
   <p class="minor">Opcional. Com a nuvem ativa, as vendas são gravadas no Supabase e é preciso internet para vender. Nada muda aqui até o último passo.</p>
   ${stepper}
   <form class="form" data-form="db-test" autocomplete="off">
    <label>Endereço de conexão (PostgreSQL)<input name="url" spellcheck="false" autocomplete="off" placeholder="postgresql://postgres.xxxx@aws-0-sa-east-1.pooler.supabase.com:5432/postgres"/></label>
    <label>Senha do banco de dados<input name="password" type="password" autocomplete="new-password" maxlength="200"/></label>
    <details class="adm-details"><summary>Certificado do servidor (opcional)</summary><label>Certificado CA em formato PEM<textarea name="ca" rows="4" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label><small class="minor">No Supabase: Database Settings › SSL Configuration › Download certificate. Abra o arquivo no Bloco de Notas e cole aqui.</small></details>
    ${notice('No Supabase, use <strong>Connect › Session pooler</strong>: funciona em internet só IPv4, como a da maioria das lojas. O endereço e a senha ficam guardados protegidos neste computador e não aparecem de novo na tela.','', 'shield')}
    <div class="form-actions"><button type="submit" class="secondary">${icon('plug')}Testar conexão</button></div>
   </form>
   ${d.pending?`<p class="minor adm-pending">Último teste com sucesso: <strong>${safe(d.pending.host)}</strong> · banco ${safe(d.pending.database)} · usuário ${safe(d.pending.user)}</p>`:''}
   ${testBox}
   <div class="adm-step-actions">
    <button type="button" class="secondary" data-act="db-prepare" ${steps.tested?'':'disabled'}>${icon('database')}Preparar banco na nuvem</button>
    <button type="button" class="secondary" data-act="db-migrate" ${steps.tested?'':'disabled'}>${icon('upload')}Migrar dados locais</button>
    <button type="button" class="primary" data-act="db-activate" ${steps.migrated?'':'disabled'}>${icon('cloud')}Ativar banco na nuvem</button>
   </div>
   ${migBox}
  </div></div>`;
};
function restoreBlock(){
 const r=A.restore;
 if(!r)return `<p class="minor">O arquivo é conferido (formato, integridade, chave, versão e estrutura) antes de qualquer mudança. Depois você revisa o conteúdo e confirma com a senha.</p>
  <label class="adm-file"><input type="file" id="adm-restore-file" accept=".luminorbackup"/>${icon('upload')}<span><strong>Selecionar arquivo de backup</strong><small>Arquivo .luminorbackup do computador ou de um pendrive</small></span></label>`;
 if(r.step==='key')return `${notice(`<strong>${safe(r.file)}</strong> foi feito em outro computador ou com outra chave. Digite a chave de recuperação anotada pelo administrador.`,'warn','key')}
  <form class="form" data-form="restore-key"><label>Chave de recuperação<input name="key" class="mono" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" required autofocus/></label>
   <div class="form-actions"><button type="submit" class="primary">${icon('check')}Verificar arquivo</button><button type="button" class="link-btn" data-act="restore-cancel">Cancelar</button></div></form>`;
 const v=r.review,s=v.summary;
 return `<div class="adm-result ok">${icon('check')}<div><strong>Arquivo íntegro e compatível</strong><small>${safe(r.file)}</small></div></div>
  ${rows([['Criado em',when(v.createdAt)],['Tipo',KIND[v.kind]||v.kind||'—'],['Versão do PDV',v.appVersion||'—'],['Banco de origem',v.provider==='postgres'?'Nuvem (PostgreSQL)':'Local (SQLite)'],
   ['Vendas concluídas',`${s.sales.done} · ${money(s.sales.doneCents)}`],['Vendas canceladas',String(s.sales.canceled)],['Última venda',when(s.sales.lastAt)],['Turnos de caixa',`${s.shifts.total}${s.shifts.open?' (1 aberto)':''}`],
   ['Vendas abertas nas abas',String(s.openSales.sales)],['Produtos ativos',String(s.products.active)],['Funcionários ativos',String(s.employees.active)],['Chave',v.keySource==='recuperacao'?'Chave de recuperação':'Deste computador']])}
  ${notice('<strong>Os dados atuais serão substituídos pelos deste backup.</strong> Antes, um backup de segurança dos dados atuais é feito automaticamente. É preciso estar com o caixa fechado e sem nada na balança. A senha e os acessos do administrador não mudam.','warn','alert')}
  <div class="form-actions top-gap"><button type="button" class="danger-solid" data-act="restore-confirm">${icon('history')}Restaurar este backup</button><button type="button" class="secondary" data-act="restore-cancel">Cancelar</button></div>`;
}
VIEWS.backup=()=>{
 const b=A.backup,s=b.settings,lb=A.lastBackup;
 return `${head('Backup e restauração','Cópias criptografadas de todos os dados de vendas, caixas, produtos e funcionários.')}
  ${alertList(b.alerts)}
  ${b.supported?'':notice('O banco de dados está indisponível agora: não dá para fazer backup. Veja Banco de dados.','danger','alert')}
  <div class="columns">
   <div class="card"><div class="card-title"><span>Fazer backup agora</span>${icon('download')}</div>
    <p class="minor">Gera o arquivo em segundos. As vendas não param. Depois você pode baixar uma cópia para um pendrive.</p>
    ${rows([['Último backup',b.lastSuccess?`${when(b.lastSuccess.at)} · ${KIND[b.lastSuccess.kind]||b.lastSuccess.kind}`:'Nenhum ainda',b.lastSuccess?'':'neg'],['Próximo automático',s.enabled?when(b.next):'Desligado'],['Pasta dos backups',b.folder,'mono']])}
    <div class="form-actions top-gap"><button type="button" class="primary" data-act="backup-now" ${b.supported?'':'disabled'}>${icon('download')}Fazer backup agora</button></div>
    ${lb?`<div class="adm-result ok">${icon('check')}<div><strong>Backup gravado</strong><small>${safe(lb.name)} · ${bytes(lb.bytes)} · ${lb.summary.sales.done} vendas</small><div class="form-actions"><button type="button" class="secondary" data-act="download" data-name="${safe(lb.name)}">${icon('download')}Baixar arquivo</button></div></div></div>`:''}
   </div>
   <div class="card"><div class="card-title"><span>Restaurar ou verificar backup</span>${icon('history')}</div>${restoreBlock()}</div>
   <div class="card"><div class="card-title"><span>Backup automático</span>${icon('history')}</div>
    <form class="form" data-form="backup-settings">
     <label class="adm-switch"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}/><span class="adm-track" aria-hidden="true"></span>Fazer backup automático todos os dias</label>
     <div class="grid2"><label>Horário<input name="time" type="time" value="${safe(s.time)}" required/></label><label>Dias de backup diário guardados<input name="retentionDays" type="number" min="1" max="90" value="${s.retentionDays}" required/></label></div>
     <p class="minor">Se o computador estiver desligado no horário, o backup é feito assim que o PDV abrir. Também são guardados 4 backups semanais e 3 mensais, e um backup é feito depois de cada fechamento de caixa.</p>
     <div class="form-actions"><button type="submit" class="primary">${icon('check')}Salvar</button></div>
    </form>
   </div>
   <div class="card"><div class="card-title"><span>Cópia em outro lugar</span>${icon('folder')}</div>
    <p class="minor">Cada backup também é copiado para esta pasta, por exemplo um pendrive ou HD externo (E:\\Backups PDV). Se ela não estiver conectada, o backup continua no computador e aparece um aviso.</p>
    <form class="form" data-form="backup-folder"><label>Pasta de destino<input name="extraFolder" spellcheck="false" placeholder="E:\\Backups PDV" value="${safe(s.extraFolder||'')}"/></label>
     ${b.lastCopy?`<p class="minor">Última cópia: ${when(b.lastCopy.at)} em ${safe(b.lastCopy.folder)}</p>`:''}
     <div class="form-actions"><button type="submit" class="primary">${icon('check')}Salvar pasta</button>${s.extraFolder?`<button type="button" class="link-btn" data-act="folder-clear">Parar de copiar</button>`:''}</div></form>
   </div>
   <div class="card"><div class="card-title"><span>Chave de recuperação</span>${icon('key')}</div>
    <p class="minor">Os backups são criptografados. Neste computador eles abrem sozinhos; em outro computador (se este quebrar ou for roubado) só abrem com esta chave. Anote e guarde fora do computador.</p>
    ${rows([['Situação',b.recoveryKey.confirmed?'Anotada':'Ainda não anotada',b.recoveryKey.confirmed?'pos':'neg'],['Identificação',b.recoveryKey.id||'—','mono']])}
    ${A.key?`<div class="adm-secret"><small>Chave de recuperação</small><strong class="mono">${safe(A.key)}</strong></div>
     <div class="form-actions"><button type="button" class="primary" data-act="key-confirm">${icon('check')}Já anotei em local seguro</button><button type="button" class="link-btn" data-act="key-hide">Esconder</button></div>`
     :`<div class="form-actions top-gap"><button type="button" class="secondary" data-act="key-show">${icon('key')}Mostrar chave</button></div>`}
   </div>
  </div>
  <div class="card top-gap"><div class="card-title"><span>Histórico</span><span class="minor">Últimos 20 registros</span></div>
   ${b.history.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Data</th><th>Tipo</th><th>Tamanho</th><th>Resultado</th></tr></thead><tbody>${b.history.map(h=>`<tr><td>${when(h.at)}</td><td>${safe(KIND[h.kind]||h.kind)}</td><td>${h.bytes?bytes(h.bytes):'—'}</td><td>${h.ok===false?`<span class="tag off">Falhou</span> <small class="neg">${safe(h.error)}</small>`:h.skipped?`<span class="tag">Sem mudanças</span>`:`<span class="tag on">OK</span>`}</td></tr>`).join('')}</tbody></table></div>`:emptyState('history','Nenhum backup ainda','')}
   ${b.files.length?`<div class="section-label spaced">Arquivos neste computador</div><div class="adm-files">${b.files.map(f=>`<div class="rowline"><div class="grow"><strong class="mono">${safe(f.name)}</strong><small>${safe(KIND[f.kind]||f.kind)} · ${bytes(f.bytes)}</small></div><button type="button" class="secondary" data-act="download" data-name="${safe(f.name)}" aria-label="Baixar ${safe(f.name)}">${icon('download')}Baixar</button></div>`).join('')}</div>`:''}
  </div>`;
};
VIEWS.seguranca=()=>{
 const u=A.status.user,code=A.code;
 return `${head('Segurança','Usuário e senha do administrador, código de emergência e acessos recentes.')}
  <div class="columns">
   <div class="card"><div class="card-title"><span>Alterar senha</span>${icon('lock')}</div>
    <form class="form" data-form="change-password">
     <label>Senha atual<input name="current" type="password" autocomplete="current-password" maxlength="128" required/></label>
     <label>Nova senha<input name="next" type="password" autocomplete="new-password" minlength="12" maxlength="128" required data-strength/></label>
     <label>Repita a nova senha<input name="repeat" type="password" autocomplete="new-password" maxlength="128" required data-strength/></label>
     <ul class="adm-rules" data-rules><li data-rule="len">${icon('check')}Pelo menos 12 caracteres</li><li data-rule="user">${icon('check')}Sem o nome de usuário</li><li data-rule="same">${icon('check')}As duas senhas iguais</li></ul>
     ${u.passwordChangedAt?`<p class="minor">Última troca: ${when(u.passwordChangedAt)}</p>`:''}
     <div class="form-actions"><button type="submit" class="primary">${icon('check')}Alterar senha</button></div>
    </form>
   </div>
   <div class="card"><div class="card-title"><span>Alterar usuário</span>${icon('user')}</div>
    <form class="form" data-form="change-username">
     <label>Usuário atual<input value="${safe(u.username)}" disabled/></label>
     <label>Novo usuário<input name="username" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="3" maxlength="32" pattern="[A-Za-z0-9._\\-]{3,32}" required/></label>
     <p class="minor">De 3 a 32 letras sem acento, números, ponto, hífen ou sublinhado.</p>
     <div class="form-actions"><button type="submit" class="primary">${icon('check')}Alterar usuário</button></div>
    </form>
   </div>
   <div class="card"><div class="card-title"><span>Código de recuperação de emergência</span>${icon('key')}</div>
    <p class="minor">Se a senha for esquecida, este código libera a criação de uma nova. Ele aparece uma vez só e vale um único uso. Gerar outro invalida o anterior.</p>
    ${rows([['Situação',u.hasRecoveryCode?`Gerado em ${when(u.recoveryCreatedAt)}`:'Nenhum código gerado',u.hasRecoveryCode?'pos':'neg']])}
    ${code?`<div class="adm-secret"><small>Anote agora: este código não aparece de novo</small><strong class="mono">${safe(code)}</strong></div><div class="form-actions"><button type="button" class="primary" data-act="code-hide">${icon('check')}Já anotei</button></div>`
     :`<div class="form-actions top-gap"><button type="button" class="secondary" data-act="code-new">${icon('key')}${u.hasRecoveryCode?'Gerar novo código':'Gerar código'}</button></div>`}
   </div>
   <div class="card"><div class="card-title"><span>Sessão</span>${icon('logout')}</div>
    <p class="minor">Conectado como <strong>${safe(u.username)}</strong>. A sessão termina sozinha após 15 minutos sem uso ou 8 horas depois de entrar. Cinco senhas erradas bloqueiam o acesso por 5 minutos.</p>
    <button type="button" class="secondary" data-act="logout">${icon('logout')}Encerrar sessão</button>
   </div>
  </div>
  <div class="card top-gap"><div class="card-title"><span>Acessos recentes</span><span class="minor">Painel administrativo</span></div>
   ${A.access.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Data</th><th>Usuário</th><th>Evento</th></tr></thead><tbody>${A.access.map(a=>`<tr><td>${when(a.at)}</td><td>${safe(a.username||'—')}</td><td>${a.ok?'':'<span class="tag off">Falha</span> '}${safe(ACTIONS[a.action]||a.action)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('shield','Nenhum acesso registrado','')}
  </div>`;
};
VIEWS.manutencao=()=>{
 const d=A.diag,sv=d.service,sc=d.scale,db=d.database,pg=db.postgres;
 const disk=d.disk?`${bytes(d.disk.freeBytes)} livres de ${bytes(d.disk.totalBytes)}`:'—';const lowDisk=d.disk&&d.disk.freeBytes<2*1073741824;
 return `${head('Manutenção','Situação do sistema, erros recentes e diagnóstico para o suporte.')}
  <div class="adm-tiles">
   ${[['Versão instalada',d.version,'info',''],['Serviço do PDV',`Em execução há ${duration(sv.uptimeSec)}`,'play','pos'],
     ['Balança Toledo',sc.mode==='offline'?'Desconectada':sc.mode==='demo'?'Simulador ativo':SCALE[sc.status]||sc.status,'scale',sc.mode==='serial'&&sc.status!=='offline'?'pos':'warn'],
     ['Banco ativo',db.provider==='sqlite'?'Local (SQLite)':'Nuvem (PostgreSQL)','database',''],
     ['Supabase',pg?(pg.connected?'Conectado':'Indisponível'):'Não usado','cloud',pg?(pg.connected?'pos':'neg'):''],
     ['Último backup',when(d.backup.lastSuccessAt),'download',d.backup.lastFailure?'neg':d.backup.lastSuccessAt?'':'warn'],
     ['Espaço em disco',disk,'folder',lowDisk?'neg':'']].map(([l,v,ic,c])=>`<div class="adm-tile"><span class="adm-tile-icon">${icon(ic)}</span><small>${l}</small><strong class="${c}">${safe(v)}</strong></div>`).join('')}
  </div>
  <div class="columns top-gap">
   <div class="card"><div class="card-title">Detalhes</div>
    ${rows([['Processo',`PID ${sv.pid} · ${sv.memoryMb} MB de memória`],['Node.js',sv.node],['Sistema',sv.platform],['Início automático pelo Windows',sv.supervised?'Sim':'Não (aberto manualmente)'],
      ['Porta da balança',sc.port||'Não configurada'],sc.lastError&&['Último erro da balança',sc.lastError,'neg'],pg&&['Servidor na nuvem',`${pg.host}:${pg.port}`],pg?.lastError&&['Último erro da nuvem',pg.lastError.message,'neg'],
      d.backup.lastFailure&&['Última falha de backup',`${when(d.backup.lastFailure.at)} · ${d.backup.lastFailure.error}`,'neg']])}
    <div class="form-actions top-gap"><button type="button" class="primary" data-act="diag-export">${icon('download')}Exportar diagnóstico</button><button type="button" class="secondary" data-act="go" data-to="manutencao">${icon('refresh')}Atualizar</button></div>
    <p class="minor top-gap">O diagnóstico não inclui senhas, chaves nem dados de vendas. Envie ao suporte quando pedirem.</p>
   </div>
   <div class="card"><div class="card-title"><span>Erros recentes</span><span class="minor">${plural(d.logs.errors.length,'erro','erros')}</span></div>
    ${d.logs.errors.length?`<pre class="adm-log">${d.logs.errors.map(l=>safe(logLine(l))).join('\n')}</pre>`:emptyState('check','Nenhum erro registrado','')}
   </div>
  </div>
  <div class="card top-gap"><div class="card-title"><span>Registro recente</span><span class="minor">${safe(d.paths.logs)}</span></div>
   ${d.logs.recent.length?`<pre class="adm-log tall">${d.logs.recent.map(l=>safe(logLine(l))).join('\n')}</pre>`:emptyState('history','Sem registros','')}
  </div>`;
};
VIEWS.preferencias=()=>{
 const d=A.diag,b=A.backup,st=d.settings||{};
 return `${head('Configurações','Preferências técnicas desta instalação.')}
  <div class="columns">
   <div class="card"><div class="card-title"><span>Backup automático</span>${icon('history')}</div>
    ${rows([['Situação',b.settings.enabled?`Ligado, todos os dias às ${b.settings.time}`:'Desligado',b.settings.enabled?'pos':'neg'],['Dias de backup diário guardados',String(b.settings.retentionDays)],['Cópia em outra pasta',b.settings.extraFolder||'Não']])}
    <div class="form-actions top-gap"><button type="button" class="secondary" data-act="go" data-to="backup">${icon('sliders')}Alterar em Backup e restauração</button></div>
   </div>
   <div class="card"><div class="card-title"><span>Endereço e horário</span>${icon('sliders')}</div>
    ${rows([['Endereço do PDV',`http://127.0.0.1:${st.port||3187}`],['Fuso horário da loja',st.timezone||'America/Sao_Paulo'],['Proteção das senhas guardadas',st.vault==='dpapi'?'Windows (DPAPI)':'Arquivo de chave local']])}
    <p class="minor top-gap">Porta e fuso horário ficam no arquivo de configuração abaixo. Altere só com orientação do suporte e reinicie o PDV depois.</p>
    ${rows([['Arquivo de configuração',st.envFile||'—','mono']])}
   </div>
   <div class="card"><div class="card-title"><span>Pastas desta instalação</span>${icon('folder')}</div>
    ${rows([['Pasta principal',d.paths.home,'mono'],['Banco de dados',d.paths.data,'mono'],['Backups',d.paths.backups,'mono'],['Registros (logs)',d.paths.logs,'mono']])}
    <p class="minor top-gap">Os dados ficam fora da pasta do programa: atualizar ou reinstalar o PDV não apaga nada.</p>
   </div>
   <div class="card"><div class="card-title"><span>Balança e operação</span>${icon('scale')}</div>
    <p class="minor">Porta da balança, preço por quilo, lançamento automático e funcionários ficam nas telas de operação.</p>
    <div class="form-actions"><button type="button" class="secondary" data-goto="balanca">${icon('scale')}Balança Toledo</button><button type="button" class="secondary" data-goto="funcionarios">${icon('users')}Funcionários</button></div>
   </div>
  </div>`;
};
VIEWS.sobre=()=>{
 const d=A.diag;
 return `${head('Sobre o sistema','Versão instalada e como atualizar.')}
  <div class="columns">
   <div class="card"><div class="card-title"><span>Luminor PDV</span><span class="adm-badge on">Versão ${safe(d.version)}</span></div>
    ${rows([['Versão',d.version],['Node.js',d.service.node],['Sistema',d.service.platform],['Em execução desde',when(d.service.startedAt)]])}
    <p class="minor top-gap">Frente de caixa para açaí por peso com balança Toledo. Não emite documentos fiscais.</p>
   </div>
   <div class="card"><div class="card-title"><span>Atualizações</span>${icon('refresh')}</div>
    <ol class="adm-list">
     <li>Feche o caixa.</li>
     <li>Rode o instalador da nova versão (<code>instalador\\instalar.ps1</code>, como administrador do Windows).</li>
     <li>O instalador faz um backup antes, troca o programa e abre o PDV de novo.</li>
    </ol>
    <p class="minor">Os dados, a senha do administrador, as chaves e os backups ficam em <span class="mono">${safe(d.paths.home)}</span> e são mantidos. Uma atualização nunca volta para a senha inicial.</p>
   </div>
  </div>`;
};

// --- Actions ------------------------------------------------------------------------------------------------------
const formData=form=>Object.fromEntries(new FormData(form).entries());
const showError=(form,msg)=>{const p=form.querySelector('[data-error]');if(!p)return flash(msg,true);p.textContent=msg;p.classList.toggle('hidden',!msg);};
function checkRules(form){
 const next=form.elements.next?.value||'',repeat=form.elements.repeat?.value||'',user=String(A.status?.user?.username||'').toLowerCase();
 const r={len:next.length>=12,user:!next||user.length<3||!next.toLowerCase().includes(user),same:!!next&&next===repeat};
 form.querySelectorAll('[data-rule]').forEach(li=>li.classList.toggle('ok',r[li.dataset.rule]));
 return r.len&&r.user&&r.same;
}
const FORMS={
 async login(form,btn){
  const {username,password}=formData(form);showError(form,'');
  await guardForm(form,btn,async()=>{
   const r=await apiPost('login',{username,password});
   A.current=r.user.mustChangePassword?password:null;go(r.user.mustChangePassword?'password':'panel');
  });
 },
 async recover(form,btn){
  const {username,code}=formData(form);showError(form,'');
  await guardForm(form,btn,async()=>{await apiPost('recover',{username,code});A.current=null;go('password');});
 },
 async password(form,btn){
  showError(form,'');if(!checkRules(form))return showError(form,'Confira os requisitos da nova senha.');
  const {next}=formData(form);const current=form.elements.current?form.elements.current.value:A.current;
  await guardForm(form,btn,async()=>{await apiPost('change-password',{current,next});A.current=null;flash('Senha definida. Guarde-a em local seguro.');go('panel');});
 },
 async 'change-password'(form,btn){
  showError(form,'');if(!checkRules(form))return flash('Confira os requisitos da nova senha.',true);
  const {current,next}=formData(form);
  await guard(btn,async()=>{await apiPost('change-password',{current,next});flash('Senha alterada. As outras sessões foram encerradas.');go('seguranca');});
 },
 async 'change-username'(form){
  const {username}=formData(form);
  const r=await withPassword({title:'Alterar o usuário?',message:`O novo usuário para entrar no painel será "${username}".`,confirmLabel:'Alterar usuário'},pw=>apiPost('change-username',{username,password:pw}));
  if(r){flash(`Usuário alterado para ${r.result.username}`);go('seguranca');}
 },
 async 'db-test'(form,btn){
  const {url,password,ca}=formData(form);if(!url.trim())return flash('Cole o endereço de conexão do Supabase.',true);
  await guard(btn,async()=>{A.cloud.test=await apiPost('database/test',{url,password,ca});A.cloud.prepared=!!A.cloud.test.prepared;flash('Conexão testada com sucesso');go('banco');});
 },
 async 'backup-settings'(form,btn){
  const enabled=form.elements.enabled.checked,{time,retentionDays}=formData(form);
  await guard(btn,async()=>{await apiPost('backup/settings',{enabled,time,retentionDays:Number(retentionDays)});flash('Backup automático salvo');go('backup');});
 },
 async 'backup-folder'(form,btn){
  const {extraFolder}=formData(form);
  await guard(btn,async()=>{await apiPost('backup/settings',{extraFolder});flash(extraFolder.trim()?'Pasta salva. Os próximos backups também serão copiados para lá.':'Cópia desligada');go('backup');});
 },
 async 'restore-key'(form,btn){
  const {key}=formData(form);await guard(btn,()=>validateRestore(key));
 }
};
async function guardForm(form,btn,fn){
 btn.disabled=true;btn.classList.add('busy');
 try{await fn();}catch(e){showError(form,e.message);}finally{if(btn.isConnected){btn.disabled=false;btn.classList.remove('busy');}}
}
async function validateRestore(key){
 const r=A.restore;
 try{const review=await apiPost('backup/restore/validate',{uploadId:r.upload.uploadId,recoveryKey:key||undefined});A.restore={...r,step:'review',review};}
 catch(e){
  if(e.data?.needsRecoveryKey){A.restore={...r,step:'key'};if(key)flash(e.message,true);}
  else if(e.status===404){A.restore=null;flash(e.message,true);}
  else if(!(await sessionLost(e))){if(r.step!=='key')A.restore=null;flash(e.message,true);}
 }
 draw();
}
async function uploadRestore(input){
 const file=input.files?.[0];if(!file)return;
 const label=input.closest('.adm-file');label.classList.add('busy');
 try{const up=await request('POST','backup/restore/upload',{binary:file});A.restore={upload:up,file:file.name,step:'validate'};await validateRestore(null);}
 catch(e){if(!(await sessionLost(e))){flash(e.message,true);A.restore=null;draw();}}
}
const ACTS={
 home:()=>go('home'),enter,
 go:b=>go(b.dataset.to),
 async logout(b){await guard(b,async()=>{await apiPost('logout');});A.restore=null;A.key=null;A.code=null;A.lastBackup=null;A.cloud={test:null,prepared:false};go('home');},
 integrity:b=>guard(b,async()=>{const r=await apiPost('database/integrity');flash(r.ok?'Banco íntegro':`Problema encontrado: ${r.message}`,!r.ok);go(A.view);}),
 async 'db-prepare'(){
  const r=await withPassword({title:'Preparar o banco na nuvem?',message:'Cria as tabelas do PDV no banco do Supabase testado. Nada muda no banco local.',confirmLabel:'Preparar',iconName:'database'},pw=>apiPost('database/prepare',{password:pw}));
  if(r){A.cloud.prepared=true;flash(r.result.empty?'Banco na nuvem preparado e vazio, pronto para a migração':'Banco na nuvem preparado');go('banco');}
 },
 async 'db-migrate'(){
  const r=await withPassword({title:'Migrar os dados locais?',message:'Com o caixa fechado, as vendas pausam por alguns instantes: é feito um backup de segurança, todos os registros são copiados para a nuvem e conferidos tabela por tabela. O banco local continua ativo.',confirmLabel:'Migrar e conferir',iconName:'upload'},pw=>apiPost('database/migrate',{password:pw}));
  if(r){flash('Migração concluída e conferida');go('banco');}else go('banco');
 },
 async 'db-activate'(){
  const r=await withPassword({title:'Ativar o banco na nuvem?',message:'A partir de agora as vendas são gravadas no Supabase e é preciso internet para vender. O banco local fica guardado como estava.',confirmLabel:'Ativar banco na nuvem',iconName:'cloud'},pw=>apiPost('database/activate',{password:pw}));
  if(r){A.cloud={test:null,prepared:false};flash('Banco na nuvem ativo');go('banco');}
 },
 async 'db-local'(){
  const mode=root().querySelector('input[name="local-mode"]:checked')?.value||'copiar';
  const r=await withPassword({title:'Voltar para o banco local?',message:mode==='copiar'?'Os dados da nuvem são copiados para este computador e conferidos. O PDV volta a funcionar sem internet.':'O PDV volta a usar o banco local como estava na migração. Vendas feitas na nuvem depois disso não estarão nele.',confirmLabel:'Voltar para o banco local',tone:mode==='copiar'?'primary':'danger-solid',iconName:'database'},pw=>apiPost('database/use-local',{password:pw,mode}));
  if(r){flash('Banco local ativo');go('banco');}
 },
 'backup-now':b=>guard(b,async()=>{A.lastBackup=await apiPost('backup/export');flash('Backup gravado');go('backup');}),
 download:b=>guard(b,async()=>{const n=await download('backup/download',{name:b.dataset.name},{description:'Backup do Luminor PDV',extension:'.luminorbackup',mime:'application/octet-stream'});if(n)flash(`Arquivo salvo: ${n}`);}),
 'folder-clear':b=>guard(b,async()=>{await apiPost('backup/settings',{extraFolder:''});flash('Cópia desligada');go('backup');}),
 async 'key-show'(){const r=await withPassword({title:'Mostrar a chave de recuperação?',message:'Confira se ninguém está olhando a tela.',confirmLabel:'Mostrar',iconName:'key'},pw=>apiPost('backup/recovery-key',{password:pw}));if(r){A.key=r.result.key;draw();}},
 'key-hide':()=>{A.key=null;draw();},
 'key-confirm':b=>guard(b,async()=>{await apiPost('backup/recovery-key/confirm');A.key=null;flash('Chave marcada como anotada');go('backup');}),
 async 'restore-cancel'(){const r=A.restore;A.restore=null;draw();if(r?.upload)apiPost('backup/restore/cancel',{uploadId:r.upload.uploadId}).catch(()=>{});},
 async 'restore-confirm'(){
  const r=A.restore;if(!r?.review)return;const s=r.review.summary;
  const done=await withPassword({title:'Restaurar este backup?',message:'Os dados atuais serão substituídos. Um backup de segurança deles é feito antes.',confirmLabel:'Restaurar backup',tone:'danger-solid',
   details:[['Backup de',when(r.review.createdAt)],['Vendas concluídas',`${s.sales.done} · ${money(s.sales.doneCents)}`],['Produtos',String(s.products.active)]]},pw=>apiPost('backup/restore',{uploadId:r.upload.uploadId,password:pw}));
  if(!done)return;
  A.restore=null;const h=done.result.hardware;
  flash(`Backup restaurado. Backup de segurança: ${done.result.safetyBackup}`);
  if(h?.configured&&!h.found)setTimeout(()=>flash(`A balança configurada (${h.path}) não foi encontrada neste computador. Confira a aba Balança.`,true),3800);
  if(typeof refresh==='function')refresh();go('backup');
 },
 async 'code-new'(){const r=await withPassword({title:'Gerar código de recuperação?',message:'O código anterior, se existir, deixa de valer.',confirmLabel:'Gerar código',iconName:'key'},pw=>apiPost('recovery-code',{password:pw}));if(r){A.code=r.result.code;A.status=await status().catch(()=>A.status);draw();}},
 'code-hide':()=>{A.code=null;go('seguranca');},
 'diag-export':b=>guard(b,async()=>{const n=await download('diagnostics/export',{},{description:'Diagnóstico do Luminor PDV',extension:'.json',mime:'application/json'});if(n)flash(`Diagnóstico salvo: ${n}`);})
};
function wire(){
 const el=root();if(!el||el._wired)return;el._wired=true;
 el.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(!b||!el.contains(b))return;const f=ACTS[b.dataset.act];if(f){e.preventDefault();f(b);}});
 el.addEventListener('submit',e=>{const form=e.target.closest('[data-form]');if(!form)return;e.preventDefault();const f=FORMS[form.dataset.form];if(f)f(form,form.querySelector('[type="submit"]'));});
 el.addEventListener('input',e=>{if(e.target.matches('[data-strength]'))checkRules(e.target.form);});
 el.addEventListener('change',e=>{if(e.target.id==='adm-restore-file')uploadRestore(e.target);});
}
window.LuminorAdmin={open(){wire();const v=A.view;go(['home','login','recover','password','demo','erro'].includes(v)?(v==='erro'?'home':v):v);}};
})();
