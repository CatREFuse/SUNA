import {randomUUID} from 'node:crypto';
import {joinClientPromptLayers} from './client-prompt-xml.mjs';

export const CLIENT_DEVELOPER_SOURCE='suna-client-developer-prompt';
const unavailable=()=>Object.assign(new Error('当前 DSH 不支持可持久化的 Client 开发提示词'),{code:'CLIENT_PROMPT_LAYERS_UNAVAILABLE'});
const plain=message=>(message?.content??[]).map(block=>block.type==='text'?block.text:'').join('');

/** The SDK filters freeform developer nodes as tool updates. Persist the whole
 * Client-owned instruction, then let the owned provider transport project it. */
export function syncClientPromptLayers(session,{systemPrompt,developerPrompt='',turn,step,signal}={}){
  if(typeof systemPrompt!=='string'||typeof developerPrompt!=='string'||!Number.isSafeInteger(turn)||turn<1||!Number.isSafeInteger(step)||step<1)throw new TypeError('Client 提示词分层参数无效');
  if(!session?.append||!session?.deriveMessages||!session?.snapshotEvents||!session?.surface?.nodes)throw unavailable();
  signal?.throwIfAborted();
  const completePrompt=joinClientPromptLayers(systemPrompt,developerPrompt);
  // Snapshot is the compatibility read port shared by bundled rc.2 and selected rc.5.
  // Only current surface nodes are inspected, never dormant raw-history instructions.
  const events=session.snapshotEvents();
  const projected=new Map(session.deriveMessages().map(message=>[message.id,message]));
  const nodes=session.surface.nodes.map(seq=>events[seq]).map(event=>({event,message:projected.get(event.data?.message?.id)??event.data?.message}));
  const systems=nodes.filter(({event})=>event.type==='system/message');
  let changed=false;
  const append=(role,content,node)=>{
    signal?.throwIfAborted();
    const message={id:randomUUID(),role,source:{kind:role==='system'?'system-prompt':CLIENT_DEVELOPER_SOURCE},content:content?[{type:'text',text:content}]:[]};
    session.append(`${role}/message`,{turn,step,message},node?{surfaceOp:{op:'replace',startSeq:node.event.seq,endSeq:node.event.seq},sourceEventSeqs:[node.event.seq]}:{surfaceOp:'append'});
    changed=true;
  };
  // Establish the exact Client-owned complete system text before the developer
  // node. Retire older system updates so migrated runtime prose is not retained.
  if(!systems.length)append('system',completePrompt);
  else{
    if(plain(systems[0].message)!==completePrompt)append('system',completePrompt,systems[0]);
    for(const node of systems.slice(1))if(plain(node.message))append('system','',node);
  }
  const developers=nodes.filter(({event,message})=>event.type==='developer/message'&&message?.source?.kind===CLIENT_DEVELOPER_SOURCE);
  // Retire only this plugin's earlier freeform developer records. Tool-registry
  // and other producers' developer events retain their original surface.
  for(const node of developers)if(plain(node.message))append('developer','',node);
  return {changed};
}

/** Install only in the managed Agent scope, before its first follow-up. */
export function installClientPromptLayers(ctx,agent,{systemPrompt,developerPrompt='',resolveDeveloperPrompt}={}){
  if(!ctx?.on||!agent?.session)throw unavailable();
  return ctx.on('agent/request',async(payload,next)=>{
    const configuration=await next();
    if(payload.agent!==agent)return configuration;
    syncClientPromptLayers(agent.session,{systemPrompt,developerPrompt:resolveDeveloperPrompt?await resolveDeveloperPrompt(payload):developerPrompt,turn:payload.turn,step:payload.step,signal:payload.signal});
    return configuration;
  });
}
