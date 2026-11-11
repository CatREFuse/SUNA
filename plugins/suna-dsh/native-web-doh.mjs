import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {requestPinnedProxy,getTransportCleanupState,transportCleanupFailure} from './native-web-proxy.mjs';

const MAX_DNS_BYTES=16384,MAX_RECORDS=32,MAX_ALIASES=8;
const DNS_FIELDS=new Set(['Status','TC','RD','RA','AD','CD','Question','Answer','Authority','Additional','Comment']);
const forbidden=new Set(['localhost','local','internal','home','lan','test','invalid','example','onion']);
const dnsError=dependencies=>new dependencies.WebError('Trusted public DNS could not resolve this page safely.','WEB_DNS_UNAVAILABLE');
const blocked=dependencies=>new dependencies.WebError('The URL is not an allowed public destination.','WEB_BLOCKED_URL');
export function publicDnsHostname(input){
  if(typeof input!=='string'||input.length>254||input!==input.trim()||/[\x00-\x20\x7f]/.test(input))return;
  const value=input.toLowerCase().replace(/\.$/,'');
  if(isIP(value)||value.includes(':')||value.length>253)return;
  const labels=value.split('.');
  if(labels.length<2||value==='home.arpa'||value.endsWith('.home.arpa')||forbidden.has(labels.at(-1))||['metadata','instance-data'].includes(labels[0])||labels.some(label=>!label||label.length>63||!/^([a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9])$/.test(label)))return;
  return value;
}
export function isBenchmarkAnswers(answers){
  return Array.isArray(answers)&&answers.length>0&&answers.length<=64&&answers.every(a=>{if(a?.family!==4||isIP(a.address)!==4)return false;const n=a.address.split('.').map(Number);return n[0]===198&&(n[1]===18||n[1]===19);});
}
const copyAddresses=answers=>answers.map(({address,family})=>({address,family}));
const immutableAddresses=answers=>Object.freeze(copyAddresses(answers).map(Object.freeze));
const lookupHost=hostname=>hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');

// rc.1 removed the provider DNS hook. Keep a Client-owned public-address
// policy for that shape; rc.5 continues using its existing official resolver.
export async function resolveNativePublicAddresses(hostname,signal,dependencies,resolver=lookup){
  signal.throwIfAborted();
  const fail=()=>{throw blocked(dependencies);};
  const host=hostname.replace(/^\[|\]$/g,'');
  const family=isIP(host);
  if(!family&&!publicDnsHostname(host))fail();
  const answers=family?[{address:host,family}]:await abortable(Promise.resolve().then(()=>resolver(host,{all:true,order:'verbatim'})),signal);
  const valid=entries=>Array.isArray(entries)&&entries.length<=64&&entries.every(e=>[4,6].includes(e?.family)&&isIP(e.address)===e.family);
  if(!valid(answers)||!answers.length)fail();
  // DNS64 can embed private IPv4 destinations inside globally scoped IPv6.
  // Discover RFC7050 prefixes once, validate every answer, and never connect
  // until the complete set is admitted. All six RFC6052 layouts are covered.
  let discovered=[];
  if(answers.some(e=>e.family===6)){
    discovered=await abortable(Promise.resolve().then(()=>resolver('ipv4only.arpa',{all:true,order:'verbatim'})),signal);
    if(!valid(discovered))fail();
  }
  const layouts=[32,40,48,56,64,96];
  const embedded=(bytes,bits)=>{
    if(bits!==96&&bytes[8]!==0)return;
    const positions=Array.from({length:16},(_,i)=>i).filter(i=>i>=bits/8&&(bits===96||i!==8)).slice(0,4);
    return positions.map(i=>bytes[i]).join('.');
  };
  const prefixes=[];
  for(const entry of discovered.filter(e=>e.family===6)){
    const bytes=dependencies.ipaddr.parse(entry.address).toByteArray();
    for(const bits of layouts)if(['192.0.0.170','192.0.0.171'].includes(embedded(bytes,bits)))prefixes.push({bytes:bytes.slice(0,bits/8),bits});
  }
  for(const entry of answers){
    if(!dependencies.isPublicAddress(entry.address))fail();
    if(entry.family===6){
      const bytes=dependencies.ipaddr.parse(entry.address).toByteArray();
      for(const prefix of prefixes)if(prefix.bytes.every((b,i)=>bytes[i]===b)){
        const ipv4=embedded(bytes,prefix.bits);if(ipv4!==undefined&&!dependencies.isPublicAddress(ipv4))fail();
      }
    }
  }
  signal.throwIfAborted();return copyAddresses(answers);
}

/** One fetch's immutable DNS evidence. NAT64 discovery is retained alongside
 * the destination set so redirect rechecks do not open a fresh DNS window. */
export async function capturePublicAddressSnapshot({provider,hostname,addresses,signal,dependencies,systemLookup=lookup}){
  let discovery=[];
  const checked=await provider.resolveAddresses(hostname,signal,async(query,options)=>{
    if(lookupHost(query)===lookupHost(hostname))return copyAddresses(addresses);
    if(query!=='ipv4only.arpa')throw dnsError(dependencies);
    const answers=await systemLookup(query,options);
    if(!Array.isArray(answers)||answers.length>64||answers.some(a=>![4,6].includes(a?.family)||isIP(a.address)!==a.family))throw dnsError(dependencies);
    discovery=copyAddresses(answers);return copyAddresses(discovery);
  });
  signal.throwIfAborted();
  return Object.freeze({hostname,addresses:immutableAddresses(checked),discovery:immutableAddresses(discovery)});
}
export async function revalidatePublicAddressSnapshot({provider,snapshot,signal,dependencies}){
  signal.throwIfAborted();
  if(!snapshot||typeof snapshot.hostname!=='string'||!Array.isArray(snapshot.addresses)||!snapshot.addresses.length||snapshot.addresses.length>64||!Array.isArray(snapshot.discovery)||snapshot.discovery.length>64)throw dnsError(dependencies);
  return provider.resolveAddresses(snapshot.hostname,signal,(query)=>{
    if(lookupHost(query)===lookupHost(snapshot.hostname))return Promise.resolve(copyAddresses(snapshot.addresses));
    if(query==='ipv4only.arpa')return Promise.resolve(copyAddresses(snapshot.discovery));
    throw dnsError(dependencies);
  });
}

/** Strict per-question chain admission. No unrelated records, mixed RR types,
 * private answers or unresolved CNAME tail can become a destination. */
export function parseDohAnswer(payload,{hostname,type,dependencies}){
  const expected=publicDnsHostname(hostname),fail=()=>{throw dnsError(dependencies);};
  if(!expected||![1,28].includes(type)||!payload||typeof payload!=='object'||Array.isArray(payload)||payload.Status!==0||payload.TC!==false||!Array.isArray(payload.Question)||payload.Question.length!==1)fail();
  if(Object.keys(payload).some(key=>!DNS_FIELDS.has(key)))fail();
  for(const key of ['RD','RA','AD','CD'])if(payload[key]!==undefined&&typeof payload[key]!=='boolean')fail();
  // Routing accepts only the requested Answer chain. Additional records are
  // rejected, even when public; this policy intentionally fails closed for
  // otherwise legitimate responses containing glue. SOA is bounded metadata.
  if(payload.Additional!==undefined&&(!Array.isArray(payload.Additional)||payload.Additional.length))fail();
  const authority=payload.Authority===undefined?[]:payload.Authority;
  if(!Array.isArray(authority)||authority.length>MAX_RECORDS)fail();
  for(const record of authority){
    if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).some(key=>!['name','type','TTL','data'].includes(key))||record.type!==6||!Number.isInteger(record.TTL)||record.TTL<0||record.TTL>2147483647||typeof record.data!=='string'||record.data.length>1024)fail();
    const zone=publicDnsHostname(record.name),parts=record.data.trim().split(/\s+/);
    if(!zone||(expected!==zone&&!expected.endsWith('.'+zone))||parts.length!==7||!publicDnsHostname(parts[0])||!publicDnsHostname(parts[1])||parts.slice(2).some(value=>!/^\d{1,10}$/.test(value)||Number(value)>4294967295))fail();
  }
  if(payload.Comment!==undefined&&(!Array.isArray(payload.Comment)||payload.Comment.length>16||payload.Comment.some(value=>typeof value!=='string'||value.length>1024)))fail();
  const question=payload.Question[0];if(!question||Object.keys(question).some(key=>!['name','type'].includes(key))||publicDnsHostname(question.name)!==expected||question.type!==type)fail();
  const answers=payload.Answer===undefined?[]:payload.Answer;if(!Array.isArray(answers)||answers.length>MAX_RECORDS)fail();
  const aliases=new Map(),addresses=new Map(),seen=new Set();
  for(const record of answers){
    if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).some(key=>!['name','type','TTL','data'].includes(key))||!Number.isInteger(record.TTL)||record.TTL<0||record.TTL>2147483647||typeof record.data!=='string')fail();
    const owner=publicDnsHostname(record.name);if(!owner||![5,type].includes(record.type))fail();
    const key=JSON.stringify([owner,record.type,record.data]);if(seen.has(key))fail();seen.add(key);
    if(record.type===5){const target=publicDnsHostname(record.data);if(!target||aliases.has(owner)||addresses.has(owner))fail();aliases.set(owner,target);}
    else{
      const family=type===1?4:6;
      if(isIP(record.data)!==family||!dependencies.isPublicAddress(record.data))throw blocked(dependencies);
      if(family===6&&dependencies.ipaddr.parse(record.data).isIPv4MappedAddress())throw blocked(dependencies);
      if(aliases.has(owner))fail();const list=addresses.get(owner)??[];list.push({address:record.data,family});addresses.set(owner,list);
    }
  }
  const chain=new Set();let current=expected;
  while(aliases.has(current)){if(chain.has(current)||chain.size>=MAX_ALIASES)fail();chain.add(current);current=aliases.get(current);}
  if(chain.has(current))fail();chain.add(current);
  if([...aliases.keys(),...addresses.keys()].some(owner=>!chain.has(owner)))fail();
  const result=addresses.get(current)??[];if(answers.length&&!result.length)fail();
  return result;
}

async function abortable(task,signal){
  const observed=Promise.resolve(task);void observed.catch(()=>{});signal.throwIfAborted();let abort;
  try{const value=await Promise.race([observed,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);signal.throwIfAborted();return value;}
  finally{if(abort)signal.removeEventListener('abort',abort);}
}

/** The resolver endpoint and destination IP are deployment constants. Only the
 * canonical hostname and RR type leave this process; never path/query/prompt. */
export async function queryFixedDoh({hostname,type,signal,route,dependencies}){
  const host=publicDnsHostname(hostname);if(!host||![1,28].includes(type)||!route?.proxied)throw dnsError(dependencies);
  const url=new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',host);url.searchParams.set('type',type===1?'A':'AAAA');
  let request,reader;
  try{
    request=await requestPinnedProxy({url,addresses:[{address:'1.1.1.1',family:4}],route,headers:{'user-agent':'SUNA native public DNS','accept':'application/dns-json'},signal,dependencies});
    const response=request.response;if(response.status!==200||!/^application\/dns-json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw dnsError(dependencies);
    const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_DNS_BYTES))throw dnsError(dependencies);
    reader=response.body?.getReader();if(!reader)throw dnsError(dependencies);
    const chunks=[];let total=0;
    while(true){const part=await abortable(reader.read(),signal);if(part.done)break;total+=part.value.length;if(total>MAX_DNS_BYTES)throw dnsError(dependencies);chunks.push(Buffer.from(part.value));}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));return JSON.parse(text);
  }catch(error){if(getTransportCleanupState(error))throw error;throw dnsError(dependencies);}
  finally{
    const failures=[];
    try{if(reader){await reader.cancel();reader.releaseLock();}else await request?.response.body?.cancel();}catch(error){if(getTransportCleanupState(error))failures.push(getTransportCleanupState(error));}
    try{await request?.close();}catch(error){const cleanup=getTransportCleanupState(error);if(cleanup)failures.push(cleanup);else throw error;}
    if(failures.length)throw transportCleanupFailure(dependencies,failures);
  }
}

/** Fake-IP recovery is deliberately narrow: only a trusted proxy route and an
 * entire system answer set in 198.18/15 admit two fixed-DoH questions. */
export async function resolveProxiedPublicAddresses({provider,url,route,signal,dependencies,systemLookup=lookup,queryDoh=queryFixedDoh,onSnapshot}){
  signal.throwIfAborted();
  const hostname=publicDnsHostname(url.hostname);
  if(!route?.proxied||!hostname)throw blocked(dependencies);
  let system;
  try{system=await abortable(Promise.resolve().then(()=>{signal.throwIfAborted();return systemLookup(hostname,{all:true,order:'verbatim'});}),signal);}catch{throw dnsError(dependencies);}
  if(!Array.isArray(system)||system.length>64)throw dnsError(dependencies);
  let selected=system;
  if(isBenchmarkAnswers(system)){
    const cancellation=new AbortController(),combined=AbortSignal.any([signal,cancellation.signal]);
    const queries=[1,28].map(async type=>{try{combined.throwIfAborted();const payload=await queryDoh({hostname,type,signal:combined,route,dependencies});combined.throwIfAborted();return parseDohAnswer(payload,{hostname,type,dependencies});}catch(error){cancellation.abort();throw error;}});
    const results=await Promise.allSettled(queries),failed=results.find(result=>result.status==='rejected');
    const cleanupFailures=results.filter(result=>result.status==='rejected').map(result=>getTransportCleanupState(result.reason)).filter(Boolean);
    if(cleanupFailures.length)throw transportCleanupFailure(dependencies,cleanupFailures);
    if(failed)throw failed.reason;
    selected=results.flatMap(result=>result.value);if(!selected.length)throw dnsError(dependencies);
  }
  signal.throwIfAborted();
  // Reuse the provider-bound complete-answer + NAT64/public-address validator. Its
  // lookup seam freezes this hostname's answers, so connection cannot rebind.
  const snapshot=await capturePublicAddressSnapshot({provider,hostname,addresses:selected,signal,dependencies,systemLookup});
  onSnapshot?.(snapshot);return copyAddresses(snapshot.addresses);
}
