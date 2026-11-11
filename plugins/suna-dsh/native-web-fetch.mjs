import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {isIP} from 'node:net';
import {requestPinnedProxy,requestPinnedDirect,getTransportCleanupState,transportCleanupFailure} from './native-web-proxy.mjs';
import {resolveNativePublicAddresses,resolveProxiedPublicAddresses,publicDnsHostname,capturePublicAddressSnapshot,revalidatePublicAddressSnapshot} from './native-web-doh.mjs';

const bindings=new Map();
let processInFlight=0;
export const NATIVE_WEB_LIMITS=Object.freeze({maxResponseBytes:1024*1024,maxBodyChars:32768,timeoutMs:15000,maxRedirects:3,userAgent:'SUNA native public web fetch'});
export const NATIVE_WEB_TOOL_CONFIG=Object.freeze({search:false,fetch:true,fetchTimeoutMs:15000,fetchMaxOutputChars:32768});
const messages=Object.freeze({WEB_EXECUTION_DENIED:'Native web fetch is not authorized for this execution.',WEB_ABORTED:'Native web fetch was cancelled.',WEB_FETCH_TIMEOUT:'Native web fetch timed out.',WEB_FETCH_BUSY:'Native web fetch concurrency limit reached.',WEB_PROXY_UNSUPPORTED:'Native web fetch cannot safely use the configured proxy route.',WEB_DNS_UNAVAILABLE:'Trusted public DNS could not resolve this page safely.',WEB_INVALID_URL:'The URL is invalid for public HTTP retrieval.',WEB_BLOCKED_URL:'The URL is not an allowed public destination.',WEB_REDIRECT_BLOCKED:'The redirect is not allowed.',WEB_FETCH_TOO_LARGE:'The response exceeds the allowed size.',WEB_UNSUPPORTED_CONTENT_TYPE:'The response content type is not supported.',WEB_PROVIDER_ERROR:'The public page could not be retrieved safely.',WEB_TRANSPORT_CLEANUP_FAILED:'Native web fetch could not close its transport safely.'});

async function beforeDeadline(task,deadline){let timer;try{return await Promise.race([Promise.resolve(task).then(()=>true,()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,deadline-performance.now()));})]);}finally{clearTimeout(timer);}}

// Resolve from the selected official CLI, never a neighboring checkout or the
// user's globally installed DSH. Feature probes perform no network requests.
export async function loadNativeWebDependencies(resolve){
  if(process.env.SUNA_NATIVE_WEB_PROXY_UNAVAILABLE==='1')throw new Error('Native public web proxy configuration is unavailable.');
  resolve??=createRequire(pathToFileURL(await realpath(process.argv[1]))).resolve;
  const names=['@deepseek-ai/dsh-web','@deepseek-ai/dsh-web-fetch-http','@deepseek-ai/dsh-tool-web','@deepseek-ai/dsh-http-proxy'];
  const [web,http,tool,proxy]=await Promise.all(names.map(async name=>import(pathToFileURL(resolve(name)).href)));
  const undici=await import(pathToFileURL(resolve('undici')).href),ipaddr=(await import(pathToFileURL(createRequire(resolve('@deepseek-ai/dsh-web-fetch-http')).resolve('ipaddr.js')).href)).default;
  const undiciVersion=createRequire(resolve('undici'))('undici/package.json').version,[major,minor,patch]=undiciVersion.split('.').map(Number);
  if(major!==8||minor<11||minor===11&&patch<2||typeof web.WebRuntime!=='function'||typeof web.WebError!=='function'||typeof http.HttpFetchProvider!=='function'||!['fetch','followAndRead','requestOnce','readBody','readCapped'].every(name=>typeof http.HttpFetchProvider.prototype[name]==='function')||typeof tool.apply!=='function'||typeof proxy.proxyRouteFor!=='function'||typeof undici.ProxyAgent!=='function'||typeof undici.Agent!=='function'||typeof undici.buildConnector!=='function'||typeof undici.Client!=='function'||typeof undici.request!=='function'||typeof ipaddr.parse!=='function')throw new Error('Native web dependencies unavailable');
  const httpVersion=createRequire(resolve('@deepseek-ai/dsh-web-fetch-http'))('@deepseek-ai/dsh-web-fetch-http/package.json').version;
  const httpResponseShape=httpVersion==='0.2.2-rc.1'?'response':httpVersion==='0.2.1-rc.5'?'owned':null;
  if(!httpResponseShape)throw new Error('Native web HTTP contract unavailable');
  const isPublicAddress=input=>{try{const address=ipaddr.parse(input);return address.kind()==='ipv6'&&address.isIPv4MappedAddress()?address.toIPv4Address().range()==='unicast':address.range()==='unicast';}catch{return false;}};
  return {httpVersion,httpResponseShape,WebError:web.WebError,HttpFetchProvider:http.HttpFetchProvider,proxyRouteFor:proxy.proxyRouteFor,ProxyAgent:undici.ProxyAgent,Agent:undici.Agent,buildConnector:undici.buildConnector,Client:undici.Client,request:undici.request,isPublicAddress,ipaddr,undiciVersion};
}

const sameRoute=(a,b)=>a.proxied===b.proxied&&a.proxy===b.proxy&&a.dispatcher===b.dispatcher;
/** Pins every official HTTP hop. The optional resolver seam is host-test-only;
 * model parameters remain the official url-only schema. A fetch's two DoH
 * questions and immutable DNS64/address evidence never escape that fetch.
 * Normal direct routes use the official DNS/public/NAT64 validator when
 * present, or the Client compatibility policy on the verified rc.1 contract, then use the same private bounded transport lifecycle.
 * There is deliberately no await between the policy check and delegation. */
export function safeHttpProvider(dependencies,limits=NATIVE_WEB_LIMITS,{systemLookup,queryDoh}={}){
  const {HttpFetchProvider,proxyRouteFor}=dependencies,hops=new AsyncLocalStorage();
  return new class extends HttpFetchProvider {
    constructor(...args){super(...args);if(typeof this.resolveAddresses!=='function')this.resolveAddresses=(hostname,signal,resolver=systemLookup)=>resolveNativePublicAddresses(hostname,signal,dependencies,resolver);}
    fetch(request,signal){const state={finished:false,transports:new Set()};return hops.run(state,async()=>{try{return await super.fetch(request,signal);}finally{
      state.finished=true;state.snapshot=undefined;state.resolving=undefined;
      const results=await Promise.allSettled([...state.transports].map(transport=>transport.close()));
      const failed=results.filter(result=>result.status==='rejected');
      if(failed.length){const cleanup=failed.map(result=>getTransportCleanupState(result.reason)).filter(Boolean);if(cleanup.length)throw transportCleanupFailure(dependencies,cleanup);throw failed[0].reason;}
    }});}
    async pinned(options){
      const state=hops.getStore();
      if(dependencies.httpResponseShape==='response'&&!state)throw new dependencies.WebError(messages.WEB_EXECUTION_DENIED,'WEB_EXECUTION_DENIED');
      const transport=await (options.route.proxied?requestPinnedProxy(options):requestPinnedDirect(options));
      if(dependencies.httpResponseShape!=='response')return transport;
      state.transports.add(transport);return transport.response;
    }
    requestOnce(url,signal){
      if(!publicDnsHostname(url.hostname)&&isIP(url.hostname.replace(/^\[|\]$/g,''))===0)throw new dependencies.WebError(messages.WEB_BLOCKED_URL,'WEB_BLOCKED_URL');
      const route=proxyRouteFor(url),state=hops.getStore()??{};
      if(state.finished)throw new dependencies.WebError(messages.WEB_EXECUTION_DENIED,'WEB_EXECUTION_DENIED');
      if(state.origin!==undefined&&(state.origin!==url.origin||state.hostname!==url.hostname||!sameRoute(state.route,route)))throw new dependencies.WebError(messages.WEB_REDIRECT_BLOCKED,'WEB_REDIRECT_BLOCKED');
      state.origin??=url.origin;state.hostname??=url.hostname;state.route??={proxied:route.proxied,proxy:route.proxy,dispatcher:route.dispatcher};
      if(route.proxied){
        const first=async()=>{
          if(publicDnsHostname(url.hostname))return resolveProxiedPublicAddresses({provider:this,url,route,signal,dependencies,systemLookup,queryDoh,onSnapshot:snapshot=>{state.snapshot=snapshot;}});
          const address=url.hostname.replace(/^\[|\]$/g,'');state.snapshot=await capturePublicAddressSnapshot({provider:this,hostname:url.hostname,addresses:[{address,family:isIP(address)}],signal,dependencies,systemLookup});return state.snapshot.addresses;
        };
        const addresses=state.snapshot?revalidatePublicAddressSnapshot({provider:this,snapshot:state.snapshot,signal,dependencies}):(state.resolving??=first());
        return addresses.then(addresses=>{if(!sameRoute(state.route,proxyRouteFor(url)))throw new dependencies.WebError(messages.WEB_REDIRECT_BLOCKED,'WEB_REDIRECT_BLOCKED');return this.pinned({url,addresses,route,headers:{'user-agent':limits.userAgent,accept:'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8'},signal,dependencies,timeoutMs:limits.timeoutMs});});
      }
      return this.resolveAddresses(url.hostname,signal,systemLookup).then(addresses=>{
        if(!sameRoute(state.route,proxyRouteFor(url)))throw new dependencies.WebError(messages.WEB_REDIRECT_BLOCKED,'WEB_REDIRECT_BLOCKED');
        return this.pinned({url,addresses,route,headers:{'user-agent':limits.userAgent,accept:'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8'},signal,dependencies,timeoutMs:limits.timeoutMs});
      });
    }
  }(limits);
}

/** The web seam has no model identity arguments. Only the exact ToolRuntime
 * execution may enter it through this run's async-local capability. */
export async function createNativeWebBackend({signal,authorize,dependencies,limits=NATIVE_WEB_LIMITS}={}){
  if(!signal||typeof authorize!=='function')throw new TypeError('Native web requires a bound lifecycle');
  dependencies??=await loadNativeWebDependencies();
  const {WebError}=dependencies,provider=safeHttpProvider(dependencies,limits),storage=new AsyncLocalStorage(),lifetime=new AbortController(),pending=new Set(),unconfirmed=new Set();
  const bindingId=randomUUID();let active=true,agent,inFlight=0,closeTask;
  const denied=()=>new WebError(messages.WEB_EXECUTION_DENIED,'WEB_EXECUTION_DENIED');
  const allowed=()=>{if(!active||signal.aborted||lifetime.signal.aborted)return false;try{return authorize()===true;}catch{return false;}};
  const valid=exec=>allowed()&&!!agent&&exec?.agent===agent&&exec.name==='web_fetch'&&!exec.signal?.aborted&&typeof exec.signal?.addEventListener==='function';
  const sanitize=(error,combined)=>{const code=combined?.aborted?(signal.aborted||lifetime.signal.aborted?'WEB_ABORTED':combined.reason?.name==='TimeoutError'?'WEB_FETCH_TIMEOUT':'WEB_ABORTED'):Object.hasOwn(messages,error?.code)?error.code:'WEB_PROVIDER_ERROR';return new WebError(messages[code],code);};
  const backend={
    bindingId,
    bindAgent(value){if(!active||!value||agent&&agent!==value)throw denied();agent=value;},
    async execute(exec,next){
      if(!valid(exec))throw denied();
      const state={exec,finished:false};
      return storage.run(state,async()=>{try{return await next();}finally{state.finished=true;}});
    },
    provider:{id:'http',available:()=>active,
      async fetch(request,executionSignal){
        const state=storage.getStore(),exec=state?.exec;
        if(!state||state.finished||!valid(exec)||executionSignal!==exec.signal||!request||Object.keys(request).some(key=>key!=='url')||typeof request.url!=='string'||request.url!==exec.arguments?.url)throw denied();
        if(inFlight>=2||processInFlight>=8)throw new WebError(messages.WEB_FETCH_BUSY,'WEB_FETCH_BUSY');
        const combined=AbortSignal.any([exec.signal,signal,lifetime.signal,AbortSignal.timeout(limits.timeoutMs)]);
        inFlight++;processInFlight++;
        const task=Promise.resolve().then(()=>{if(!valid(exec)||state.finished||combined.aborted)throw denied();return provider.fetch({url:request.url},combined);});
        pending.add(task);let released=false;
        const release=()=>{if(!released){released=true;inFlight--;processInFlight--;}};
        // An unconfirmed private dispatcher still owns its process quota. Its
        // late physical close may release it, but a settled tool error cannot.
        void task.then(()=>{pending.delete(task);release();},error=>{
          pending.delete(task);const cleanup=getTransportCleanupState(error);
          if(!cleanup){release();return;}
          unconfirmed.add(cleanup.closed);void cleanup.closed.then(()=>{unconfirmed.delete(cleanup.closed);release();});
        }).catch(()=>{});
        let onAbort;
        try{
          const result=await Promise.race([task,new Promise((_,reject)=>{onAbort=()=>reject(combined.reason);combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort();})]);
          if(!valid(exec)||state.finished||combined.aborted)throw denied();
          return result;
        }catch(error){throw sanitize(error,combined);}
        finally{if(onAbort)combined.removeEventListener('abort',onAbort);}
      },
    },
    close(){
      if(closeTask)return closeTask;active=false;bindings.delete(bindingId);lifetime.abort();
      const tasks=Promise.allSettled([...pending]),closed=tasks.then(()=>Promise.all([...unconfirmed])).then(()=>{});
      closeTask=(async()=>{if(!await beforeDeadline(closed,performance.now()+1500))throw transportCleanupFailure(dependencies,[{closed}]);})();return closeTask;
    },
  };
  bindings.set(bindingId,backend);return backend;
}

export const name='suna-native-web-fetch';
export const inject=['web','tools'];
export function apply(ctx,config={}){
  const backend=bindings.get(config.bindingId);if(!backend)return;
  ctx.web.registerFetchProvider(backend.provider);
  ctx.on('tools/execute',(exec,next)=>exec.name==='web_fetch'?backend.execute(exec,next):next(),{prepend:true});
}
