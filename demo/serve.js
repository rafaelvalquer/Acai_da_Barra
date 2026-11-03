'use strict';
// Serves dist/ locally with the same headers Netlify applies (dist/_headers), to check the demo before publishing.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'dist'),PORT=Number(process.env.PORT||4173);
const headers={};
for(const [,k,v] of fs.readFileSync(path.join(OUT,'_headers'),'utf8').matchAll(/^\s+([A-Za-z-]+):\s*(.+)$/gm))headers[k]=v.trim();
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.wasm':'application/wasm','.sqlite':'application/octet-stream'};
http.createServer((req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.join(OUT,name.endsWith('/')?name+'index.html':name);
  if(!file.startsWith(OUT+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404,headers);return res.end('Não encontrado');}
  res.writeHead(200,{...headers,'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
  fs.createReadStream(file).pipe(res);
}).listen(PORT,'127.0.0.1',()=>console.log(`Demonstração em http://127.0.0.1:${PORT}`));
