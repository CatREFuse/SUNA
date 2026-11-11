import {createHash,randomUUID} from 'node:crypto';
export const ORIGINAL_DSH_SOURCE='dsh-original';
const sha=text=>createHash('sha256').update(text).digest('hex');
/** Uses the selected runtime's public renderer. Never copy or rewrite native prose. */
export function originalPromptRecord(assembly,{renderPrompt,runtimeVersion}={}){
  if(typeof renderPrompt!=='function'||!Array.isArray(assembly?.sections))throw new TypeError('Native prompt renderer unavailable');
  const sections=assembly.sections.filter(s=>s.name!=='suna:character');
  const text=renderPrompt({...assembly,sections});
  if(typeof text!=='string'||text.length>250000||!text.trim())throw Error('DSH_ORIGINAL_PROMPT_UNAVAILABLE');
  return {text,sha256:sha(text),sections:sections.map(({name,text,interpolate})=>({name,text,...(interpolate===undefined?{}:{interpolate})})),source:{kind:'dsh-system-prompt',runtimeVersion},dynamicContextExcluded:true};
}
/** Abort unpublished setup after capture: no followup, no model, no published Agent or parent persistent session. The isolated Session may be announced transiently. */
export async function captureOriginalPrompt({ctx,persistenceObserver,request,setup,renderPrompt,runtimeVersion,signal=AbortSignal.timeout(30000)}){
  const marker=Symbol('original-prompt-captured'),sessionId='suna-original-preview-'+randomUUID();let result;
  try{await (ctx.get?.('agents')??ctx.agents).create({sessionId,agentOptions:{provider:request.provider,model:request.model},meta:{cwd:request.cwd},signal,setup:async(agentCtx,agent)=>{
    signal?.throwIfAborted();await setup?.(agentCtx,agent);signal?.throwIfAborted();
    const selection=agent.model.current();
    const toolSet=await agentCtx.tools.resolve({agent,modelSelection:selection,signal});
    try{const assembly=await agentCtx.systemPrompt.assemble({agent,scope:agent,modelSelection:selection,toolSet});result=originalPromptRecord(assembly,{renderPrompt,runtimeVersion});}finally{toolSet.dispose();}
    throw marker;
  }});throw Error('DSH_ORIGINAL_CAPTURE_PUBLISHED');}catch(error){if(error!==marker)throw error;}
  if(persistenceObserver&&await persistenceObserver.stat(sessionId))throw Error('DSH_ORIGINAL_CAPTURE_RETAINED_SESSION');
  signal?.throwIfAborted();return result;
}
