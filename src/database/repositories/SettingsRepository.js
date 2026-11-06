'use strict';
class SettingsRepository {
  constructor(q){this.q=q;}
  async get(k){const r=await this.q.get('SELECT v FROM settings WHERE k=?',[k]);return r?r.v:null;}
  async set(k,v){await this.q.run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',[k,String(v)]);}
  async ensure(k,v){await this.q.run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING',[k,String(v)]);}
}
module.exports={SettingsRepository};
