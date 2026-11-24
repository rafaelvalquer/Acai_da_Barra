'use strict';
const {randomUUID}=require('node:crypto');
const {ENQ,Prt5Parser}=require('./protocol');

// Timing of the serial reading. The values the store runs with; src/config can change them (PDV_SCALE_*).
//   pollMs: interval between ENQs. At 2400 baud the ENQ and its 7 byte answer take about 33 ms on the wire.
//   timeoutMs: an ENQ without an answer for this long is given up and another is sent.
//   stableReadings: equal readings the scale itself reports as stable, each from its own ENQ, to accept a weight.
//   emptyReadings: stable readings of the empty plate (zero, residue or below zero) that free the next weighing. One
//     is enough: the scale only reports a stable zero after the plate really stayed empty.
const DEFAULTS=Object.freeze({pollMs:150,timeoutMs:600,stableReadings:2,emptyReadings:1,emptyGrams:10,reconnectMs:[1000,2000,5000]});
const FRESH_MS=1900,STALE_MS=2000,EVENTS=200,SAMPLES=500;
const percentile=(sorted,p)=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(p/100*sorted.length)-1)]:null;
function summary(list){
  const s=[...list].sort((a,b)=>a-b);if(!s.length)return {count:0};
  return {count:s.length,avgMs:Math.round(s.reduce((t,x)=>t+x,0)/s.length),medianMs:percentile(s,50),p95Ms:percentile(s,95),p99Ms:percentile(s,99),maxMs:s[s.length-1]};
}

// The physical weighing cycle of the plate. It knows nothing about the database: a weighing is offered (peek), taken
// (consume) and the next one is freed by the empty plate, whatever happens to the one taken before.
//   OFFLINE → WAITING_PRODUCT → STABILIZING → READY → (taken) WAITING_REMOVAL → (empty plate) WAITING_PRODUCT
class ScaleDriver {
  // options.SerialPort and the timing options exist so tests can drive a fake serial port.
  constructor(options={}) {
    this.SerialPort=options.SerialPort||null;
    const o=this.options={...DEFAULTS};for(const k of Object.keys(DEFAULTS))if(options[k]!==undefined&&options[k]!==null)o[k]=options[k];
    this.pollMs=o.pollMs;
    // A stable reading up to emptyGrams is the empty plate (the residue the scale shows with nothing on it, 0,004 kg
    // on the store's unit): it counts as zero, so it is never sold and it frees the next weighing.
    this.emptyGrams=o.emptyGrams;
    this.port=null;this.timer=null;this.retry=null;this.outstanding=null;this.target=null;this.generation=0;this.mode='offline';this.error='';
    this.state={status:'offline',grams:null,ready:false,armed:true,updatedAt:null,mode:'offline',lastError:''};
    // cycle names the current weighing (from one empty plate to the next): a cycle is captured at most once. used:
    // there was a product in this cycle, so the next empty plate starts another one.
    this.armed=true;this.cycle=randomUUID();this.used=false;this.lastGrams=null;this.consistent=0;this.zeroCount=0;this.lastRead=0;this.seq=0;
    // Technical diagnostic: the latest events and counters, in memory. onEvent receives every one (the log file).
    this.events=[];this.counters={enq:0,frames:0,timeouts:0,unsolicited:0,rearms:0,reconnects:0,writeErrors:0};this.serialMs=[];this.lastFrame=null;this.lastPhase='OFFLINE';
    this.onEvent=null;this.onReady=()=>{};
  }
  // ring false: too frequent to keep in memory (only for the log file).
  trace(type,data={},{ring=true}={}){
    const e={at:new Date().toISOString(),type,...data};
    if(ring){this.events.push(e);if(this.events.length>EVENTS)this.events.shift();}
    if(this.onEvent)try{this.onEvent(e);}catch(_){}
  }
  fresh(){return Date.now()-this.lastRead<FRESH_MS;}
  isReady(){return this.armed&&this.fresh()&&this.state.status==='stable'&&this.consistent>=this.options.stableReadings&&this.state.grams>0;}
  phase(){
    if(this.mode==='offline')return 'OFFLINE';
    const {status,grams}=this.state;
    if(this.isReady())return 'READY';
    if(!this.armed&&!(status==='stable'&&grams===0))return 'WAITING_REMOVAL';
    if(status==='unstable'||(status==='stable'&&grams>0))return 'STABILIZING';
    return 'WAITING_PRODUCT';
  }
  snapshot(){
    return {...this.state,ready:this.isReady(),armed:this.armed,mode:this.mode,lastError:this.error,phase:this.phase(),seq:this.seq};
  }
  // Why the plate is not offering a weighing now (diagnostic screen).
  blockReason(){
    const {status,grams}=this.state;
    if(this.mode==='offline')return 'Balança desconectada';
    if(this.isReady())return null;
    if(!this.lastRead||!this.fresh()||status==='waiting')return 'Sem resposta recente da balança';
    if(!this.armed&&!(status==='stable'&&grams===0))return 'Peso já lançado: aguardando o prato ficar vazio';
    if(status!=='stable')return {unstable:'Peso instável',negative:'Peso negativo (prato vazio com tara)',overload:'Sobrecarga',invalid:'Leitura inválida'}[status]||status;
    if(grams===0)return 'Prato vazio';
    return `Confirmando o peso (${this.consistent} de ${this.options.stableReadings} leituras)`;
  }
  // The stable weight waiting to be captured, with its cycle id, without consuming it.
  peek(){return this.isReady()?{grams:this.state.grams,captureId:this.cycle}:null;}
  // Takes the weighing of a cycle, so it is not offered again. With captureId, only that cycle: when the cup was
  // already removed (another cycle is on the plate now) nothing changes and the next weighing is never lost.
  // Without it, takes whatever is ready and returns its grams.
  consume(captureId){
    if(captureId!==undefined){
      if(captureId!==this.cycle||!this.armed)return false;
      this.armed=false;this.seq++;this.trace('pesagem_reservada',{captureId,grams:this.state.grams});this.transition();return true;
    }
    if(!this.isReady())return null;
    const grams=this.state.grams;this.consume(this.cycle);return grams;
  }
  // A weight typed by hand stands for what is (or may be) on the plate: it is not captured again until the plate is
  // seen empty. With the plate already seen empty nothing changes. Returns how to undo it (the typing was refused).
  hold(){
    const {status,grams}=this.state;
    if(!this.armed||(this.mode!=='offline'&&(status==='negative'||(status==='stable'&&grams===0))))return ()=>{};
    const cycle=this.cycle;this.armed=false;this.seq++;this.trace('retido_por_lancamento_manual',{captureId:cycle});this.transition();
    return ()=>{if(this.cycle===cycle){this.armed=true;this.seq++;}};
  }
  // Nothing on the plate (stable zero) or no reading at all: the destination of the next weighing may change.
  idle(){const s=this.snapshot();return this.mode==='offline'||['offline','waiting','invalid','negative'].includes(s.status)||(s.status==='stable'&&s.grams===0);}
  transition(){
    const phase=this.phase();
    if(phase!==this.lastPhase){this.trace('estado',{de:this.lastPhase,para:phase,captureId:this.cycle});this.lastPhase=phase;}
  }
  sample(frame,raw) {
    if(frame.status==='stable'&&frame.grams<=this.emptyGrams)frame={...frame,grams:0};
    this.lastRead=Date.now();this.state.updatedAt=new Date().toISOString();this.seq++;
    this.state.status=frame.status;this.state.grams=frame.grams;
    if(frame.status==='stable') {
      this.consistent=(this.lastGrams===frame.grams)?this.consistent+1:1;
      this.lastGrams=frame.grams;
      if(frame.grams===0)this.emptySeen();else{this.zeroCount=0;this.used=true;}
    } else {
      this.consistent=0;this.lastGrams=null;
      // Below zero is the empty plate too: with a tare set on the scale (the cup), taking the cup away reads negative.
      if(frame.status==='negative')this.emptySeen();else this.zeroCount=0;
    }
    const key=`${raw??''}|${frame.status}|${frame.grams}`;
    this.trace('leitura',{frame:raw,status:frame.status,grams:frame.grams,estaveis:this.consistent,vazios:this.zeroCount,armed:this.armed},{ring:key!==this.lastFrame});
    this.lastFrame=key;this.transition();
    if(this.isReady()) this.onReady();
  }
  // The empty plate frees the next weighing, with a new cycle id.
  emptySeen(){
    this.zeroCount++;
    if(this.zeroCount<this.options.emptyReadings||(this.armed&&!this.used))return;
    this.armed=true;this.used=false;this.cycle=randomUUID();this.counters.rearms++;this.trace('rearmado',{captureId:this.cycle});
  }
  // Closes the port and forgets the readings. armed is kept: a cup already captured is not captured again when the
  // connection comes back.
  drop(){
    this.generation++;this.outstanding=null;
    if(this.timer) clearTimeout(this.timer);this.timer=null;
    const p=this.port;this.port=null;
    if(p && p.isOpen) try{p.close(()=>{});}catch(_){}
    this.mode='offline';this.consistent=0;this.zeroCount=0;this.lastGrams=null;
    this.state.status='offline';this.state.grams=null;this.state.updatedAt=null;this.lastRead=0;this.seq++;
    this.transition();
  }
  // Disconnected on purpose: no automatic reconnection.
  disconnect(){
    if(this.retry) clearTimeout(this.retry);this.retry=null;this.target=null;
    this.drop();
  }
  // The port fell by itself (cable, converter, Windows): the same port is tried again until it answers or someone
  // disconnects or connects.
  lost(message){
    this.drop();this.error=message;this.trace('conexao_perdida',{erro:message});
    this.reconnect(0);
  }
  reconnect(attempt){
    const target=this.target,delays=this.options.reconnectMs;
    if(!target||!delays.length)return;
    if(this.retry) clearTimeout(this.retry);
    this.retry=setTimeout(async()=>{
      this.retry=null;if(this.target!==target)return;
      try{await this.open(target);this.counters.reconnects++;this.trace('reconectada',{porta:target.path});}
      catch(_){if(this.target===target&&!this.port)this.reconnect(attempt+1);}
    },delays[Math.min(attempt,delays.length-1)]);
    this.retry.unref?.();
  }
  demo(){
    this.disconnect();this.mode='demo';this.error='';
    this.sample({status:'stable',grams:0});this.sample({status:'stable',grams:0});
    return this.snapshot();
  }
  setDemoGrams(grams){
    if(this.mode!=='demo') throw Error('Ative o simulador antes.');
    if(!Number.isInteger(grams)||grams<0||grams>15000)throw Error('Peso inválido.');
    // Simulate device polling: the same stable value read a few times.
    this.sample({status:'stable',grams});this.sample({status:'stable',grams});this.sample({status:'stable',grams});
    return this.snapshot();
  }
  async ports(){
    const SerialPort=this.requirePort();
    return SerialPort.list();
  }
  requirePort(){
    if(this.SerialPort) return this.SerialPort;
    try {return require('serialport').SerialPort;} catch(_){throw Error('Módulo de comunicação serial indisponível. Execute npm install antes de conectar a balança.');}
  }
  async connect(path,baudRate=2400){
    if(!/^\d{2,6}$/.test(String(baudRate))||+baudRate<1200||+baudRate>115200) throw Error('Velocidade serial inválida');
    if(!path || !/^[a-zA-Z0-9_./\\:-]{1,160}$/.test(path)) throw Error('Porta serial inválida');
    this.disconnect();this.error='';
    const target={path,baudRate:Number(baudRate)};this.target=target;
    try{await this.open(target);}catch(e){if(this.target===target)this.target=null;throw e;}
    return this.snapshot();
  }
  async open({path,baudRate}){
    const SerialPort=this.requirePort();
    const p=new SerialPort({path,baudRate,dataBits:8,stopBits:1,parity:'none',autoOpen:false});
    const generation=this.generation;
    await new Promise((resolve,reject)=>p.open(err=>err?reject(err):resolve()));
    // Disconnected or connected elsewhere while the port was opening.
    if(generation!==this.generation){try{p.close(()=>{});}catch(_){}return;}
    this.port=p;this.mode='serial';this.error='';this.state.status='waiting';this.seq++;
    const parser=new Prt5Parser((frame,raw)=>this.received(p,frame,raw));
    p.on('data',bytes=>parser.push(bytes));
    p.on('error',e=>{if(this.port===p)this.lost(e.message);});
    p.on('close',()=>{if(this.port===p)this.lost('Porta serial fechada');});
    this.trace('conectada',{porta:path,velocidade:baudRate,pollMs:this.pollMs});this.transition();
    this.request(p);
  }
  // Poll by ENQ, one request at a time: the next one only after the answer (or the timeout), so requests never pile
  // up on a slow scale and each confirmation comes from a different request. No passive frame invention.
  request(p){
    if(this.port!==p||!p.isOpen)return;
    if(Date.now()-this.lastRead>STALE_MS&&this.state.status!=='waiting'){this.state.status='waiting';this.state.grams=null;this.consistent=0;this.lastGrams=null;this.seq++;this.transition();}
    this.outstanding={at:Date.now()};this.counters.enq++;this.trace('enq',{},{ring:false});
    this.timer=setTimeout(()=>{
      if(this.port!==p||!this.outstanding)return;
      this.outstanding=null;this.counters.timeouts++;this.trace('tempo_esgotado',{ms:this.options.timeoutMs});
      this.request(p);
    },this.options.timeoutMs);
    p.write(ENQ,err=>{if(err&&this.port===p){this.error=err.message;this.counters.writeErrors++;this.trace('falha_escrita',{erro:err.message});}});
  }
  // An answer after its timeout is taken as the answer of the request now waiting; one with no request waiting (a
  // second frame, noise) is ignored and never counts as a confirmation.
  received(p,frame,raw){
    if(this.port!==p)return;
    const waiting=this.outstanding;
    if(!waiting){this.counters.unsolicited++;this.trace('quadro_sem_pedido',{frame:raw},{ring:false});return;}
    this.outstanding=null;clearTimeout(this.timer);this.timer=null;
    const ms=Date.now()-waiting.at;this.counters.frames++;this.serialMs.push(ms);if(this.serialMs.length>SAMPLES)this.serialMs.shift();
    this.trace('resposta',{ms},{ring:false});
    try{this.sample(frame,raw);}
    finally{if(this.port===p&&!this.outstanding&&!this.timer)this.timer=setTimeout(()=>{this.timer=null;this.request(p);},Math.max(0,this.pollMs-(Date.now()-waiting.at)));}
  }
  diagnostics(){
    const {pollMs,timeoutMs,stableReadings,emptyReadings,emptyGrams}=this.options;
    return {config:{pollMs,timeoutMs,stableReadings,emptyReadings,emptyGrams},
      state:{...this.snapshot(),consistent:this.consistent,zeroCount:this.zeroCount,captureId:this.cycle,blockReason:this.blockReason()},
      counters:{...this.counters},serial:summary(this.serialMs),events:this.events.slice().reverse()};
  }
}
module.exports={ScaleDriver,DEFAULTS,summary};
