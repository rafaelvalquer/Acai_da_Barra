'use strict';
// Simulated Toledo Prix 3 Fit (Prt5) on a serial port, with latency. What is on the plate changes on its own clock,
// never on the PDV's polling: the PDV only sees the state the plate has at the moment each ENQ arrives.
const {EventEmitter}=require('node:events');
const frame=payload=>Buffer.from([0x02,...Buffer.from(payload,'ascii'),0x03]);
const weightText=g=>String(g).padStart(5,'0');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// latencyMs: from the ENQ to the answer. settleMs: how long the scale says "unstable" after the plate changes.
// faults.delay(n)/drop(n)/fragment(n): per request number (n starts at 1).
function scaleSimulator({latencyMs=35,settleMs=0,faults={}}={}){
  const sim={reading:'00000',latencyMs,settleMs,faults,enq:0,opens:0,port:null,openError:null,changedAt:Date.now(),timer:null,
    set(payload){clearTimeout(sim.timer);sim.reading=payload;sim.changedAt=Date.now();},
    // The plate changes now; the stable value appears after the scale settles. Returns when it is stable.
    async change(payload,settle=sim.settleMs){
      if(!settle){sim.set(payload);return Date.now();}
      sim.set('IIIII');
      await new Promise(r=>{sim.timer=setTimeout(r,settle);});
      sim.set(payload);return Date.now();
    },
    place(grams,settle){return sim.change(weightText(grams),settle);},
    remove(settle){return sim.change('00000',settle);},
    // The cable or the converter drops, and later answers again.
    unplug(){const p=sim.port;sim.openError='Porta indisponível';if(p){p.isOpen=false;p.emit('close');}},
    plug(){sim.openError=null;}
  };
  class SerialPort extends EventEmitter{
    constructor(options){super();this.options=options;this.isOpen=false;}
    open(cb){if(sim.openError)return cb(Error(sim.openError));this.isOpen=true;sim.port=this;sim.opens++;cb();}
    close(cb){this.isOpen=false;if(cb)cb();}
    write(bytes,cb){
      if(bytes[0]===0x05&&this.isOpen){
        const n=++sim.enq,f=sim.faults,answer=frame(sim.reading);
        if(!f.drop?.(n)){
          setTimeout(()=>{
            if(!this.isOpen)return;
            if(!f.fragment?.(n))return this.emit('data',answer);
            this.emit('data',answer.subarray(0,2));
            setTimeout(()=>{this.emit('data',answer.subarray(2,5));setTimeout(()=>this.emit('data',answer.subarray(5)),3);},3);
          },sim.latencyMs+(f.delay?.(n)||0));
        }
      }
      if(cb)cb();
    }
    static list(){return Promise.resolve([{path:'COM9',manufacturer:'Simulada'}]);}
  }
  sim.SerialPort=SerialPort;return sim;
}
module.exports={scaleSimulator,frame,weightText,wait};
