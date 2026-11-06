'use strict';
// First start after the permanent data folder was introduced: copies the database the PDV used before
// (the program's own data/luminor-pdv.sqlite) into the permanent folder. The old file is only read, never changed or
// moved, so it stays as a fallback. The copy is checked before it is put in place; if anything fails, nothing is
// put in place and the PDV starts with an empty database next to the untouched original.
const fs=require('node:fs'),path=require('node:path');
const {SQLiteAdapter}=require('./adapters/SQLiteAdapter');
async function importLegacySqlite({source,target,tmpDir,log=console}){
  if(!source||fs.existsSync(target)||!fs.existsSync(source))return null;
  if(path.resolve(source)===path.resolve(target))return null;
  const stage=fs.mkdtempSync(path.join(tmpDir,'importacao-'));const copy=path.join(stage,'luminor-pdv.sqlite');
  try{
    fs.copyFileSync(source,copy);
    // Changes not yet folded into the main file live in the -wal file; the copy needs it too.
    if(fs.existsSync(source+'-wal'))fs.copyFileSync(source+'-wal',copy+'-wal');
    const adapter=SQLiteAdapter.open(copy);
    try{
      const check=await adapter.get('PRAGMA integrity_check');
      if(Object.values(check||{})[0]!=='ok')throw Error('o banco antigo não passou na verificação de integridade');
      await adapter.checkpoint();
      await adapter.exec('PRAGMA journal_mode=DELETE');
    }finally{await adapter.close();}
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.renameSync(copy,target);
    const bytes=fs.statSync(target).size;
    log.info?.(`Banco anterior copiado de ${source} para ${target} (${bytes} bytes). O arquivo original não foi alterado.`);
    return {source,target,bytes,at:new Date().toISOString()};
  }catch(e){
    log.error?.(`Não foi possível copiar o banco anterior (${source}): ${e.message}`);
    return {source,error:e.message};
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
module.exports={importLegacySqlite};
