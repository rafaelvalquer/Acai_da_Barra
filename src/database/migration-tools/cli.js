'use strict';
// Moves the store's data from the local SQLite database to PostgreSQL (Supabase).
//
//   npm run migrar:postgres                      rehearsal: copies into a temporary PostgreSQL and reconciles
//   node src/database/migration-tools/cli.js --confirmar   copies into DATABASE_URL (must be empty) and reconciles
//   options: --origem <arquivo.sqlite>  --destino <DATABASE_URL>  --ca <certificado.pem>  --exportar <arquivo.json>
//
// The original SQLite file is only read (a copy is opened). Nothing changes in the PDV's configuration: the PDV keeps
// selling on this computer, and the Admin area (Banco de dados) turns on the cloud copy that keeps the cloud up to
// date from then on. The report is saved in logs/migracao-<data>.json.
const fs=require('node:fs'),path=require('node:path');
const {loadConfig,prepareHome}=require('../../config');const {PostgresAdapter}=require('../adapters/PostgresAdapter');
const {exportLocalData,openSqliteCopy}=require('./ExportLocalData');const {importToPostgres}=require('./ImportToPostgres');
const {validateMigration}=require('./ValidateMigration');const {stamp}=require('../../backup/clock');
function args(argv){const o={};for(let i=0;i<argv.length;i++){const a=argv[i];if(!a.startsWith('--'))continue;const k=a.slice(2);const v=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;o[k]=v;}return o;}
const mask=url=>{try{const u=new URL(url);if(u.password)u.password='****';return u.toString();}catch(_){return '(endereço inválido)';}};
async function migrate({source,databaseUrl,caFile,rehearsal,exportFile,tmpDir,log=console.log}){
  const local=await openSqliteCopy(source,tmpDir);let pg=null;
  try{
    log(`Lendo ${source} (cópia; o original não é alterado)…`);
    const data=await exportLocalData(local);
    if(exportFile){fs.writeFileSync(exportFile,JSON.stringify(data));log(`Exportação gravada em ${exportFile}.`);}
    log(`Registros: ${Object.entries(data.summary.counts).map(([t,n])=>`${t} ${n}`).join(', ')}.`);
    pg=rehearsal?await PostgresAdapter.pglite():await PostgresAdapter.connect({connectionString:databaseUrl,caFile});
    log(rehearsal?'Ensaio: PostgreSQL temporário, só para conferir.':`Destino: ${mask(databaseUrl)}`);
    await importToPostgres(pg,data,{onProgress:p=>log(`  ${p.table}: ${p.rows} registro(s) copiados`)});
    log('Conferindo tabela por tabela e os totais…');
    const report=await validateMigration(local,pg);
    return {...report,rehearsal,source,target:rehearsal?'pglite':mask(databaseUrl)};
  }finally{await local.close();if(pg)await pg.close();}
}
async function main(){
  const o=args(process.argv.slice(2));const config=loadConfig();prepareHome(config);
  const rehearsal=!o.confirmar;const databaseUrl=o.destino===true?null:(o.destino||config.databaseUrl);
  if(!rehearsal&&!databaseUrl)throw Error('Informe o banco de destino: --destino <DATABASE_URL> ou DATABASE_URL em config/luminor-pdv.env.');
  const report=await migrate({source:path.resolve(o.origem||config.sqlitePath),databaseUrl,caFile:o.ca||config.databaseCaFile,rehearsal,
    exportFile:typeof o.exportar==='string'?o.exportar:null,tmpDir:config.paths.tmp});
  const file=path.join(config.paths.logs,`migracao-${stamp(new Date())}.json`);fs.writeFileSync(file,JSON.stringify(report,null,2));
  for(const t of report.tables)console.log(`${t.ok?'OK  ':'ERRO'} ${t.table.padEnd(18)} origem ${String(t.source).padStart(6)}  destino ${String(t.target).padStart(6)}${t.difference?'  '+JSON.stringify(t.difference):''}`);
  for(const t of report.totals.filter(t=>!t.ok))console.log(`ERRO total ${t.item}: origem ${t.source}, destino ${t.target}`);
  console.log(report.ok?`\nConciliação OK${rehearsal?' (ensaio). Para copiar de verdade: node src/database/migration-tools/cli.js --confirmar':'. Para manter a nuvem em dia sozinha, ative a cópia em Configurações › Administração do sistema › Banco de dados.'}`:'\nA conciliação encontrou diferenças. Não troque o banco do PDV.');
  console.log(`Relatório: ${file}`);
  process.exit(report.ok?0:1);
}
if(require.main===module)main().catch(e=>{console.error(`Migração interrompida: ${e.message}`);process.exit(1);});
module.exports={migrate};
