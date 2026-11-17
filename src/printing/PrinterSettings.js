'use strict';
// "Impressora de fechamento": the settings of this computer's receipt printer, kept in config/admin.sqlite
// (admin_settings, key "printer"). Per computer on purpose: never copied to the cloud or to a backup of another machine.
// The queue name is kept as typed (Windows allows spaces and accents) and only ever passed as data, never as a command.
const {clampWidth}=require('./ThermalReceiptBuilder');
const TYPES={elgin_i9:'Elgin i9 (térmica 80 mm, ESC/POS)',generic_80:'Genérica 80 mm (texto simples)'};
const TRANSPORTS=['windows-spooler','elgin-e1','browser'];
const DEFAULTS={printerName:'',type:'elgin_i9',transport:'windows-spooler',autoPrint:false,autoCut:false,cutVerified:false,copies:1,storeName:'',unit:'',header:'',footer:'',columns:48};
const bad=m=>{throw Object.assign(Error(m),{status:400});};
const text=(v,max,label)=>{const s=String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();if([...s].length>max)bad(`${label}: no máximo ${max} caracteres.`);return s;};
function normalize(input,current=DEFAULTS){
  const s={...DEFAULTS,...current};const i=input||{};
  if(i.printerName!==undefined)s.printerName=text(i.printerName,120,'Nome da impressora');
  if(i.type!==undefined){if(!TYPES[i.type])bad('Tipo de impressora inválido.');s.type=i.type;}
  if(i.transport!==undefined){if(!TRANSPORTS.includes(i.transport))bad('Forma de envio inválida.');s.transport=i.transport;}
  for(const k of ['autoPrint','autoCut'])if(i[k]!==undefined){if(typeof i[k]!=='boolean')bad('Opção inválida.');s[k]=i[k];}
  if(i.copies!==undefined){const n=Number(i.copies);if(!Number.isInteger(n)||n<1||n>3)bad('Vias: de 1 a 3.');s.copies=n;}
  if(i.columns!==undefined){const n=Number(i.columns);if(!Number.isInteger(n)||n<32||n>64)bad('Caracteres por linha: de 32 a 64.');s.columns=n;}
  if(i.storeName!==undefined)s.storeName=text(i.storeName,40,'Nome da loja');
  if(i.unit!==undefined)s.unit=text(i.unit,40,'Unidade');
  if(i.header!==undefined)s.header=text(i.header,60,'Cabeçalho');
  if(i.footer!==undefined)s.footer=text(i.footer,60,'Rodapé');
  // The cut command is sent only after the administrator saw it work on this printer (a test print with cut).
  if(i.cutVerified!==undefined){if(typeof i.cutVerified!=='boolean')bad('Opção inválida.');s.cutVerified=i.cutVerified;}
  if(s.type==='generic_80'){s.autoCut=false;s.cutVerified=false;}
  s.columns=clampWidth(s.columns);
  return s;
}
class PrinterSettings {
  constructor(store){this.store=store;}
  async get(){return normalize(await this.store.setting('printer',null)||{},DEFAULTS);}
  async save(input){const next=normalize(input,await this.get());await this.store.setSetting('printer',next);return next;}
}
module.exports={PrinterSettings,normalize,DEFAULTS,TYPES,TRANSPORTS};
