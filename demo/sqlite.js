'use strict';
// Browser stand-in for node:sqlite's DatabaseSync, backed by sql.js (SQLite compiled to WebAssembly).
// Statements are prepared per call: sql.js frees every open statement when the database is exported.
function createDatabaseSync(SQL){
  const bind=params=>params.map(v=>v===undefined?null:v);
  class DatabaseSync {
    // The file name is ignored; the bytes to open (saved demo or seed) are handed over through `load`.
    constructor(){this.raw=new SQL.Database(DatabaseSync.load||undefined);DatabaseSync.load=null;}
    exec(sql){this.raw.exec(sql);}
    prepare(sql){
      const raw=this.raw;
      const rows=(params,limit)=>{const st=raw.prepare(sql);try{st.bind(bind(params));const out=[];while((limit===undefined||out.length<limit)&&st.step())out.push(st.getAsObject());return out;}finally{st.free();}};
      return {
        run:(...params)=>{raw.run(sql,bind(params));return {changes:raw.getRowsModified(),lastInsertRowid:raw.exec('SELECT last_insert_rowid()')[0].values[0][0]};},
        get:(...params)=>rows(params,1)[0],
        all:(...params)=>rows(params)
      };
    }
    // Exporting reopens the database, which resets connection pragmas.
    export(){const bytes=this.raw.export();this.raw.exec('PRAGMA foreign_keys=ON');return bytes;}
    close(){this.raw.close();}
  }
  DatabaseSync.load=null;
  return DatabaseSync;
}
