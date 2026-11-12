'use strict';
// Everything an operator (an employee who signs in with a PIN) may be allowed to do, in one list. The administrator
// has all of it plus the administrative operations that are never granted to an operator (ADMIN_ONLY). Nothing is
// allowed by absence: an employee without a stored "allowed" row for a permission does not have it, and an id that is
// not in this list is refused for everybody, the administrator included.
//   screen.*  which screens of public/index.html the operator sees (navigation only: a screen never grants the
//             actions inside it, which have their own permissions below)
//   default   the "operador padrão" profile the administrator can apply (never applied by itself)
//   critical  removing it also ends the operator's open sessions
const SCREENS=[
  {id:'screen.vendas',tab:'vendas',label:'Frente de caixa',default:true},
  {id:'screen.historico',tab:'historico',label:'Histórico de vendas',default:true,note:'Sem "Ver relatórios", mostra só as vendas do caixa aberto.'},
  {id:'screen.caixa',tab:'caixa',label:'Movimentação de caixa',default:true},
  {id:'screen.produtos',tab:'produtos',label:'Produtos e estoque',default:false},
  {id:'screen.relatorios',tab:'relatorios',label:'Relatórios',default:false},
  {id:'screen.funcionarios',tab:'funcionarios',label:'Funcionários',default:false},
  {id:'screen.balanca',tab:'balanca',label:'Balança Toledo',default:false},
  {id:'screen.configuracoes',tab:'configuracoes',label:'Configurações',default:false,note:'A administração do sistema continua pedindo a senha do administrador.'}
];
const ACTIONS=[
  {id:'sales.create',group:'Vendas',label:'Abrir vendas e lançar itens (balança e produtos)',default:true},
  {id:'sales.checkout',group:'Vendas',label:'Cobrar vendas',default:true},
  {id:'sales.transfer',group:'Vendas',label:'Transferir itens entre vendas',default:true},
  {id:'sales.discard',group:'Vendas',label:'Descartar vendas abertas',default:true},
  {id:'sales.cancel',group:'Vendas',label:'Cancelar vendas concluídas',default:false,critical:true},
  {id:'sales.correct',group:'Vendas',label:'Cancelar e corrigir vendas concluídas',default:false,critical:true},
  {id:'sales.manual_weight',group:'Vendas',label:'Digitar o peso (balança sem comunicação)',default:true},
  {id:'sales.manual_value',group:'Vendas',label:'Digitar um valor fechado',default:false,critical:true},
  {id:'cash.open',group:'Caixa',label:'Abrir o caixa',default:true},
  {id:'cash.close',group:'Caixa',label:'Fechar o caixa (contagem do dinheiro)',default:true},
  {id:'cash.move',group:'Caixa',label:'Registrar sangria e suprimento',default:false,critical:true},
  {id:'cash.view_expected',group:'Caixa',label:'Ver o saldo esperado e a diferença exata do fechamento',default:false,critical:true,
    note:'Sem esta permissão o fechamento é cego: o funcionário vê só Conferido, Falta ou Sobra.'},
  {id:'cash.view_history',group:'Caixa',label:'Ver as movimentações do turno e o histórico de fechamentos',default:false,critical:true},
  {id:'products.view',group:'Gestão',label:'Consultar produtos e estoque',default:false},
  {id:'products.manage',group:'Gestão',label:'Cadastrar produtos e alterar preços e estoque',default:false,critical:true},
  {id:'reports.view',group:'Gestão',label:'Ver relatórios e o histórico completo de vendas',default:false,critical:true},
  {id:'employees.manage',group:'Gestão',label:'Cadastrar e desativar funcionários',default:false,critical:true},
  {id:'scale.manage',group:'Gestão',label:'Conectar e configurar a balança',default:false,critical:true},
  {id:'config.manage',group:'Gestão',label:'Alterar o preço por quilo e o lançamento automático',default:false,critical:true}
];
// Credentials, users and permissions, backups, restores and the database: the administrator's alone.
const ADMIN_ONLY=['admin.credentials','admin.users','admin.backups','admin.restore','admin.database'];
const CATALOG=[...SCREENS.map(s=>({...s,group:'Telas',kind:'screen'})),...ACTIONS.map(a=>({...a,kind:'action'}))];
const IDS=new Set(CATALOG.map(p=>p.id));
const CRITICAL=new Set(CATALOG.filter(p=>p.critical).map(p=>p.id));
const DEFAULTS=CATALOG.filter(p=>p.default).map(p=>p.id);
const TAB_PERMISSION=Object.fromEntries(SCREENS.map(s=>[s.tab,s.id]));
const isKnown=id=>IDS.has(id);
const isAdminOnly=id=>ADMIN_ONLY.includes(id);
// What the Admin screen shows: groups in order, with labels and the default profile.
function catalogView(){
  const groups=[];for(const p of CATALOG){let g=groups.find(x=>x.name===p.group);if(!g)groups.push(g={name:p.group,permissions:[]});g.permissions.push({id:p.id,label:p.label,default:!!p.default,critical:!!p.critical,note:p.note||null,kind:p.kind,tab:p.tab||null});}
  return {groups,defaults:DEFAULTS,adminOnly:ADMIN_ONLY};
}
// The operator default profile as an explicit allow/deny for every permission of the catalog.
function defaultProfile(){return Object.fromEntries(CATALOG.map(p=>[p.id,!!p.default]));}
module.exports={SCREENS,ACTIONS,CATALOG,ADMIN_ONLY,CRITICAL,DEFAULTS,TAB_PERMISSION,isKnown,isAdminOnly,catalogView,defaultProfile};
