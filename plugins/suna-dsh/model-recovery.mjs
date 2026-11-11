import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';

const causes=new Set(['AUTH_REQUIRED','INSUFFICIENT_BALANCE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT','EMPTY_RESPONSE','INVALID_REQUEST','MODEL_ERROR']);
export function modelFailureCode(failure={}){
  if(failure.status===401||failure.status===403||['AUTH','INVALID_CREDENTIAL','AUTHENTICATION','UNAUTHORIZED','AUTH_REQUIRED','PERMISSION_DENIED'].includes(failure.code))return 'AUTH_REQUIRED';
  // PiAi's public failure DTO omits HTTP status. Recognize only its known
  // transport status prefix; never retain or emit the underlying error text.
  if(failure.status===402||['QUOTA','ACCOUNT_QUOTA','INSUFFICIENT_BALANCE','INSUFFICIENT_QUOTA','QUOTA_EXCEEDED','BALANCE'].includes(failure.code)||typeof failure.message==='string'&&/^(?:402(?:\s|:|$)|OpenAI API error \(402\):|Model provider rejected the request \(upstream HTTP 402\b)/.test(failure.message))return 'INSUFFICIENT_BALANCE';
  if(failure.status===429)return 'RATE_LIMIT';
  if(failure.status>=500)return 'SERVER';
  return causes.has(failure.code)?failure.code:'MODEL_ERROR';
}
export function safeRecovery(value){
  if(!value||!Number.isInteger(value.retryCount)||value.retryCount<0||value.retryCount>2||value.maxRetries!==2||!causes.has(value.causeCode))return undefined;
  return {retryCount:value.retryCount,maxRetries:2,causeCode:value.causeCode};
}

/** Scoped public SDK hooks. No user followup replay and no DSH source patch.
 * Owning ordinary failures without next() suppresses provider default retry.
 * Structural context/image recovery remains the official plugin's concern.
 */
export function installModelRecovery(ctx,{run,push,canReply=true,onSupplement=()=>{},sleep=(ms,signal)=>wait(ms,undefined,{signal})}){
  const retries=new Map(),stepEpochs=new Map(),generationEpochs=new Map(),toolDispatches=new Map(),rootDispatches=new Map(),tickets=new WeakMap(),admittedInputs=new Set();
  let replyEpoch=0,currentStep;
  const stepKey=data=>Number.isSafeInteger(data?.turn)&&Number.isSafeInteger(data?.step)?`${data.turn}:${data.step}`:null;
  let visibleSend=false,legitimateSilence=false,supplemented=false,terminal;
  ctx.on('agent/request-error',async(payload,next)=>{
    const {failure={},signal,turn,step}=payload;
    if(signal.aborted||run.canceled||run.deliveryUncertain)return;
    if(['CONTEXT_WINDOW_EXCEEDED','IMAGE_OFFLOAD_REQUIRED'].includes(failure.code))return next();
    const key=`${turn}:${step}`,retryCount=retries.get(key)||0,causeCode=modelFailureCode(failure);
    if(['NO_ADAPTER','UNKNOWN_PROVIDER','UNKNOWN_MODEL','MODEL_NOT_FOUND','UNSUPPORTED_OPTION','UNSUPPORTED_CONTENT'].includes(failure.code)){terminal={code:'RUNTIME_UNAVAILABLE'};return;}
    terminal={code:['AUTH_REQUIRED','INSUFFICIENT_BALANCE'].includes(causeCode)?causeCode:'MODEL_RETRY_EXHAUSTED',recovery:{retryCount,maxRetries:2,causeCode}};
    if(['AUTH_REQUIRED','INSUFFICIENT_BALANCE'].includes(causeCode)||retryCount>=2)return;
    const retry=retryCount+1,delayMs=retry===1?1000:3000;
    push('model-retry',{retry,maxRetries:2,delayMs,causeCode,turn,step});
    try{await sleep(delayMs,signal);}catch(error){if(signal.aborted||run.canceled)return;throw error;}
    if(signal.aborted||run.canceled)return;
    retries.set(key,retry);terminal.recovery.retryCount=retry;
    return {kind:'retry'};
  },{prepend:true});
  ctx.on('agent/assistant-stream',({frame})=>{
    if(frame.type==='start'){
      const key=stepKey(frame);
      if(key&&!generationEpochs.has(key))generationEpochs.set(key,stepEpochs.get(key)??replyEpoch);
    }
  });
  ctx.on('session/event',(_session,event)=>{
    const data=event.data??{},message=data.message??data;
    if(event.type==='step/start'){
      currentStep=stepKey(data);if(currentStep&&!stepEpochs.has(currentStep))stepEpochs.set(currentStep,replyEpoch);
    }
    if(event.type==='user/message'){
      // Only the authenticated endpoint's delivery, consumed by this actual loop,
      // opens a new reply obligation. Sources, TTM, review injections and replay do not.
      const item=run.deliveries?.get(message.id);
      if(canReply&&item?.trustedHuman===true&&!admittedInputs.has(message.id)){
        admittedInputs.add(message.id);replyEpoch++;visibleSend=false;legitimateSilence=false;terminal=undefined;
        if(currentStep)stepEpochs.set(currentStep,replyEpoch);
      }
    }
    if(event.type==='assistant/message')terminal=undefined;
    if(event.type==='tool/call'&&typeof data.callId==='string'&&typeof data.name==='string'){
      const epoch=generationEpochs.get(stepKey(data));
      toolDispatches.set(JSON.stringify([data.callId,data.name]),epoch);
      rootDispatches.set(data.callId,epoch);
    }
  });
  ctx.on('agent/turn-stopping',({agent,signal})=>{
    if(signal.aborted||run.canceled||run.deliveryUncertain||!canReply||visibleSend||legitimateSilence)return;
    if(supplemented){terminal={code:'NO_VISIBLE_OUTPUT',recovery:{retryCount:0,maxRetries:2,causeCode:'EMPTY_RESPONSE'}};return;}
    supplemented=true;
    run.replyOnly=true;onSupplement();
    push('reply-generation',{attempt:1,maxAttempts:1});
    agent.steer({id:randomUUID(),role:'user',content:[{type:'text',text:'最新已接纳的主用户消息尚未获得回复。请结合这些补充及已有工具回执，使用 send_message 回复结果或失败原因；若确实不应回复，可使用 no_reply。不要重复执行已经完成的操作。'}],source:{kind:'user'}});
  });
  return {
    beginTool({callId,name,rootCallId=callId,parent}={}){
      // Public tool/call is appended before dispatch. Capture before invoke's
      // first await; provider IDs may repeat in another model step.
      const epoch=rootCallId!==callId&&parent?rootDispatches.get(rootCallId):toolDispatches.get(JSON.stringify([callId,name]));
      if(epoch===undefined)return;
      const ticket=Object.freeze({});tickets.set(ticket,{epoch,name});return ticket;
    },
    receipt(name,value,terminate,coverage){
      const failed=value?.ok===false||value?.success===false||['failed','cancelled','canceled','error'].includes(value?.status)||value?.error!=null;
      if(name==='send_message'&&(value?.error?.code==='DELIVERY_UNCERTAIN'||value?.error_code==='DELIVERY_UNCERTAIN'||value?.status==='unknown'||value?.status==='pending'))run.deliveryUncertain=true;
      // The callback never looks up a provider ID again. An old in-flight send
      // keeps its old ticket even when a new step reuses that same ID.
      const bound=coverage===undefined?{epoch:replyEpoch,name}:tickets.get(coverage?.ticket);
      if(coverage?.ticket)tickets.delete(coverage.ticket);
      if(!bound||bound.name!==name||bound.epoch!==replyEpoch)return;
      if(!failed&&name==='send_message')visibleSend=true;
      if(!failed&&name==='no_reply')legitimateSilence=true;
    },
    failure({errored=false}={}){
      if(run.canceled)return undefined;
      if(run.deliveryUncertain)return {code:'DELIVERY_UNCERTAIN'};
      if(errored&&terminal)return terminal;
      if(errored&&!supplemented)return undefined;
      return canReply&&!visibleSend&&!legitimateSilence?{code:'NO_VISIBLE_OUTPUT',recovery:{retryCount:0,maxRetries:2,causeCode:'EMPTY_RESPONSE'}}:undefined;
    },
  };
}

// Only these local image/selfie failure identifiers are public. Never forward
// exception text, including the suffix carried by serialized RPC errors.
const imageToolFailures=new Map(Object.entries({
  SELFIE_UNAVAILABLE:'当前角色没有可用的本地形象或形象截图服务；请先配置并加载该角色形象，再使用形象截图。',
  SELFIE_RENDER_REQUIRED:'当前角色形象需要渲染截图服务；请先确认本地形象已成功加载。',
  SELFIE_SOURCE_MISMATCH:'当前角色形象已发生变化，本次截图未采用；请确认当前形象后重新截图。',
  SELFIE_REFERENCES_MISSING:'当前角色没有可用的自拍参考图，请先添加参考图。',
  SELFIE_REFERENCES_CHANGED:'自拍参考图已变更，请重新发起自拍。',
  SELFIE_REWRITE_FAILED:'自拍提示词处理失败，请稍后重试。',
  SELFIE_REWRITE_UNAVAILABLE:'自拍提示词处理服务当前不可用。',
  SELFIE_SELECTION_INVALID:'自拍参考图选择无效，请重新选择。',
  IMAGE_CLI_CONFIGURATION_UNSAFE:'本机生图权限配置未通过安全检查，无法生成图片。',
  IMAGE_CLI_OUTPUT_MISSING:'本机生图未返回原生图片结果，本次未生成图片。',
  IMAGE_OUTPUT_MISSING:'生图服务未返回图片结果。',
  IMAGE_BUSY:'生图服务正忙，请稍后重试。',
  IMAGE_CANCELLED:'本次图片生成已取消。',
  IMAGE_TIMEOUT:'图片生成超时，结果尚未确认；请先检查任务状态，不要自动重复生成。',
  IMAGE_CLI_AUTH_REQUIRED:'本机 Codex 尚未登录，请先完成登录。',
  IMAGE_CLI_UNAVAILABLE:'本机 Codex 生图服务当前不可用。',
  IMAGE_CLI_IMAGE_UNAVAILABLE:'当前本机 Codex 会话不支持原生生图。',
  IMAGE_CLI_GENERATION_FAILED:'本机原生图片生成失败，请稍后重试。',
  IMAGE_CLI_PARAMETER_UNSUPPORTED:'本机生图服务拒绝了图片模型的请求参数，请检查 Codex 与模型兼容性，不要自动改模型或重试。',
  IMAGE_CLI_USAGE_LIMIT:'本机 Codex 生图额度已达到限制，请检查额度并等待恢复，不要自动重试。',
  IMAGE_CLI_REFERENCE_MISMATCH:'生图参考图校验失败，本次结果未采用。',
  IMAGE_CLI_CLEANUP_UNCERTAIN:'生图进程清理尚未确认，请稍后检查服务状态。',
  IMAGE_REFERENCE_INVALID:'生图参考图格式或尺寸无效。',
  IMAGE_REFERENCE_LIMIT:'生图参考图数量超过限制。',
  IMAGE_REFERENCE_UNAVAILABLE:'生图参考图当前不可用。',
  IMAGE_PROVIDER_UNAVAILABLE:'生图服务当前不可用。',
  IMAGE_PROVIDER_AUTH_REJECTED:'生图服务身份验证失败。',
  IMAGE_PROVIDER_CHANGED:'生图服务配置已变更，请重新发起生成。',
  IMAGE_RESULT_UNCERTAIN:'图片生成结果尚未确认，请先检查结果，避免重复生成。',
}));
export function failedToolReceipt(error){
  let code='TOOL_EXECUTION_FAILED';
  try{
    const suppliedCode=error?.code;
    if(typeof suppliedCode==='string'&&imageToolFailures.has(suppliedCode))code=suppliedCode;
    else {
      const message=error?.message;
      if(typeof message!=='string')return {ok:false,error:{code,message:'工具执行失败。'},terminate:false};
      // RPC may serialize Error('CODE: details'). Accept only an exact code at
      // offset zero, terminated by ':' or the actual end of the string.
      const prefix=message.split(':',1)[0];
      if(imageToolFailures.has(prefix))code=prefix;
    }
  }catch{/* Untrusted exception accessors must not replace the safe receipt. */}
  return {ok:false,error:{code,message:imageToolFailures.get(code)??'工具执行失败。'},terminate:false};
}
