import {isIP} from 'node:net';
import {Readable} from 'node:stream';

const cleanupStates=new WeakMap();
export const TRANSPORT_CLEANUP_GRACE_MS=1000;
export function getTransportCleanupState(error){return cleanupStates.get(error);}
export function transportCleanupFailure(dependencies,states=[]){
  const error=new dependencies.WebError('The page transport could not be closed safely.','WEB_TRANSPORT_CLEANUP_FAILED');
  const closed=states.length?Promise.all(states.map(state=>state.closed)).then(()=>{}):new Promise(()=>{});
  cleanupStates.set(error,{closed});return error;
}
async function until(task,deadline){
  let timer;try{return await Promise.race([Promise.resolve(task),new Promise(resolve=>{timer=setTimeout(()=>resolve(undefined),Math.max(0,deadline-performance.now()));})]);}finally{clearTimeout(timer);}
}
async function abortable(task,signal){
  const observed=Promise.resolve(task);void observed.catch(()=>{});signal.throwIfAborted();let abort;
  try{const value=await Promise.race([observed,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);signal.throwIfAborted();return value;}
  finally{if(abort)signal.removeEventListener('abort',abort);}
}

/** One private pinned-IP tunnel. Cancellation and cleanup remain bounded even
 * when a dispatcher or stream fails to complete its own teardown. No global
 * dispatcher, resolver or TLS policy is changed. */
export async function requestPinnedProxy(options){if(options.route?.proxied!==true)throw new options.dependencies.WebError('The configured proxy is unsupported.','WEB_PROXY_UNSUPPORTED');return requestPinnedTransport(options,true);}
export async function requestPinnedDirect(options){if(options.route?.proxied!==false)throw new options.dependencies.WebError('The direct route is unavailable.','WEB_PROXY_UNSUPPORTED');return requestPinnedTransport(options,false);}
async function requestPinnedTransport({url,addresses,route,headers,signal,dependencies,timeoutMs=15000},proxied){
  const {ProxyAgent,Client,request,WebError,isPublicAddress}=dependencies,fail=(code,message)=>new WebError(message,code);
  let proxy;if(proxied){try{proxy=new URL(route.proxy);}catch{throw fail('WEB_PROXY_UNSUPPORTED','The configured proxy is unsupported.');}if(!['http:','https:'].includes(proxy.protocol))throw fail('WEB_PROXY_UNSUPPORTED','The configured proxy is unsupported.');}
  if(!Array.isArray(addresses)||!addresses.length||addresses.length>64||addresses.some(a=>![4,6].includes(a.family)||isIP(a.address)!==a.family||!isPublicAddress(a.address)))throw fail('WEB_BLOCKED_URL','The URL is not an allowed public destination.');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw fail('WEB_PROVIDER_ERROR','The page request limits are invalid.');
  signal.throwIfAborted();const effective=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);
  const address=addresses.find(a=>a.family===4)??addresses[0],pinned=new URL(url),hostname=url.hostname.replace(/^\[|\]$/g,'');
  pinned.hostname=address.family===6?'['+address.address+']':address.address;
  const sockets=new Set();
  let dispatcher,rawBody,sourceReader,sourceDone=false,sourceCancelTask,requestSettled=false,bodyClosed=true,agentClosed=false,connecting=0,cleanupFault=false,cleanupDeadline,destroyTask,closeTask,finishClosed;
  const closed=new Promise(resolve=>{finishClosed=resolve;}),cleanupState={closed};
  const checkClosed=()=>{if(agentClosed&&requestSettled&&bodyClosed&&sockets.size===0&&connecting===0)finishClosed();};
  const failure=()=>transportCleanupFailure(dependencies,[cleanupState]);
  const beginCleanup=()=>cleanupDeadline??=performance.now()+TRANSPORT_CLEANUP_GRACE_MS;
  const observed=invoke=>{let work;try{work=invoke();}catch{cleanupFault=true;return Promise.resolve(false);}return Promise.resolve(work).then(()=>true,()=>{cleanupFault=true;return false;});};
  const destroyBody=()=>{if(rawBody&&!rawBody.closed)try{rawBody.destroy();}catch{cleanupFault=true;}};
  const own=socket=>{
    if(socket&&!sockets.has(socket)&&!socket.closed){sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);checkClosed();});if(effective.aborted||cleanupDeadline!==undefined)try{socket.destroy();}catch{cleanupFault=true;}}
    return socket;
  };
  const clientFactory=(origin,options)=>{
    const connector=typeof options.connect==='function'?options.connect:dependencies.buildConnector(options.connect);
    const client=new Client(origin,{...options,connect:(opts,callback)=>{
      connecting++;let settled=false;const finish=()=>{if(!settled){settled=true;connecting--;checkClosed();}};
      try{return own(connector(opts,(error,socket)=>{own(socket);finish();callback(error,socket);}));}catch(error){finish();throw error;}
    }});
    const connect=client.connect.bind(client);client.connect=async options=>{connecting++;try{const value=await connect(options);own(value.socket);return value;}finally{connecting--;checkClosed();}};return client;
  };
  const tls={servername:isIP(hostname)?undefined:hostname,rejectUnauthorized:true,allowH2:false};
  dispatcher=proxied?new ProxyAgent({uri:proxy.href,proxyTunnel:true,connections:1,pipelining:0,clientFactory,connectTimeout:Math.min(timeoutMs,5000),requestTls:tls,proxyTls:{rejectUnauthorized:true,allowH2:false}}):new dependencies.Agent({connections:1,pipelining:0,maxOrigins:1,factory:clientFactory,connect:{...tls,timeout:Math.min(timeoutMs,5000)}});
  const destroy=()=>{
    beginCleanup();destroyBody();for(const socket of sockets)try{socket.destroy();}catch{cleanupFault=true;}
    destroyTask??=observed(()=>dispatcher.destroy()).then(ok=>{if(ok)agentClosed=true;checkClosed();return ok;});return destroyTask;
  };
  const cancelSource=reason=>{
    beginCleanup();if(!sourceReader||sourceDone)return Promise.resolve(true);
    sourceCancelTask??=observed(()=>sourceReader.cancel(reason));return sourceCancelTask;
  };
  const abort=()=>{beginCleanup();void cancelSource();void destroy();};effective.addEventListener('abort',abort,{once:true});
  async function close(failed=false){
    if(closeTask)return closeTask;
    const deadline=beginCleanup();
    closeTask=(async()=>{
      try{
        let ok;
        if(failed||effective.aborted||destroyTask)ok=await until(destroy(),deadline);
        else{ok=await until(observed(()=>dispatcher.close()).then(value=>{if(value)agentClosed=true;checkClosed();return value;}),deadline);if(ok!==true){cleanupFault=true;ok=await until(destroy(),deadline);}}
        if(ok!==true)cleanupFault=true;
        if(sourceCancelTask&&await until(sourceCancelTask,deadline)!==true)cleanupFault=true;
        checkClosed();if(await until(closed.then(()=>true),deadline)!==true){cleanupFault=true;void destroy();}
        if(cleanupFault)throw failure();
      }finally{effective.removeEventListener('abort',abort);}
    })();return closeTask;
  }
  let accepting=true;
  const task=Promise.resolve().then(()=>{effective.throwIfAborted();return request(pinned,{dispatcher,method:'GET',headers:{'user-agent':headers['user-agent'],accept:headers.accept,'accept-encoding':'identity',host:url.host},signal:effective,headersTimeout:timeoutMs,bodyTimeout:timeoutMs,maxRedirections:0});});
  // Late responses are still owned and destroyed after the caller has left.
  void task.then(value=>{
    requestSettled=true;rawBody=value.body;bodyClosed=rawBody?.closed===true||!rawBody;
    rawBody?.on('error',()=>{});rawBody?.once('close',()=>{bodyClosed=true;checkClosed();});
    if(!accepting||effective.aborted){destroyBody();void destroy();}checkClosed();
  },()=>{requestSettled=true;checkClosed();}).catch(()=>{cleanupFault=true;});
  try{
    const value=await abortable(task,effective);effective.throwIfAborted();
    const encoding=String(value.headers['content-encoding']??'identity').trim().toLowerCase();
    if(encoding&&encoding!=='identity'){destroyBody();throw fail('WEB_UNSUPPORTED_CONTENT_TYPE','The response encoding is unsupported.');}
    const responseHeaders=new Headers();for(const [key,values] of Object.entries(value.headers))for(const item of Array.isArray(values)?values:[values])if(item!==undefined)responseHeaders.append(key,String(item));
    const empty=[204,205,304].includes(value.statusCode);let body=null;
    if(empty)destroyBody();else{
      sourceReader=Readable.toWeb(rawBody).getReader();
      body=new ReadableStream({
        async pull(controller){try{const part=await abortable(sourceReader.read(),effective);if(part.done){sourceDone=true;sourceReader.releaseLock();controller.close();}else controller.enqueue(part.value);}catch(error){void cancelSource();void destroy();controller.error(error);}},
        async cancel(reason){const deadline=beginCleanup();if(await until(cancelSource(reason),deadline)!==true){cleanupFault=true;void destroy();throw failure();}},
      });
    }
    return {response:new Response(body,{status:value.statusCode,headers:responseHeaders}),close:()=>close()};
  }catch(error){accepting=false;await close(true);throw error;}
}
