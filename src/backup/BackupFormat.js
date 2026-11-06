'use strict';
// The .luminorbackup file: one database snapshot plus its manifest, compressed and encrypted (AES-256-GCM).
//
//   "LUMINORBKP1\n" | header length (uint32) | header (JSON) | encrypted payload | GCM tag (16 bytes)
//
// The header is readable without the key (format version, date, which key was used) and is authenticated together
// with the payload, so changing either one makes the file fail to open. The payload is gzip of
//   manifest length (uint32) | manifest (JSON: counts, schema version, SHA-256 of the database) | SQLite database
// The encryption key is derived (HKDF-SHA256, random salt per file) from the store's backup key. That key lives in
// config/backup.key on this computer and is also written down by the administrator as the recovery key, which is what
// opens the backups on a new computer.
const crypto=require('node:crypto');const zlib=require('node:zlib');
const MAGIC=Buffer.from('LUMINORBKP1\n','ascii');
const FORMAT='luminor-pdv-backup',FORMAT_VERSION=1,INFO=Buffer.from('luminor-pdv-backup-v1');
const TAG_BYTES=16,MAX_HEADER=16*1024,MAX_DATABASE=1024*1024*1024;
const EXTENSION='.luminorbackup';
class BackupError extends Error {
  // code: formato, versao, chave, corrompido, estrutura, incompativel, tamanho
  constructor(code,message,status=422){super(message);this.code=code;this.status=status;}
}
const sha256=data=>crypto.createHash('sha256').update(data).digest('hex');
// Short public fingerprint of a key, written in the header so the PDV can tell which key a backup needs.
const keyId=key=>crypto.createHmac('sha256',key).update('luminor-pdv-key-id').digest('hex').slice(0,16);
const derive=(key,salt)=>Buffer.from(crypto.hkdfSync('sha256',key,salt,INFO,32));

function encodeBackup({manifest,database,key,createdAt=manifest.createdAt}){
  const manifestBytes=Buffer.from(JSON.stringify(manifest),'utf8');const len=Buffer.alloc(4);len.writeUInt32BE(manifestBytes.length);
  const plain=zlib.gzipSync(Buffer.concat([len,manifestBytes,database]),{level:6});
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12);
  const header=Buffer.from(JSON.stringify({format:FORMAT,formatVersion:FORMAT_VERSION,createdAt,keyId:keyId(key),
    kdf:{name:'HKDF-SHA256',salt:salt.toString('base64')},cipher:{name:'AES-256-GCM',iv:iv.toString('base64')}}),'utf8');
  const hlen=Buffer.alloc(4);hlen.writeUInt32BE(header.length);
  const prefix=Buffer.concat([MAGIC,hlen,header]);
  const cipher=crypto.createCipheriv('aes-256-gcm',derive(key,salt),iv);cipher.setAAD(prefix);
  const body=Buffer.concat([cipher.update(plain),cipher.final()]);
  return Buffer.concat([prefix,body,cipher.getAuthTag()]);
}
// Checks the file's shape and returns its header. Needs no key.
function readHeader(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length<MAGIC.length+4+TAG_BYTES||!buffer.subarray(0,MAGIC.length).equals(MAGIC))
    throw new BackupError('formato','Este arquivo não é um backup do Luminor PDV.');
  const hlen=buffer.readUInt32BE(MAGIC.length);
  if(hlen<2||hlen>MAX_HEADER||MAGIC.length+4+hlen+TAG_BYTES>buffer.length)throw new BackupError('corrompido','O arquivo de backup está incompleto ou corrompido.');
  let header;try{header=JSON.parse(buffer.subarray(MAGIC.length+4,MAGIC.length+4+hlen).toString('utf8'));}catch(_){throw new BackupError('corrompido','O arquivo de backup está corrompido.');}
  if(header?.format!==FORMAT)throw new BackupError('formato','Este arquivo não é um backup do Luminor PDV.');
  if(header.formatVersion!==FORMAT_VERSION)throw new BackupError('versao',`Formato de backup ${header.formatVersion} não suportado por esta versão do PDV. Atualize o programa.`);
  if(header.cipher?.name!=='AES-256-GCM'||header.kdf?.name!=='HKDF-SHA256'||typeof header.keyId!=='string')throw new BackupError('formato','Formato de backup desconhecido.');
  return {header,prefixLength:MAGIC.length+4+hlen};
}
// Decrypts and unpacks. A wrong key and a changed byte look the same to GCM: both fail here, before anything is used.
function decodeBackup(buffer,key){
  const {header,prefixLength}=readHeader(buffer);
  if(keyId(key)!==header.keyId)throw new BackupError('chave','A chave de recuperação não corresponde a este backup.');
  let plain;
  try{
    const decipher=crypto.createDecipheriv('aes-256-gcm',derive(key,Buffer.from(header.kdf.salt,'base64')),Buffer.from(header.cipher.iv,'base64'));
    decipher.setAAD(buffer.subarray(0,prefixLength));decipher.setAuthTag(buffer.subarray(buffer.length-TAG_BYTES));
    plain=Buffer.concat([decipher.update(buffer.subarray(prefixLength,buffer.length-TAG_BYTES)),decipher.final()]);
  }catch(_){throw new BackupError('corrompido','O arquivo de backup está corrompido ou foi alterado. Use outro backup.');}
  let raw;try{raw=zlib.gunzipSync(plain,{maxOutputLength:MAX_DATABASE+MAX_HEADER*64});}catch(_){throw new BackupError('corrompido','O conteúdo do backup está corrompido.');}
  const mlen=raw.readUInt32BE(0);
  let manifest;try{manifest=JSON.parse(raw.subarray(4,4+mlen).toString('utf8'));}catch(_){throw new BackupError('corrompido','O manifesto do backup está corrompido.');}
  const database=raw.subarray(4+mlen);
  if(manifest?.database?.bytes!==database.length||manifest.database.sha256!==sha256(database))
    throw new BackupError('corrompido','A verificação do conteúdo do backup falhou (soma de verificação diferente).');
  return {header,manifest,database};
}

// Recovery key: 20 random bytes written as 32 characters (Crockford base32) in groups of four, easy to copy by hand.
const ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function formatKey(key){
  let bits=0,value=0,out='';
  for(const byte of key){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=ALPHABET[(value>>>(bits-5))&31];bits-=5;}value&=(1<<bits)-1;}
  if(bits>0)out+=ALPHABET[(value<<(5-bits))&31];
  return out.match(/.{1,4}/g).join('-');
}
function parseKey(text){
  const s=String(text||'').toUpperCase().replace(/[\s-]/g,'').replace(/O/g,'0').replace(/[IL]/g,'1');
  if(!/^[0-9A-HJKMNP-TV-Z]{32}$/.test(s))throw new BackupError('chave','Chave de recuperação inválida. Ela tem 32 letras e números, em grupos de quatro.',400);
  const bytes=[];let bits=0,value=0;
  for(const ch of s){value=(value<<5)|ALPHABET.indexOf(ch);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}value&=(1<<bits)-1;}
  return Buffer.from(bytes);
}
const newKey=()=>crypto.randomBytes(20);
module.exports={encodeBackup,decodeBackup,readHeader,BackupError,sha256,keyId,formatKey,parseKey,newKey,EXTENSION,FORMAT_VERSION,MAGIC};
