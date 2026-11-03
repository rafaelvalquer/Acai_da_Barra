'use strict';
// Builds dist/: the PDV front end plus an in-browser copy of its server, for static hosting (Netlify).
// The store keeps running `npm start`; nothing here changes src/ or public/.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {seed}=require('./seed');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'dist'),SQLJS=path.join(ROOT,'node_modules','sql.js','dist');
const read=file=>fs.readFileSync(file,'utf8');

fs.rmSync(OUT,{recursive:true,force:true});
fs.cpSync(path.join(ROOT,'public'),OUT,{recursive:true});
fs.mkdirSync(path.join(OUT,'vendor'));
for(const file of ['sql-wasm-browser.js','sql-wasm-browser.wasm'])fs.copyFileSync(path.join(SQLJS,file),path.join(OUT,'vendor',file));
for(const file of ['demo.css','_headers'])fs.copyFileSync(path.join(__dirname,file),path.join(OUT,file));

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'luminor-demo-'));
const seedDay=seed(path.join(tmp,'seed.sqlite'));
fs.copyFileSync(path.join(tmp,'seed.sqlite'),path.join(OUT,'demo-seed.sqlite'));
fs.rmSync(tmp,{recursive:true,force:true});

// The server modules run unchanged; Node built-ins are swapped for browser versions in backend.js.
const sources=['protocol','db','scale','server'].map(name=>`'./${name}':function(module,exports,require,__dirname){${read(path.join(ROOT,'src',name+'.js'))}\n}`).join(',\n');
fs.writeFileSync(path.join(OUT,'demo.js'),`(()=>{'use strict';
const process={env:{}};
const Buffer={from:a=>{const u=Uint8Array.from(a);u.toString=()=>String.fromCharCode(...u);return u;}};
${read(path.join(__dirname,'sqlite.js'))}
const sources={${sources}};
function makeRequire(builtins){
  const cache={};
  const require=name=>{
    if(name in builtins)return builtins[name];if(cache[name])return cache[name].exports;
    if(!sources[name])throw Error('Módulo indisponível na demonstração: '+name);
    const module={exports:{}};cache[name]=module;sources[name](module,module.exports,require,'/src');return module.exports;
  };
  require.main=null;return require;
}
${read(path.join(__dirname,'backend.js'))}
})();
`);

let html=read(path.join(OUT,'index.html'));
const swap=(marker,replacement)=>{if(!html.includes(marker))throw Error(`index.html mudou: trecho não encontrado: ${marker}`);html=html.replace(marker,replacement);};
swap('<title>Luminor PDV — Açaí da Barra</title>','<title>Luminor PDV — Açaí da Barra · Demonstração</title><meta name="robots" content="noindex"/>');
swap('<link rel="stylesheet" href="/style.css"/>','<link rel="stylesheet" href="/style.css"/><link rel="stylesheet" href="/demo.css"/>');
swap('<header class="topbar">',`<div class="demo-bar" role="note"><span class="demo-tag">Demonstração</span><span class="demo-text">Balança simulada e dados de exemplo, guardados só neste navegador.</span><button type="button" class="demo-reset" id="demo-reset"><svg class="i" aria-hidden="true"><use href="#i-refresh"/></svg>Restaurar exemplo</button></div>
<header class="topbar">`);
swap('Lançar automaticamente quando o peso estabilizar</label>',`Lançar automaticamente quando o peso estabilizar</label>
    <div class="demo-scale"><span class="demo-scale-label"><svg class="i" aria-hidden="true"><use href="#i-scale"/></svg>Simular balança</span><div class="demo-scale-buttons"><button type="button" data-grams="320">320 g</button><button type="button" data-grams="486">486 g</button><button type="button" data-grams="750">750 g</button><button type="button" class="demo-scale-zero" data-grams="0">Tirar o copo · 0 g</button></div></div>`);
swap('<script src="/app.js" defer></script>','<script src="/vendor/sql-wasm-browser.js" defer></script><script src="/demo.js" defer></script><script src="/app.js" defer></script>');
fs.writeFileSync(path.join(OUT,'index.html'),html);

const size=fs.readdirSync(OUT,{recursive:true}).map(f=>path.join(OUT,f)).filter(f=>fs.statSync(f).isFile()).reduce((s,f)=>s+fs.statSync(f).size,0);
console.log(`Demonstração gerada em dist/ (${(size/1024).toFixed(0)} KB, dados de exemplo até ${seedDay}).`);
