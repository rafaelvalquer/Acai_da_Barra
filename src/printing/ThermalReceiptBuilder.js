'use strict';
// The 80 mm closing report, built from the structured close (src/services/ReconciliationService.js, as saved in the
// database) and nothing else: the amounts are the exact cents of the snapshot, never recalculated from today's data.
// It makes lines of text first (the same text goes to the thermal printer, to the screen preview and to the browser
// fallback) and then bytes for the printer:
//   escpos   ESC/POS commands, code page PC860 (Portuguese) as the Elgin i9 is set up; accents are encoded, and a
//            character the page does not have becomes its plain letter, or "?" as the last resort, never garbage
//   text     plain ASCII lines (a generic 80 mm driver that is not known to understand ESC/POS)
// No command comes from the browser: this file is the only place bytes are made.
const {localDay}=require('../services/util');
const WIDTH={min:32,max:64,default:48};
// Code page 860 (Portuguese), the upper half. Index 0 is byte 0x80.
const CP860_HIGH='ÇüéâãàÁçêÊèÍÔìÃÂÉÀÈôõòÚùÌÕÜ¢£Ù₧ÓáíóúñÑªº¿Ò¬½¼¡«»';
const CP860=new Map([...CP860_HIGH].map((ch,i)=>[ch,0x80+i]));
// Letters outside the page, without the accent (never silently dropped).
const strip=ch=>ch.normalize('NFD').replace(/[̀-ͯ]/g,'');
const SPECIAL={'–':'-','—':'-','’':"'",'‘':"'",'“':'"','”':'"','…':'...','•':'*','€':'EUR',' ':' '};
// One character as a printable string of the chosen page: [byte...] for escpos, plain ASCII for text.
function encodeText(text,{escpos=true}={}){
  const out=[];
  for(const ch of String(text??'').normalize('NFC')){
    const code=ch.codePointAt(0);
    if(code>=0x20&&code<0x7f){out.push(code);continue;}
    if(escpos&&CP860.has(ch)){out.push(CP860.get(ch));continue;}
    if(SPECIAL[ch]){for(const c of SPECIAL[ch])out.push(c.charCodeAt(0));continue;}
    const base=strip(ch);
    if(base&&base!==ch&&[...base].every(c=>c.codePointAt(0)>=0x20&&c.codePointAt(0)<0x7f)){for(const c of base)out.push(c.charCodeAt(0));continue;}
    if(ch==='\t'){out.push(0x20);continue;}
    out.push(0x3f); // "?" for anything else (control characters, emoji, other scripts)
  }
  return Buffer.from(out);
}
// Plain ASCII for the screen/browser text and the generic printer.
const ascii=s=>encodeText(s,{escpos:false}).toString('latin1');
const cents=c=>{const n=Number(c);const abs=Math.abs(n);return `${n<0?'-':''}R$ ${Math.floor(abs/100).toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${String(abs%100).padStart(2,'0')}`;};
const signed=c=>`${c>0?'+':''}${cents(c)}`;
const TZ=()=>process.env.LUMINOR_TIMEZONE||'America/Sao_Paulo';
function stamp(iso){
  if(!iso)return {date:'-',time:'-'};const d=new Date(iso);if(Number.isNaN(d.getTime()))return {date:'-',time:'-'};
  const fmt=new Intl.DateTimeFormat('pt-BR',{timeZone:TZ(),day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(d);
  const p=Object.fromEntries(fmt.map(x=>[x.type,x.value]));
  return {date:`${p.day}/${p.month}/${p.year}`,time:`${p.hour==='24'?'00':p.hour}:${p.minute}`};
}
const upper=s=>String(s??'').toLocaleUpperCase('pt-BR');
// Breaks a text at the width, on spaces when it can (a long word is cut).
function wrap(text,width){
  const out=[];
  for(const part of String(text??'').split(/\r?\n/)){
    let line='';
    for(const word of part.split(/\s+/).filter(Boolean)){
      let w=word;
      while([...w].length>width){if(line){out.push(line);line='';}out.push([...w].slice(0,width).join(''));w=[...w].slice(width).join('');}
      if(!line)line=w;else if([...line].length+1+[...w].length<=width)line+=' '+w;else{out.push(line);line=w;}
    }
    out.push(line);
  }
  return out;
}
// "label ........ value" on one line: the value stays whole at the right edge; the label is cut or wrapped.
function pair(label,value,width){
  const v=String(value);const room=width-[...v].length-1;
  if(room<4)return [...wrap(label,width),v.padStart(width)];
  const lab=wrap(label,room);const last=lab.pop();
  return [...lab,last+' '.repeat(Math.max(1,width-[...last].length-[...v].length))+v];
}
const center=(s,width)=>wrap(s,width).map(l=>' '.repeat(Math.max(0,Math.floor((width-[...l].length)/2)))+l);
const dash=(w,c='-')=>c.repeat(w);
function clampWidth(n){const v=Number(n);return Number.isInteger(v)&&v>=WIDTH.min&&v<=WIDTH.max?v:WIDTH.default;}
const STATUS={CONFIRMED:'CONFIRMADO',REOPENED:'EM CORRECAO'};
const DIFF_WORD=d=>d<0?'FALTA':d>0?'SOBRA':'CONFERIDO';
// report: the close as ReconciliationService returns it. options: {width, storeName, unit, header, footer, reprint:
// {by,at}|null, copy:'1/1'}. Returns the lines (array of strings, each at most `width` long).
function closingLines(report,options={}){
  const w=clampWidth(options.width);const L=[];const add=(...a)=>L.push(...a);
  const confirmed=stamp(report.confirmedAt),opened=stamp(report.openedAt),closed=stamp(report.closedAt);
  add(dash(w,'='),...center('LUMINOR PDV',w),...center('ACAI DA BARRA',w));
  if(options.storeName&&upper(options.storeName)!=='ACAI DA BARRA')add(...center(upper(options.storeName),w));
  add(...center('FECHAMENTO DE CAIXA - NAO FISCAL',w),dash(w,'='));
  if(options.reprint)add(...center('*** 2a VIA - REIMPRESSAO ***',w),...wrap(`Reimpresso por ${options.reprint.by||'-'} em ${stamp(options.reprint.at).date} ${stamp(options.reprint.at).time}`,w),dash(w));
  if(report.revision>1)add(...center('FECHAMENTO CORRIGIDO',w),...center(`REVISAO ${report.revision}`,w),...center(`SUBSTITUI A REVISAO ${report.revision-1}`,w),dash(w));
  if(report.superseded)add(...center(`*** SUBSTITUIDA PELA REVISAO ${report.supersededByRevision||report.revision+1} ***`,w),dash(w));
  if(options.unit)add(...pair('Unidade:',options.unit,w));
  add(...pair('Turno:',String(report.shiftId),w),...pair('Data:',closed.date!=='-'?closed.date:confirmed.date,w),...pair('Hora:',closed.time!=='-'?closed.time:confirmed.time,w));
  add(...pair('Aberto em:',`${opened.date} ${opened.time}`,w),...wrap(`Operador: ${report.confirmedBy.name||'-'}`,w),...pair('Revisao:',String(report.revision),w),...pair('Status:',STATUS[report.status]||report.status,w));
  if(options.header)add(dash(w),...center(String(options.header),w));
  add(dash(w),'CONFERENCIA FINANCEIRA',dash(w));
  for(const i of report.items){
    add(upper(ascii(i.label)));
    add(...pair('  Informado',cents(i.countedCents),w),...pair('  Sistema',cents(i.expectedCents),w),...pair(`  Diferenca (${DIFF_WORD(i.differenceCents)})`,signed(i.differenceCents),w));
  }
  add(dash(w),...pair('TOTAL INFORMADO',cents(report.totals.countedCents),w),...pair('TOTAL SISTEMA',cents(report.totals.expectedCents),w),...pair('DIFERENCA TOTAL',signed(report.totals.differenceCents),w),
    ...center(`(${DIFF_WORD(report.totals.differenceCents)})`,w),dash(w));
  add(...pair('Faturamento do turno',cents(report.totals.revenueCents),w),...pair('Vendas',String(report.totals.salesCount)+(report.totals.canceledCount?` (+${report.totals.canceledCount} canc.)`:''),w));
  add(dash(w),'MOVIMENTO DE DINHEIRO',dash(w),...pair('Fundo inicial',cents(report.cash.openingCents),w),...pair('Vendas dinheiro',cents(report.cash.cashSalesCents),w),
    ...pair('Suprimentos',cents(report.cash.suppliesCents),w),...pair('Sangrias',`-${cents(report.cash.withdrawalsCents)}`,w),...pair('Esperado gaveta',cents(report.cash.expectedCents),w));
  if(report.correctionReason)add(dash(w),...wrap(`Motivo da correcao: ${report.correctionReason}`,w));
  add(dash(w),...wrap(`Responsavel: ${report.confirmedBy.name||'-'}`,w),...wrap(`Confirmado em: ${confirmed.date} ${confirmed.time}`,w));
  if(options.footer)add(dash(w),...center(String(options.footer),w));
  add(dash(w),...center('DOCUMENTO GERENCIAL NAO FISCAL',w),dash(w,'='));
  return L;
}
function testLines(options={}){
  const w=clampWidth(options.width);const now=stamp(new Date().toISOString());
  return [dash(w,'='),...center('LUMINOR PDV',w),...center('TESTE DE IMPRESSAO',w),dash(w,'='),...wrap(`Impressora: ${options.printer||'-'}`,w),...pair('Data:',`${now.date} ${now.time}`,w),dash(w),
    'Acentos: Açaí Crédito Débito','Funcionária Diferença Ç ã é ê í õ ú',...pair('Valor:',cents(123456),w),...pair('Negativo:',signed(-800),w),dash(w),
    ...wrap('Confira a largura, as margens e os acentos. O texto deve caber de ponta a ponta sem cortes.',w),'1234567890'.repeat(8).slice(0,w),dash(w),...center('DOCUMENTO NAO FISCAL',w),dash(w,'=')];
}
const ESC=0x1b,GS=0x1d,LF=0x0a;
// The bytes for the printer. mode 'escpos': initializes, selects PC860, prints the lines, feeds and (only when asked)
// cuts. mode 'text': ASCII lines with CR LF and nothing else.
function toBytes(lines,{mode='escpos',cut=false,feed=4}={}){
  if(mode==='text')return Buffer.concat([...lines.map(l=>Buffer.concat([encodeText(l,{escpos:false}),Buffer.from('\r\n')])),Buffer.from('\r\n'.repeat(feed))]);
  const parts=[Buffer.from([ESC,0x40,ESC,0x74,0x03])];// initialize; code page 3 = PC860 (Portuguese)
  for(const l of lines)parts.push(encodeText(l),Buffer.from([LF]));
  parts.push(Buffer.from([ESC,0x64,feed]));// feed lines
  if(cut)parts.push(Buffer.from([GS,0x56,0x42,0x00]));// partial cut after a feed (GS V 66 0), only when the transport is known to support it
  return Buffer.concat(parts);
}
module.exports={closingLines,testLines,toBytes,encodeText,ascii,cents,signed,stamp,wrap,pair,CP860,WIDTH,clampWidth};
