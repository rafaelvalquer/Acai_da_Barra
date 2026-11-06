'use strict';
// Chooses the adapter from the configuration (PDV_DATABASE_PROVIDER) and opens the store on it.
// The front end and the API stay the same whatever the provider.
const {SQLiteAdapter}=require('./adapters/SQLiteAdapter');const {PostgresAdapter}=require('./adapters/PostgresAdapter');
const {PdvStore}=require('../store');
async function createAdapter(config){
  if(config.provider==='sqlite')return SQLiteAdapter.open(config.sqlitePath);
  if(config.provider==='postgres')return PostgresAdapter.connect({connectionString:config.databaseUrl,caFile:config.databaseCaFile});
  // In-process PostgreSQL: tests and migration rehearsals only.
  if(config.provider==='pglite')return PostgresAdapter.pglite();
  throw Error(`Banco de dados desconhecido: ${config.provider}`);
}
async function createDatabase(config){return PdvStore.open(await createAdapter(config));}
module.exports={createDatabase,createAdapter};
