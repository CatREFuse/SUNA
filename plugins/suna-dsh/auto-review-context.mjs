import {AsyncLocalStorage} from 'node:async_hooks';
// rc.5 omits the auxiliary Session id; rc.1 supplies it. Bind either request to the exact native call's authenticated SUNA
// run before public LLM dispatch, so run-scoped adapters can authorize it and
// usage is attributed without granting it conversation images or user prompts.
// rc.1 labels every user source as an instruction. Historical SUNA aggregate
// messages lacked an rpcId; keep those facts when this managed review also
// contains our server-authenticated canonical instruction. Read only outer
// official history entries, never JSON embedded inside their content.
export function projectSunaReviewProvenance(options,{managedContext=false}={}){
 if(!Array.isArray(options.messages))return options;
 const entries=[];
 for(const message of options.messages)if(message.role==='user')for(const block of typeof message.content==='string'?[{type:'text',text:message.content}]:message.content??[]){
  if(block?.type!=='text'||typeof block.text!=='string'||!block.text.startsWith('{'))continue;
  try{const value=JSON.parse(block.text);if(value?.kind==='user-message')entries.push({message,block,value});}catch{}
 }
 const trusted=entry=>entry.source?.kind==='user'&&typeof entry.source.rpcId==='string'&&entry.source.rpcId.startsWith('suna:');
 if(!managedContext&&!entries.some(({value})=>value.role==='user-instruction'&&trusted(value)))return options;
 const replacements=new Map(entries.filter(({value})=>value.role==='user-instruction'&&value.source?.kind==='user'&&!trusted(value)).map(({block,value})=>[block.text,JSON.stringify({...value,role:'fact'})]));
 if(!replacements.size)return options;
 return {...options,messages:options.messages.map(message=>message.role!=='user'?message:{...message,content:typeof message.content==='string'?(replacements.get(message.content)??message.content):message.content.map(block=>replacements.has(block.text)?{...block,text:replacements.get(block.text)}:block)})};
}
export function createAutoReviewContext(ctx){
 const scope=new AsyncLocalStorage(),bindings=new WeakMap(),llm=ctx.llm;
 let active=true;
 const own=Object.getOwnPropertyDescriptor(llm,'stream');let descriptor=own;
 for(let p=Object.getPrototypeOf(llm);!descriptor&&p;p=Object.getPrototypeOf(p))descriptor=Object.getOwnPropertyDescriptor(p,'stream');
 if(typeof descriptor?.value!=='function')throw new Error('DSH LLM stream service unavailable');
 const original=descriptor.value;
 const wrapper=function(options){
  const binding=active?scope.getStore():undefined;
  if(binding&&typeof options?.system==='string'&&options.system.startsWith('REVIEW_POLICY\n')){
   if(!binding.current()||binding.signal?.aborted)throw new Error('Auto review run ended');
   if(options.provider!==binding.provider||options.model!==binding.model||options.sessionId!==undefined&&options.sessionId!==binding.sessionId)throw new Error('Auto review route changed');
   options=projectSunaReviewProvenance({...options,sessionId:binding.sessionId,purpose:'auto-review',signal:AbortSignal.any([options.signal,binding.signal].filter(Boolean))},{managedContext:binding.managedContext});
  }
  return Reflect.apply(original,this,[options]);
 };
 Object.defineProperty(llm,'stream',{configurable:true,writable:true,enumerable:own?.enumerable??false,value:wrapper});
 const approval=ctx.get('approval'),approvalOwn=approval?Object.getOwnPropertyDescriptor(approval,'request'):undefined;let approvalDescriptor=approvalOwn;for(let p=approval&&Object.getPrototypeOf(approval);!approvalDescriptor&&p;p=Object.getPrototypeOf(p))approvalDescriptor=Object.getOwnPropertyDescriptor(p,'request');const approvalOriginal=approvalDescriptor?.value;
 const approvalWrapper=function(request){const binding=active?bindings.get(request?.agent):undefined;if(binding&&!binding.clientNames.has(request.toolName))request={...request,signal:AbortSignal.any([request.signal,binding.signal].filter(Boolean))};return Reflect.apply(approvalOriginal,this,[request]);};
 if(typeof approvalOriginal==='function')Object.defineProperty(approval,'request',{configurable:true,writable:true,enumerable:approvalOwn?.enumerable??false,value:approvalWrapper});
 const enter=(exec,next)=>{
  const binding=active?bindings.get(exec.agent):undefined;
  return binding&&ctx.get('permissionPresets')?.current(exec.agent.session)==='auto'?scope.run(binding,next):next();
 };
 let unhook=ctx.on('tools/pre-execute',enter,{prepend:true});
 return {
  prioritize(){unhook();unhook=ctx.on('tools/pre-execute',enter,{prepend:true});},
  isClient(exec){return bindings.get(exec.agent)?.clientNames.has(exec.name)===true;},
  bind(agent,{provider,model,signal,current=()=>true,clientNames=[],managedContext=false}){const binding={sessionId:agent.id,provider,model,signal,current,managedContext,clientNames:new Set(clientNames)};bindings.set(agent,binding);return()=>{if(bindings.get(agent)===binding)bindings.delete(agent);};},
  close(){active=false;unhook();if(typeof approvalOriginal==='function'&&Object.getOwnPropertyDescriptor(approval,'request')?.value===approvalWrapper){if(approvalOwn)Object.defineProperty(approval,'request',approvalOwn);else delete approval.request;}if(Object.getOwnPropertyDescriptor(llm,'stream')?.value===wrapper){if(own)Object.defineProperty(llm,'stream',own);else delete llm.stream;}scope.disable();},
 };
}

// SUNA Client tools already enforce scoped channel/sender permissions. They are
// RPCs rather than native computer capabilities, so they remain outside the
// runtime's native execution review. Use the published official integration
// unchanged, filtering only its public pre-execute listener at this boundary.
export async function installOfficialAutoReview(ctx,binding,{load}={}){
 if(ctx.get('permissionPresets')?.names.includes('auto'))return false;
 try{
  const module=await load('@deepseek-ai/dsh-experimental-auto-review');
  const context=new Proxy(ctx,{get(target,key){
   if(key==='on')return(name,listener,options)=>target.on(name,name==='tools/pre-execute'?((exec,next)=>binding.isClient(exec)?next():listener(exec,next)):listener,options);
   if(['permissionPresets','approval','llm','sessions','tools','workingDirectory'].includes(key))return target.get(key);
   return Reflect.get(target,key);
  }});
  module.apply(context);binding.prioritize();return true;
 }catch(error){if(error.code==='MODULE_NOT_FOUND'||error.code==='ERR_MODULE_NOT_FOUND')return false;throw error;}
}
