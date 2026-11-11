import {AsyncLocalStorage} from 'node:async_hooks';

/** Classify at the public llm/stream boundary, before adapters clone requests.
 * The distribution-owned marker cannot be replaced by fields on an envelope.
 * Every iterator, including auxiliaries, installs its own scope so nested work
 * cannot inherit a parent's permission to receive images.
 */
export function createMainCallClassifier(ctx,{isAgentLoopRequest,resolveBinding}={}){
  const scopes=new AsyncLocalStorage();
  const primary=request=>request?.purpose===undefined||request?.purpose==='conversation';
  const bindingFor=request=>{
    if(!request||typeof request.sessionId!=='string'||!request.sessionId)return undefined;
    const binding=resolveBinding?.(request);
    return binding&&binding.sessionId===request.sessionId&&binding.provider===request.provider&&binding.model===request.model?binding:undefined;
  };
  if(typeof ctx?.on==='function'&&typeof isAgentLoopRequest==='function')ctx.on('llm/stream',(request,next)=>{
    const binding=bindingFor(request),scope=Object.freeze({binding,main:!!binding&&primary(request)&&isAgentLoopRequest(request)===true});
    return {[Symbol.asyncIterator](){
      const iterator=scopes.run(scope,()=>next()[Symbol.asyncIterator]());
      return {
        next:value=>scopes.run(scope,()=>iterator.next(value)),
        return:value=>scopes.run(scope,()=>iterator.return?iterator.return(value):Promise.resolve({done:true,value})),
        throw:error=>scopes.run(scope,()=>iterator.throw?iterator.throw(error):Promise.reject(error)),
        [Symbol.asyncIterator](){return this;},
      };
    }};
  });
  return {
    purposeFor(request,binding){const scope=scopes.getStore();return primary(request)&&bindingFor(request)===binding&&scope?.main===true&&scope.binding===binding?'conversation':'auxiliary';},
    assertBinding(request,binding){const scope=scopes.getStore();if(!binding||bindingFor(request)!==binding||scope?.binding&&scope.binding!==binding)throw new Error('Authenticated model run binding changed');},
  };
}
