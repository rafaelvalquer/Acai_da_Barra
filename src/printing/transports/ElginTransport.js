'use strict';
// Priority 2: the Elgin E1 library (its own DLL) for the i9, reached through ESC/POS. NOT enabled: adopting it means a
// native dependency (ffi-napi or similar) that has not been shown to install and run on Node 22 / Windows / the
// installer, and the Windows queue (WindowsSpoolerTransport) already sends the same ESC/POS bytes. This class only
// keeps the place and answers honestly, so the transport can be swapped later without touching the report.
// To enable it: prove the installation in docs/impressao-elgin-i9.md, implement send() here, and set `enabled`.
class ElginTransport {
  constructor({enabled=false}={}){this.id='elgin-e1';this.label='Biblioteca Elgin E1 (não habilitada)';this.escpos=true;this.enabled=enabled;}
  supported(){return false;}
  unsupportedError(){return Object.assign(Error('A biblioteca Elgin E1 não está habilitada nesta versão. Use a fila de impressão do Windows.'),{code:'unsupported'});}
  async listPrinters(){throw this.unsupportedError();}
  async getStatus(){throw this.unsupportedError();}
  async send(){throw this.unsupportedError();}
}
module.exports={ElginTransport};
