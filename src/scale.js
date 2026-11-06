'use strict';
const {randomUUID}=require('node:crypto');
const {ENQ,Prt5Parser}=require('./protocol');

class ScaleDriver {
  // options.SerialPort and options.pollMs exist so tests can drive a fake serial port quickly.
  constructor(options={}) {
    this.SerialPort=options.SerialPort||null;this.pollMs=options.pollMs||500;
    this.port=null;this.timer=null;this.mode='offline';this.error='';
    this.state={status:'offline',grams:null,ready:false,armed:true,updatedAt:null,mode:'offline',lastError:''};
    // cycle names the current weighing (from one empty plate to the next): a cycle is captured at most once.
    this.armed=true;this.cycle=randomUUID();this.lastGrams=null;this.consistent=0;this.zeroCount=0;this.lastRead=0;
    this.onReady=()=>{};
  }
  snapshot(){
    const fresh=Date.now()-this.lastRead<1900;
    return {...this.state,ready:this.armed && fresh && this.state.status==='stable' && this.consistent>=3 && this.state.grams>0,armed:this.armed,mode:this.mode,lastError:this.error};
  }
  // The stable weight waiting to be captured, with its cycle id, without consuming it.
  peek(){const s=this.snapshot();return s.ready?{grams:s.grams,captureId:this.cycle}:null;}
  consume(){
    const s=this.snapshot();
    if(!s.ready) return null;
    this.armed=false; return s.grams;
  }
  // Nothing on the plate (stable zero) or no reading at all: the destination of the next weighing may change.
  idle(){const s=this.snapshot();return this.mode==='offline'||['offline','waiting','invalid'].includes(s.status)||(s.status==='stable'&&s.grams===0);}
  sample(frame) {
    this.lastRead=Date.now();this.state.updatedAt=new Date().toISOString();
    this.state.status=frame.status;this.state.grams=frame.grams;
    if(frame.status==='stable') {
      this.consistent=(this.lastGrams===frame.grams)?this.consistent+1:1;
      this.lastGrams=frame.grams;
      if(frame.grams===0){this.zeroCount++;if(this.zeroCount>=2&&!this.armed){this.armed=true;this.cycle=randomUUID();}}
      else this.zeroCount=0;
    } else {this.consistent=0;this.zeroCount=0;this.lastGrams=null;}
    if(this.snapshot().ready) this.onReady();
  }
  disconnect(){
    if(this.timer) clearInterval(this.timer);this.timer=null;
    const p=this.port;this.port=null;
    if(p && p.isOpen) try{p.close(()=>{});}catch(_){}
    // armed is kept: a cup already captured is not captured again when the connection comes back.
    this.mode='offline';this.consistent=0;this.zeroCount=0;
    this.state.status='offline';this.state.grams=null;this.state.updatedAt=null;this.lastRead=0;
  }
  demo(){
    this.disconnect();this.mode='demo';this.error='';
    this.sample({status:'stable',grams:0});this.sample({status:'stable',grams:0});
    return this.snapshot();
  }
  setDemoGrams(grams){
    if(this.mode!=='demo') throw Error('Ative o simulador antes.');
    if(!Number.isInteger(grams)||grams<0||grams>15000)throw Error('Peso inválido.');
    // Simulate device polling; stable only after 3 frames.
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
    const SerialPort=this.requirePort();
    const p=new SerialPort({path,baudRate:Number(baudRate),dataBits:8,stopBits:1,parity:'none',autoOpen:false});
    await new Promise((resolve,reject)=>p.open(err=>err?reject(err):resolve()));
    this.port=p;this.mode='serial';this.state.status='waiting';
    const parser=new Prt5Parser(frame=>{if(this.port===p)this.sample(frame);});
    p.on('data',bytes=>parser.push(bytes));
    p.on('error',e=>{if(this.port===p){this.disconnect();this.error=e.message;}});
    p.on('close',()=>{if(this.port===p){this.disconnect();this.error='Porta serial fechada';}});
    // Poll by ENQ, one request at a time, no passive frame invention.
    this.timer=setInterval(()=>{
      if(this.port===p && p.isOpen){
        if(Date.now()-this.lastRead>2000){this.state.status='waiting';this.state.grams=null;this.consistent=0;}
        p.write(ENQ,err=>{if(err)this.error=err.message;});
      }
    },this.pollMs);
    p.write(ENQ);
    return this.snapshot();
  }
}
module.exports={ScaleDriver};
