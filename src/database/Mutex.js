'use strict';
// Runs one operation at a time, in arrival order. The store has a single cash register, so every read and write
// of the PDV goes through here: a check and the write that depends on it can never interleave with another request.
class Mutex {
  constructor(){this.tail=Promise.resolve();this.busy=0;}
  run(fn){
    const result=this.tail.then(()=>{this.busy++;return fn();}).finally(()=>{this.busy--;});
    this.tail=result.catch(()=>{});
    return result;
  }
}
module.exports={Mutex};
