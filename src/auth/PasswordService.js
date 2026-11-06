'use strict';
// Administrator passwords: only an Argon2id hash is stored (OWASP parameters: 19 MiB, 2 iterations, 1 lane), never
// the password itself. New passwords need at least 12 characters.
const crypto=require('node:crypto');const {argon2id,argon2Verify}=require('hash-wasm');
const PARAMS={memorySize:19456,iterations:2,parallelism:1,hashLength:32};
const MIN=12,MAX=128;
const COMMON=['123456789012','administrador','adminadmin12','senhasenha12','luminorpdv123','acaidabarra1','qwertyuiop12','password1234'];
const fail=(msg,status=400)=>{throw Object.assign(Error(msg),{status});};
async function hashPassword(password){return argon2id({password:String(password),salt:crypto.randomBytes(16),...PARAMS,outputType:'encoded'});}
// A fixed hash checked when the account does not exist, so a wrong user name takes as long as a wrong password.
let dummy=null;
async function verifyPassword(hash,password){
  if(!hash){dummy=dummy||await hashPassword(crypto.randomBytes(16).toString('hex'));await argon2Verify({password:String(password??''),hash:dummy}).catch(()=>false);return false;}
  try{return await argon2Verify({password:String(password??''),hash});}catch(_){return false;}
}
function checkNewPassword(password,{username='',current=''}={}){
  const s=String(password??'');
  if(s.length<MIN)fail(`A nova senha precisa ter pelo menos ${MIN} caracteres.`);
  if(s.length>MAX)fail(`A senha pode ter no máximo ${MAX} caracteres.`);
  const low=s.toLowerCase();
  if(/^(.)\1+$/.test(s)||COMMON.includes(low)||low.startsWith('admin')&&low.replace(/admin/g,'').length<4)fail('Escolha uma senha menos previsível.');
  if(username&&low.includes(String(username).toLowerCase())&&String(username).length>=3)fail('A senha não pode conter o nome de usuário.');
  if(current&&s===current)fail('A nova senha precisa ser diferente da atual.');
  return s;
}
function checkUsername(name){
  const s=String(name??'').trim();
  if(!/^[A-Za-z0-9._-]{3,32}$/.test(s))fail('O usuário deve ter de 3 a 32 letras, números, ponto, hífen ou sublinhado.');
  return s;
}
// Emergency recovery code: 16 random characters in groups of four, shown once; only its hash is kept.
function newRecoveryCode(){const A='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';const b=crypto.randomBytes(16);let s='';for(const x of b)s+=A[x%32];return s.match(/.{4}/g).join('-');}
const normalizeCode=c=>String(c||'').toUpperCase().replace(/[^0-9A-Z]/g,'');
module.exports={hashPassword,verifyPassword,checkNewPassword,checkUsername,newRecoveryCode,normalizeCode,MIN_LENGTH:MIN};
