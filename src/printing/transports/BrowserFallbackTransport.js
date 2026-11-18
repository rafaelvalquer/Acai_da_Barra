'use strict';
// Priority 3: the browser's print dialog, clearly an alternative. Nothing is sent from the server: it answers with the
// text of the report, and the screen prints it in a hidden 80 mm area with window.print(). The person chooses the
// printer in the browser, which may also show a margin or header the thermal printer does not need.
class BrowserFallbackTransport {
  constructor(){this.id='browser';this.label='Diálogo de impressão do navegador (alternativa)';this.escpos=false;this.browser=true;}
  supported(){return true;}
  async listPrinters(){return {printers:[],spooler:null,spoolerRunning:true};}
  async getStatus(){return {code:'browser',label:'A impressora é escolhida no diálogo do navegador.'};}
  async send(){return {spoolJobId:null,browser:true};}
}
module.exports={BrowserFallbackTransport};
