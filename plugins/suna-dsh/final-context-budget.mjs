import {randomUUID} from 'node:crypto';
import {wrapClientDeveloperPrompt} from './client-prompt-xml.mjs';

const integer=value=>Number.isSafeInteger(value)&&value>0?value:undefined;
export function inputBudgetFromModel(info={}, {maxTokens}={}){
  const contextWindowTokens=integer(info.context?.contextWindow)||integer(info.contextWindow)||32768;
  const outputReserveTokens=Math.min(contextWindowTokens,integer(maxTokens)||integer(info.defaultMaxTokens)||integer(info.maxTokens)||4096);
  const headroomTokens=Math.max(1024,Math.ceil(contextWindowTokens*.05));
  return {text:{contextWindowTokens,outputReserveTokens,headroomTokens,maxInputTokens:Math.max(0,contextWindowTokens-outputReserveTokens-headroomTokens),historyMaxMessages:32,historyMaxTokens:4096,estimation:'utf8-bytes-conservative',capacitySource:integer(info.context?.contextWindow)||integer(info.contextWindow)?'adapter-catalog':'conservative-fallback'},images:{supported:info.imageInput===true||info.inputModalities?.includes('image')===true,count:16,bytes:8*1024*1024,totalBytes:24*1024*1024,side:4096,historyCount:2,limitSource:'client-transport'}};
}

/** Deliberately conservative local estimate, not a provider tokenizer claim.
 * Inline image bytes are not text tokens. Their visual allowance is separate.
 */
export function estimateRequestTokens(value,{imageDimensions=[]}={}){
  let imageIndex=0;
  const ancestors=new Set();
  function cost(item){
    if(typeof item==='string')return /^data:image\//.test(item)?0:Buffer.byteLength(item,'utf8');
    if(item==null||typeof item!=='object')return 4;
    // JSON serializes shared objects at every occurrence. Only an ancestor
    // reference is a cycle; fail closed instead of undercounting that input.
    if(ancestors.has(item))return Infinity;ancestors.add(item);
    try {
    if(['image','input_image','image_url'].includes(item.type)){
      const dimensions=imageDimensions[imageIndex++]||item.image||item;
      const width=integer(dimensions.width)||4096,height=integer(dimensions.height)||4096;
      return 1024+256*Math.ceil(Math.min(width,4096)/512)*Math.ceil(Math.min(height,4096)/512);
    }
    if(Array.isArray(item))return item.reduce((sum,entry)=>sum+cost(entry)+8,0);
    return Object.entries(item).reduce((sum,[key,entry])=>sum+Buffer.byteLength(key)+cost(entry)+8,0);
    } finally { ancestors.delete(item); }
  }
  return cost(value)+256;
}

export function estimatePreparedInput({prompt,developerPrompt='',inputPrompt,messages=[]},tools){
  // payload.messages is server metadata, not another model conversation.
  const images=messages.flatMap(message=>(message.blocks||[]).filter(block=>block.type==='image'));
  return estimateRequestTokens({system:prompt,developer:wrapClientDeveloperPrompt(developerPrompt),messages:[{role:'user',content:inputPrompt}],tools})+images.reduce((sum,image)=>sum+estimateRequestTokens(image)-256,0);
}

/** Remove only complete older turns from the model surface. Session history
 * remains append-only. The current run and every system message are protected.
 */
export function trimOldestTurn(session,protectedFrom,position){
  const events=session.snapshotEvents(),nodes=session.surface.nodes;
  const turns=new Map();let activeTurn;
  for(const event of events){if(event.type==='turn/start')activeTurn=event.data.turn;const turn=Number.isSafeInteger(event.data?.turn)?event.data.turn:activeTurn;if(Number.isSafeInteger(turn))turns.set(event.seq,turn);if(event.type==='turn/end')activeTurn=undefined;}
  const candidates=new Map();
  for(const seq of nodes){const event=events[seq];if(seq>=protectedFrom||event.type==='system/message')continue;const turn=turns.get(seq);if(!Number.isSafeInteger(turn))continue;const group=candidates.get(turn)||[];group.push(seq);candidates.set(turn,group);}
  for(const [turn,group] of candidates){
    if(!events.some(event=>event.type==='turn/end'&&event.data?.turn===turn&&event.seq<protectedFrom))continue;
    const first=nodes.indexOf(group[0]),last=nodes.indexOf(group.at(-1)),region=nodes.slice(first,last+1);
    if(region.some(seq=>seq>=protectedFrom||events[seq].type==='system/message'||turns.get(seq)!==turn))continue;
    // Whole closed turns retain neither orphan calls nor orphan receipts.
    const current=position||events.findLast(event=>event.type==='step/start')?.data||{turn,step:1};
    session.append('system/message',{turn:current.turn,step:current.step,message:{id:randomUUID(),role:'system',source:{kind:'system-prompt'},content:[]}},{surfaceOp:{op:'replace',startSeq:group[0],endSeq:group.at(-1)},sourceEventSeqs:region});
    return {removedNodes:region.length,startSeq:group[0],endSeq:group.at(-1)};
  }
  return undefined;
}

export function installFinalContextBudget(ctx,{run,session,limits,isAgentLoopRequest,getImageBudget=async()=>({imageTokens:0,inputBudgetExceeded:false}),push=()=>{}}){
  let trims=0,blocked=false;
  ctx.on('llm/stream',(options,next)=>{
    if(String(options.sessionId)!==String(session.id)||typeof isAgentLoopRequest!=='function'||isAgentLoopRequest(options)!==true||options.purpose&&options.purpose!=='conversation')return next();
    return (async function*(){
      const images=await getImageBudget();
      const estimated=estimateRequestTokens({system:options.system,messages:options.messages,tools:options.tools})+images.imageTokens;
      if(estimated<=limits.text.maxInputTokens){yield* next();return;}
      blocked=true;push('context-budget',{estimatedInputTokens:estimated,maxInputTokens:limits.text.maxInputTokens,imageTokens:images.imageTokens,estimation:limits.text.estimation});
      yield {type:'finish',reason:{kind:'error',failure:{code:'SUNA_INPUT_BUDGET',message:'INPUT_CONTEXT_TOO_LARGE'}}};
    })();
  },{prepend:true});
  ctx.on('agent/request-error',async(payload,next)=>{
    if(payload.failure?.code!=='SUNA_INPUT_BUDGET'&&(await getImageBudget({consumeFailure:true})).inputBudgetExceeded!==true)return next();
    if(payload.signal.aborted||run.canceled)return;
    const removed=trims++<1000?trimOldestTurn(session,run.protectedContextFrom,{turn:payload.turn,step:payload.step}):undefined;
    if(removed){blocked=false;push('context-pruned',removed);return {kind:'retry'};}
    if(trims<1000&&(await getImageBudget({dropOldestHistoryImage:true})).droppedHistoryImages>0){blocked=false;push('context-images-pruned',{removedImages:1});return {kind:'retry'};}
    run.budgetFailure='INPUT_CONTEXT_TOO_LARGE';return;
  },{prepend:true});
  return {get blocked(){return blocked;}};
}
