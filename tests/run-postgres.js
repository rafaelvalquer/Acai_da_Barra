'use strict';
// npm run test:postgres — the same business tests on PostgreSQL (PGlite, PostgreSQL running inside the test process).
const {spawnSync}=require('node:child_process');const fs=require('node:fs'),path=require('node:path');
const files=fs.readdirSync(__dirname).filter(f=>f.endsWith('.test.js')).map(f=>path.join(__dirname,f));
const r=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env:{...process.env,PDV_TEST_DB:'pglite'}});
process.exit(r.status??1);
