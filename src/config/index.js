'use strict';
// Where the PDV keeps its data and how it reads its settings. Everything the store produces lives in one permanent
// folder outside the program (C:\ProgramData\LuminorPDV on Windows), so updating or reinstalling the program never
// touches sales, backups or settings:
//   data/     the database (luminor-pdv.sqlite)       backups/  automatic, manual and safety backups
//   logs/     server log and startup errors            config/   luminor-pdv.env, hardware.json, backup key
// Settings come from environment variables first, then from config/luminor-pdv.env (KEY=VALUE lines).
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const PACKAGE=require('../../package.json');
const KEYS=['PDV_HOME','PDV_DATABASE_PROVIDER','PDV_SQLITE_PATH','PDV_BACKUP_ENABLED','PDV_BACKUP_TIME','PDV_BACKUP_RETENTION_DAYS',
  'DATABASE_URL','PDV_DATABASE_CA_FILE','PDV_LEGACY_SQLITE','PORT','LUMINOR_TIMEZONE','PDV_VAULT'];
function defaultHome(){
  if(process.platform==='win32')return path.join(process.env.ProgramData||'C:\\ProgramData','LuminorPDV');
  return path.join(os.homedir(),'.luminor-pdv');
}
// KEY=VALUE per line; # starts a comment; values may be quoted. Unknown keys are ignored.
function parseEnvFile(text){
  const out={};
  for(const raw of String(text).split(/\r?\n/)){
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const eq=line.indexOf('=');if(eq<1)continue;
    const key=line.slice(0,eq).trim();let value=line.slice(eq+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    if(KEYS.includes(key))out[key]=value;
  }
  return out;
}
const flag=(v,fallback)=>v===undefined||v===''?fallback:/^(1|true|sim|yes|on)$/i.test(String(v).trim());
function checkTime(v){
  const m=/^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v||'').trim());
  if(!m)throw Error(`PDV_BACKUP_TIME inválido: "${v}". Use o formato HH:MM, por exemplo 02:00.`);
  return `${m[1].padStart(2,'0')}:${m[2]}`;
}
function homePaths(home){
  return {home,data:path.join(home,'data'),backups:path.join(home,'backups'),logs:path.join(home,'logs'),config:path.join(home,'config'),tmp:path.join(home,'tmp')};
}
function loadConfig(env=process.env){
  // LUMINOR_DATA_DIR is the folder name used up to v0.1; it still works as the home folder.
  const explicitHome=env.PDV_HOME||env.LUMINOR_DATA_DIR;
  const home=path.resolve(explicitHome||defaultHome());const paths=homePaths(home);
  const envFile=path.join(paths.config,'luminor-pdv.env');
  let file={};try{file=parseEnvFile(fs.readFileSync(envFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const get=k=>env[k]!==undefined&&env[k]!==''?env[k]:file[k];
  const provider=String(get('PDV_DATABASE_PROVIDER')||'sqlite').toLowerCase();
  if(!['sqlite','postgres'].includes(provider))throw Error(`PDV_DATABASE_PROVIDER inválido: "${provider}". Use sqlite ou postgres.`);
  const databaseUrl=get('DATABASE_URL')||null;
  if(provider==='postgres'&&!databaseUrl)throw Error('Com PDV_DATABASE_PROVIDER=postgres, informe DATABASE_URL no arquivo de configuração.');
  const daily=Number(get('PDV_BACKUP_RETENTION_DAYS')||7);
  if(!Number.isInteger(daily)||daily<1||daily>90)throw Error('PDV_BACKUP_RETENTION_DAYS deve ser um número inteiro de 1 a 90.');
  const port=Number(get('PORT')||3187);
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('PORT inválida.');
  // A database from before the permanent folder existed is copied in once (never moved or changed). With the
  // default home that is the program's own data/ folder; with LUMINOR_DATA_DIR, the file directly inside it.
  const legacy=get('PDV_LEGACY_SQLITE')||(env.PDV_HOME?null:env.LUMINOR_DATA_DIR?path.join(home,'luminor-pdv.sqlite'):path.resolve(__dirname,'../../data/luminor-pdv.sqlite'));
  if(get('LUMINOR_TIMEZONE')&&!process.env.LUMINOR_TIMEZONE)process.env.LUMINOR_TIMEZONE=get('LUMINOR_TIMEZONE');
  return {
    version:PACKAGE.version,home,paths,envFile,port,provider,
    sqlitePath:path.resolve(get('PDV_SQLITE_PATH')||path.join(paths.data,'luminor-pdv.sqlite')),
    databaseUrl,databaseCaFile:get('PDV_DATABASE_CA_FILE')||null,
    legacySqlite:legacy?path.resolve(legacy):null,
    // Administrator accounts and protected settings: apart from the commercial database, never inside a backup of it.
    adminDbPath:path.join(paths.config,'admin.sqlite'),vaultFile:path.join(paths.config,'cofre.dat'),
    vault:String(get('PDV_VAULT')||(process.platform==='win32'?'dpapi':'arquivo')).toLowerCase(),
    backup:{enabled:flag(get('PDV_BACKUP_ENABLED'),true),time:checkTime(get('PDV_BACKUP_TIME')||'02:00'),retention:{daily,weekly:4,monthly:3}}
  };
}
// Creates the folders and, on first start, a commented settings file with the defaults.
function prepareHome(config){
  for(const dir of Object.values(config.paths))fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(config.envFile))fs.writeFileSync(config.envFile,[
    '# Configuração do Luminor PDV. Linhas com # são comentários. Reinicie o PDV depois de alterar.',
    '# O banco de dados é escolhido em Configurações > Administração do sistema. As linhas abaixo só valem',
    '# enquanto nada foi escolhido lá: sqlite (neste computador) ou postgres (Supabase).',
    'PDV_DATABASE_PROVIDER=sqlite','# PDV_SQLITE_PATH=',
    '# Backup automático diário: horário (HH:MM) e quantos dias manter.',
    'PDV_BACKUP_ENABLED=true','PDV_BACKUP_TIME=02:00','PDV_BACKUP_RETENTION_DAYS=7',
    '# Só para PostgreSQL/Supabase. Prefira cadastrar pela tela de administração: lá a senha fica no cofre do Windows.',
    '# DATABASE_URL=postgres://usuario:senha@servidor:5432/postgres','# PDV_DATABASE_CA_FILE=',''].join('\r\n'),{flag:'wx'});
}
// Masks the password of a database address before it is shown or logged.
function describeDatabase(config){
  if(config.provider==='sqlite')return {provider:'sqlite',label:'Local (SQLite)',location:config.sqlitePath};
  let host='';try{const u=new URL(config.databaseUrl);host=`${u.hostname}${u.port?':'+u.port:''}${u.pathname}`;}catch(_){}
  return {provider:'postgres',label:'PostgreSQL',location:host};
}
module.exports={loadConfig,prepareHome,parseEnvFile,describeDatabase,homePaths,defaultHome};
