// The till's sign-in in the online demo: test identities whose PINs are printed on the sign-in screen, one session
// kept only in this page (the demo is one terminal and its requests never leave the browser, so there are no cookies).
// The installed PDV never uses this file: it signs in with src/auth/PosAuth.js (PINs hashed with Argon2id in
// config/admin.sqlite, no default PIN, the administrator's own password). Only demo/build.js puts it in dist/.
const DEMO_PEOPLE=[
  {name:'Ana Paula',pin:'102030',profile:'operadora',extra:[]},
  {name:'Bruno Lima',pin:'405060',profile:'supervisor',extra:['screen.relatorios','screen.produtos','cash.view_expected','cash.view_history','cash.move','sales.cancel','sales.correct','reports.view','products.view']},
  {name:'Carla Souza',pin:'708090',profile:'só vendas',only:['screen.vendas','sales.create','sales.checkout','sales.manual_weight']}
];
const DEMO_ADMIN={username:'admin',password:'demo'};
const DEMO_HINT=`PINs de teste: ${DEMO_PEOPLE.map(p=>`${p.name} ${p.pin} (${p.profile})`).join(' · ')} · Administrador: usuário ${DEMO_ADMIN.username}, senha ${DEMO_ADMIN.password}.`;
function createDemoAuth({db,require}){
  const Authz=require('./auth/AuthorizationService');const {CATALOG,SCREENS,defaultProfile}=require('./auth/PermissionCatalog');
  const ADMIN={kind:'admin',key:'admin:demo',name:'Administrador',username:DEMO_ADMIN.username,employeeId:null};
  let session=null,last=null;const log=[];
  const busy=()=>Authz.httpError(409,'Retire o produto da balança antes de trocar de pessoa no caixa.',{scaleBusy:true});
  const person=e=>e&&e.active?DEMO_PEOPLE.find(p=>p.name===e.name):null;
  async function identityOf(s){
    if(!s)return null;if(s.kind==='admin')return {...ADMIN,locked:s.locked};
    const e=(await db.accessIndex()).byUuid.get(s.uuid);
    if(!person(e)){session=null;return null;}
    return {kind:'operador',key:'operador:'+e.uuid,uuid:e.uuid,name:e.name,employeeId:e.id,permissions:new Set(e.allowed),locked:s.locked};
  }
  // The same view as src/auth/PosAuth.js: the person, the permissions and the screens.
  function view(identity){
    if(!identity)return {authenticated:false};
    const permissions=CATALOG.map(p=>p.id).filter(p=>Authz.hasPermission({...identity,locked:false},p));
    const who={kind:identity.kind,name:identity.name,employeeId:identity.employeeId,uuid:identity.uuid||null,username:identity.username||null};
    if(identity.locked)return {authenticated:false,locked:true,person:who};
    return {authenticated:true,locked:false,person:who,isAdmin:identity.kind==='admin',permissions,screens:SCREENS.filter(s=>permissions.includes(s.id)).map(s=>s.tab)};
  }
  const actor=identity=>({kind:identity.kind,employeeId:identity.employeeId??null,name:identity.name});
  return {
    demo:{hint:DEMO_HINT},view,actor,
    // Gives the test identities their profiles when they have none (the example data, or a copy saved in this
    // browser by an older demo).
    async prepare(){
      const index=await db.accessIndex();
      for(const p of DEMO_PEOPLE){
        const e=[...index.byId.values()].find(x=>x.name===p.name);if(!e||e.allowed.length)continue;
        const profile=p.only?Object.fromEntries(CATALOG.map(c=>[c.id,p.only.includes(c.id)])):{...defaultProfile(),...Object.fromEntries(p.extra.map(x=>[x,true]))};
        await db.savePermissions(e.id,profile,{by:'demonstração'});
      }
    },
    identify:()=>identityOf(session),
    async options(){const index=await db.accessIndex();return [...index.byUuid.values()].filter(person).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')).map(e=>({uuid:e.uuid,name:e.name}));},
    async login(body,{scaleIdle}){
      let next;
      if(body?.mode==='admin'){
        if(String(body.username||'').trim().toLowerCase()!==DEMO_ADMIN.username||body.password!==DEMO_ADMIN.password)throw Authz.httpError(401,'Usuário ou senha incorretos.');
        next={kind:'admin'};
      }else{
        const e=(await db.accessIndex()).byUuid.get(String(body?.employeeUuid||''));const p=person(e);
        if(!p||String(body?.pin||'')!==p.pin)throw Authz.httpError(401,'Funcionário ou PIN incorretos.');
        next={kind:'operador',uuid:e.uuid};
      }
      const key=next.kind==='admin'?ADMIN.key:'operador:'+next.uuid;
      if(!scaleIdle&&last&&last!==key)throw busy();
      session={...next,locked:false};last=key;
      const who=await identityOf(session);log.push({at:new Date().toISOString(),username:who.name,action:'login_operador'});
      return {cookies:[],session:view(who)};
    },
    async logout(_req,{scaleIdle}){
      if(session&&!scaleIdle)throw Authz.httpError(409,'Retire o produto da balança antes de sair.',{scaleBusy:true});
      session=null;return {cookies:[]};
    },
    async lock(){
      const who=await identityOf(session);if(!who)throw Authz.httpError(401,'Entre com o seu usuário para usar o caixa.',{auth:'login'});
      session.locked=true;return {cookies:[],session:view({...who,locked:true})};
    },
    async terminalActor(){const who=await identityOf(session);return who&&!who.locked&&Authz.hasPermission(who,'sales.create')?actor(who):null;},
    async employeeDeactivated(){await identityOf(session);},
    audit(e){log.push({at:new Date().toISOString(),...e});if(log.length>200)log.shift();}
  };
}
