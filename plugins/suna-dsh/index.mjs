import {captureOriginalPrompt,originalPromptRecord} from './original-system-prompt.mjs';
import {createRequire as createAutoReviewRequire} from 'node:module';
import {pathToFileURL as autoReviewFileURL} from 'node:url';
import {realpath as autoReviewRealpath} from 'node:fs/promises';
import {createAutoReviewContext,installOfficialAutoReview} from './auto-review-context.mjs';
import {runtimePermissionCatalog,validateRuntimePermission,applyRuntimePermission,runtimePermissionInstructions} from './runtime-permissions.mjs';
import {createA2aState} from './a2a-state.mjs';
import {createA2aSessions} from './a2a-sessions.mjs';
import {userInput,admitUserInput} from './user-input.mjs';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createModelProviders,describeDshModel} from './model-providers.mjs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {installEphemeralAdapter} from './ephemeral-adapter.mjs';
import {installRegistryAdapters} from './registry-providers.mjs';
import {ttmInput,ttmSource,dispatchTtm} from './ttm-input.mjs';
import {createWorkspaceMapping} from './workspaces.mjs';
import {prepareNativeExecutionPreset,createNativeExecutionCapabilities} from './native-preset.mjs';
import {systemMetricsInstructions} from './system-metrics.mjs';
import {installNativeExecution} from './native-execution.mjs';
import {installRuntimeNativeExecution,createRuntimeNativeLifecycle,RUNTIME_NATIVE_PROTOCOL} from './runtime-native-permissions.mjs';
import {createSessionOwnershipGuard} from './session-ownership.mjs';
import {createNativeToolCatalog} from './native-tools.mjs';
import {createRuntimeUsageTelemetry} from './usage-telemetry.mjs';
import {inputBudgetFromModel,installFinalContextBudget} from './final-context-budget.mjs';
import {installModelRecovery,failedToolReceipt} from './model-recovery.mjs';
import {validateRunTemperature,installRunTemperature} from './run-temperature.mjs';
import {installDshPluginManagement} from './plugin-management-http.mjs';
import {installDshManagementAgentBarrier} from './plugin-management-agent-barrier.mjs';

import {installClientPromptLayers} from './client-prompt-layers.mjs';
import {wrapClientDeveloperPrompt,joinClientPromptLayers} from './client-prompt-xml.mjs';

export const name = 'suna-bridge';
export const inject = ['agents', 'systemPrompt', 'tools', 'sessionPersistence', 'llm', 'workspaceRegistry'];
const API_VERSION = 1;
const PLUGIN_VERSION=JSON.parse(await readFile(new URL('./package.json',import.meta.url),'utf8')).version;
const json = (res, status, value) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value)); };
async function body(req) { let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>2*1024*1024)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
const errorText = error => {let text=String(error?.message || error).replace(/(Bearer\s+|api[_-]?key[=:]\s*)[^\s,]+/ig,'$1[redacted]');for(const [key,value] of Object.entries(process.env))if(value&&(key==='SUNA_MODEL_API_KEY'||/^SUNA_PROVIDER_.*_(API_KEY|IMAGE_TOKEN)$/.test(key)))text=text.split(value).join('[redacted]');return text;};
const string = (value,max=100000) => typeof value==='string' ? value.slice(0,max) : '';
const output = {schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
export const toolSchemas = {
  send_message:{description:'Send a visible message to the current conversation. Use emojiId from list_emojis to send an actual stored sticker, optionally with content. This is the only way to speak to users.',parameters:{type:'object',properties:{emojiId:{type:'string',minLength:1},content:{type:'string',minLength:1},text:{type:'string',minLength:1},conversationId:{type:'string'},replyToMessageId:{type:'string'},mentionIds:{type:'array',items:{type:'string'}},idempotencyKey:{type:'string'},idempotency_key:{type:'string'},terminate:{type:'boolean',description:'false 表示发送进度后继续处理；true 表示最终回复后结束本轮；省略沿用配置默认值。'}},anyOf:[{required:['content']},{required:['text']},{required:['emojiId']}],additionalProperties:false}},
  list_emojis:{description:'Search available stickers belonging to the current character. Use the returned id as send_message emojiId.',parameters:{type:'object',properties:{query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},additionalProperties:false}},
  no_reply:{description:'Finish without a visible reply when participation is unnecessary.',parameters:{type:'object',properties:{reason:{type:'string'}},additionalProperties:false}},
  add_work_memory:{description:'Record a useful memory belonging to this character.',parameters:{type:'object',properties:{text:{type:'string'},content:{type:'string'},score:{description:'Legacy alias for impression_score.'},impression_score:{description:'Expected integer 1–10, chosen by the character. Persist the supplied value without client-side rescoring.'}},anyOf:[{required:['content']},{required:['text']}],additionalProperties:false}},
  recall_memory:{description:'Find memories belonging to the current character.',parameters:{type:'object',properties:{query:{type:'string'},date:{type:'array',items:{type:'string'},minItems:2,maxItems:2}},additionalProperties:false}},
  add_user_profile:{description:'Update the current speaker aggregate profile or skip this optional decision. The Host binds the observer and speaker; never select another identity.',parameters:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['record','skip']},profile:{type:['string','null'],maxLength:262144,description:'完整更新后的聚合画像；缺失/null保留，空文本清空。'},addressNames:{type:['array','null'],maxItems:256,items:{type:'string',maxLength:512},description:'完整有序称呼，首项优先；缺失/null保留，空数组清空。'}},required:['action']}},
  update_emotion:{description:'Update the character emotion state.',parameters:{type:'object',properties:{content:{type:'string'},emotion:{type:'string'},description:{type:'string'},pad:{type:'object',properties:{pleasure:{type:'number',minimum:-1,maximum:1},arousal:{type:'number',minimum:-1,maximum:1},dominance:{type:'number',minimum:-1,maximum:1},p:{type:'number',minimum:-1,maximum:1},a:{type:'number',minimum:-1,maximum:1},d:{type:'number',minimum:-1,maximum:1}},anyOf:[{required:['pleasure','arousal','dominance']},{required:['p','a','d']}],additionalProperties:false}},additionalProperties:false}},
  interact_env:{description:'Submit a first-person action to the environment Worker and receive its actual state update.',parameters:{type:'object',properties:{des:{type:'string',minLength:1}},required:['des'],additionalProperties:false}},
  cron:{description:'Manage persistent scheduled tasks belonging to the current character.',parameters:{type:'object',properties:{mode:{type:'string',enum:['add','fetch','update','delete']},id:{type:'string',minLength:1,description:'Required for update and delete; omit for add and fetch.'},content:{type:'string',minLength:1,description:'Required for add; update preserves omitted fields.'},cron:{type:'string',minLength:1,description:'Cron expression, required for add.'},enable:{type:'boolean'}},required:['mode'],additionalProperties:false}},
  get_selfie:{description:'Get an existing image of the current character. Availability depends on the actual character asset.',parameters:{type:'object',properties:{},additionalProperties:false}},
  screenshot:{description:'Capture all connected displays as separate model input images in this run, only when this character and conversation have screen permission.',parameters:{type:'object',properties:{},additionalProperties:false}},
  suna_webserach:{description:'Search public web information using the configured Client search adapter.',parameters:{type:'object',properties:{query:{type:'string',minLength:1}},required:['query'],additionalProperties:false}},
  suna_webfetch:{description:'Read a known HTTP(S) page using the configured Client fetch adapter.',parameters:{type:'object',properties:{url:{type:'string',pattern:'^https?://',minLength:1}},required:['url'],additionalProperties:false}},
  // Historical schema lookup remains compatible; tools are registered only
  // from the Client's explicit request list, never by enumerating this table.
  websearch:{description:'Search public web information using the configured real search adapter.',parameters:{type:'object',properties:{query:{type:'string',minLength:1}},required:['query'],additionalProperties:false}},
  webfetch:{description:'Read a known HTTP(S) page using the configured real fetch adapter.',parameters:{type:'object',properties:{url:{type:'string',pattern:'^https?://',minLength:1}},required:['url'],additionalProperties:false}},
};

/** A real Cordis plugin. Model execution, tools, prompts and persistence belong to DSH core. */
export async function apply(ctx, config={}) {
  let llmModulePath=config.llmModulePath;if(!llmModulePath&&process.argv[1])try{llmModulePath=createRequire(await realpath(process.argv[1])).resolve('@deepseek-ai/dsh-llm');}catch{}
  const isAgentLoopRequest=llmModulePath?(await import(pathToFileURL(llmModulePath).href)).isAgentLoopRequest:undefined;
  await installRegistryAdapters(ctx,config.registryProviders);
  const imageAdapters=(await Promise.all((config.ephemeralProviders??(config.ephemeralProvider?[config.ephemeralProvider]:[])).map(value=>installEphemeralAdapter(ctx,value)))).filter(Boolean);
  const imageAdapter={budgetState:async (run,options)=>{const states=(await Promise.all(imageAdapters.map(adapter=>adapter.budgetState?.(run,options)))).filter(Boolean);return {imageTokens:states.reduce((sum,state)=>sum+state.imageTokens,0),inputBudgetExceeded:states.some(state=>state.inputBudgetExceeded),droppedHistoryImages:states.reduce((sum,state)=>sum+(state.droppedHistoryImages||0),0)};},supports:provider=>imageAdapters.some(adapter=>adapter.supports(provider)),start:async(...args)=>{for(const adapter of imageAdapters)await adapter.start(...args);},restrict:async(...args)=>{for(const adapter of imageAdapters)await adapter.restrict(...args);},end:async(...args)=>{const settled=await Promise.allSettled(imageAdapters.map(adapter=>adapter.end(...args)));const failed=settled.find(result=>result.status==='rejected');if(failed)throw failed.reason;}};
  let runtimeVersion;try{const metadata=JSON.parse(await readFile(path.resolve(path.dirname(process.argv[1]),'../package.json'),'utf8'));if(metadata.name?.startsWith('@deepseek-ai/dsh'))runtimeVersion=metadata.version;}catch{}
  const home=path.resolve(process.env.DSH_HOME || path.join(os.homedir(),'.dsh'));
  const root=path.join(home,'suna-bridge');await mkdir(root,{recursive:true,mode:0o700});
  const modelProviders=config.modelProviders?createModelProviders(ctx,config.modelProviders,root):null;
  if(modelProviders){await modelProviders.ready();if(modelProviders.imageAdapter)imageAdapters.push(modelProviders.imageAdapter);}
  ctx.on('dispose',()=>modelProviders?.close());
  const discovery=path.resolve(config.discoveryFile || process.env.SUNA_DSH_DISCOVERY || path.join(root,'connection.json'));
  const token=process.env.SUNA_DSH_BRIDGE_TOKEN || randomBytes(32).toString('hex');
  const runs=new Map(), active=new Map(), pending=new Map(),nativePending=new Map(),executions=new Set();let closing=false;
  const pluginManagement=installDshPluginManagement(ctx,config.pluginManagement,{runtimeVersion,bridgeVersion:PLUGIN_VERSION,isBusy:()=>closing||active.size>0||executions.size>0||ctx.agents.list().some(agent=>agent.status!=='idle')});
  if(config.pluginManagement&&['0.2.1-rc.5','0.2.2-rc.1'].includes(runtimeVersion))installDshManagementAgentBarrier(ctx,pluginManagement);
  const contextFile=path.join(root,'contexts.json');
  let contexts={};try{contexts=JSON.parse(await readFile(contextFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const workspaceMapping=createWorkspaceMapping(ctx,contexts);
  const nativeCapabilities=createNativeExecutionCapabilities();
  const nativeToolCatalog=createNativeToolCatalog(ctx,{runtimeVersion,pluginVersion:PLUGIN_VERSION,executionCapabilities:()=>nativeCapabilities.read()});
  ctx.on('dispose',()=>nativeCapabilities.close());
  ctx.on('dispose',()=>nativeToolCatalog.close());
  const autoReviewContext=createAutoReviewContext(ctx);ctx.on('dispose',()=>autoReviewContext.close());const autoReviewResolver=createAutoReviewRequire(autoReviewFileURL(await autoReviewRealpath(process.argv[1])));const autoReviewSupported=await installOfficialAutoReview(ctx,autoReviewContext,{load:name=>import(autoReviewFileURL(autoReviewResolver.resolve(name)).href)});
  const loadOriginalSdk=name=>import(autoReviewFileURL(autoReviewResolver.resolve(name)).href);
  const {renderPrompt:renderNativePrompt}=await loadOriginalSdk('@deepseek-ai/dsh-system-prompt');
  const {createScope:originalCaptureScope,bindScopeParent:bindOriginalScopeParent,scopeParentOf:originalScopeParentOf}=await loadOriginalSdk('@deepseek-ai/dsh-scope');
  const originalCapturePlugins=await Promise.all(['@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-session','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-agent-loop'].map(loadOriginalSdk));
  const ownership=createSessionOwnershipGuard(ctx,{isManagedSession:id=>Object.values(contexts).includes(id)});
  let persistTail=Promise.resolve();
  const persist=()=>{persistTail=persistTail.then(async()=>{const tmp=contextFile+'.tmp';await writeFile(tmp,JSON.stringify(contexts),{mode:0o600});await rename(tmp,contextFile);});return persistTail;};
  const push=(run,type,data={})=>{run.sequence++;run.events.push({sequence:run.sequence,type,...data});if(run.events.length>2000)run.events.shift();run.updatedAt=Date.now();};
  // The public waterfall also covers auxiliary compaction calls. Binding by an
  // executing SUNA run excludes GUI history reads and other Agents entirely.
  const telemetryBySession=new Map();
  ctx.on('llm/stream',(options,next)=>telemetryBySession.get(String(options.sessionId))?.stream(options,next) ?? next());
  const resolveGui=()=>{try{return ctx.get('connection')?.authenticatedUrl(ctx.get('webApp')?.getAdvertisedUrl() || ctx.get('webServer')?.getOrigin());}catch{return null;}};
  const invoke=(run,name,args,signal,timeoutMs=120000)=>new Promise((resolve,reject)=>{
    const callId=randomUUID();let timer;
    const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);pending.delete(callId);error?reject(error):resolve(value&&typeof value==='object'?value:{result:value??null});};
    const onAbort=()=>finish(new Error('Tool call canceled'));
    pending.set(callId,{runId:run.id,finish});
    timer=setTimeout(()=>finish(new Error('SUNA client did not settle the tool call')),timeoutMs);
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)return onAbort();
    push(run,'tool-call',{callId,name,args,authorityRestricted:run.authorityRestricted===true});
  });
  const authorizeNative=(run,spec,{signal})=>new Promise((resolve,reject)=>{
    const requestId=randomUUID();let timer,settled=false;
    const finish=decision=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',onAbort);nativePending.delete(requestId);resolve(decision);};
    const onAbort=()=>finish({allowed:false});
    nativePending.set(requestId,{runId:run.id,finish});
    timer=setTimeout(onAbort,5000);signal.addEventListener('abort',onAbort,{once:true});
    if(signal.aborted||run.nativeRevoked||run.canceled||run.settling||run.authorityRestricted)return onAbort();
    push(run,'native-tool-authorization',{requestId,spec});
  });
  const a2aPersistence=await createA2aState(path.join(root,'a2a-state'));const a2aSessions=createA2aSessions({...a2aPersistence,isOwnedSession:id=>Object.values(contexts).includes(id)});
  function revokeNative(run){run.nativeLifecycle?.close();run.nativeRevoked=true;run.nativeController?.abort();run.nativeExecution?.revoke();for(const call of nativePending.values())if(call.runId===run.id)call.finish({allowed:false});}
  async function execute(run,request,probe=false){
    let handle,reservation,nativePreset,recovery,disposeTemperature;
    try{
      validateRunTemperature(request,config);
      const sessionId=contexts[request.contextId] || `suna-${createHash('sha256').update(request.contextId).digest('hex').slice(0,32)}`;
      run.sessionId=sessionId;
      reservation=ownership.reserve(sessionId);
      run.telemetry=createRuntimeUsageTelemetry({runId:run.id,sessionId,provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort,onCall:call=>{push(run,'model-call',{call});}});
      telemetryBySession.set(sessionId,run.telemetry);
      if(request.inputSource?.kind==='suna-ttuf'||request.a2a)run.authorityRestricted=true;
      if(!probe){await imageAdapter?.start(run,request);if(run.authorityRestricted)await imageAdapter?.restrict(run);}
      const executionPreset=request.runtimePermission?validateRuntimePermission(request.runtimePermission,runtimePermissionCatalog(ctx,autoReviewSupported)):undefined;
      const nativeRequest=request.nativeTools;
      if(nativeRequest){
        if(!['SUNA_NATIVE_AUTH_V1',RUNTIME_NATIVE_PROTOCOL].includes(nativeRequest.protocol)||!Array.isArray(nativeRequest.allow)||nativeRequest.allow.length>512||nativeRequest.allow.some(name=>typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_.:-]{0,199}$/.test(name)))throw new Error('Invalid native execution request');
        const catalog=await nativeToolCatalog.read();
        if(nativeRequest.catalogRevision!==catalog.catalogRevision)throw new Error('Native tool catalog changed');
        if(nativeRequest.protocol===RUNTIME_NATIVE_PROTOCOL&&(executionPreset===undefined||nativeRequest.allow.some(name=>!catalog.tools.some(tool=>tool.name===name&&tool.available===true))))throw new Error('Runtime native tools are unavailable');
        nativePreset=await prepareNativeExecutionPreset(ctx,{permissionPreset:executionPreset,allow:[...new Set(nativeRequest.allow)].filter(name=>!(request.tools||[]).includes(name)),workspaceRoot:request.cwd,signal:run.nativeController.signal,authorize:()=>!run.nativeRevoked&&!run.authorityRestricted&&!run.canceled&&!run.settling});
      }
      const setup=async(agentCtx,agent)=>{
        reservation.mark(agent);
        agentCtx.effect(()=>autoReviewContext.bind(agent,{provider:request.provider||'deepseek-official',model:request.model||'deepseek-chat',clientNames:request.tools||[],managedContext:request.inputSource?.kind==='suna-context',signal:run.nativeController.signal,current:()=>!run.nativeRevoked&&!run.canceled&&!run.settling}));
        run.protectedContextFrom=agent.session.snapshotEvents().length;
        const modelInfo=await ctx.llm.resolveModelInfo(request.provider||'deepseek-official',request.model||'deepseek-chat');
        disposeTemperature=installRunTemperature(agentCtx,request);
        const clientToolDisposers=new Map();
        const replyTools=(request.tools||[]).filter(name=>['send_message','no_reply',...(request.a2a?['end_a2a_session']:[])].includes(name));
        recovery=installModelRecovery(agentCtx,{run,push:(type,value)=>push(run,type,value),canReply:!probe&&!request.a2a&&(request.tools||[]).includes('send_message'),onSupplement:()=>{revokeNative(run);agentCtx.tools.restrict({allow:[]});for(const [name,dispose] of clientToolDisposers)if(!replyTools.includes(name))dispose();}});
        installFinalContextBudget(agentCtx,{run,isAgentLoopRequest,getImageBudget:options=>imageAdapter.budgetState(run,options),session:agent.session,limits:inputBudgetFromModel(modelInfo,{maxTokens:request.maxTokens||4096}),push:(type,value)=>push(run,type,value)});
        agentCtx.tools.guard(exec=>run.replyOnly&&!replyTools.includes(exec.name)?'补充回复阶段仅允许发送回复。':undefined);
        // Bind only explicitly selected, mounted runtime tools; DSH owns their permissions.
        const native=await nativePreset?.mount(agentCtx,agent)??{enabledNames:[],unavailable:[]};
        if(executionPreset){const applied=applyRuntimePermission(agentCtx,agent,executionPreset,{explicit:request.runtimePermission.explicit===true,newSession:!contexts[request.contextId]});push(run,'runtime-permission-applied',applied);}
        // A complete section intentionally suppresses every inherited section.
        // Include reviewed backend guidance here only after Bash really mounts.
        const characterPrompt=[request.prompt || 'You are a character in 沙之书. Use send_message to speak; final assistant text is internal.',...(executionPreset&&native.enabledNames.includes('bash')?[runtimePermissionInstructions(agentCtx,agent)]:[])].join('\n\n');
        if(request.developerPrompt!==undefined&&typeof request.developerPrompt!=='string')throw new TypeError('Invalid Client developer prompt');
        let developerPrompt=wrapClientDeveloperPrompt([request.developerPrompt??'',...(!executionPreset&&native.enabledNames.includes('bash')?[systemMetricsInstructions]:[])].filter(Boolean).join('\n\n'));
        let originalDeveloper;
        if(request.developerPromptSource==='dsh-original'){
          agentCtx.systemPrompt.suppressRuntimeContext();
          agentCtx.on('system-prompt/assemble',async(assembly,context,next)=>{
            const transformed=await next();
            originalDeveloper=originalPromptRecord(transformed,{renderPrompt:renderNativePrompt,runtimeVersion});
            if(request.developerPromptExtras!==undefined&&(!Array.isArray(request.developerPromptExtras)||request.developerPromptExtras.length>16||request.developerPromptExtras.some(v=>typeof v!=='string'||v.length>50000)))throw Error('Invalid Host developer extras');
            developerPrompt=wrapClientDeveloperPrompt([originalDeveloper.text,...(request.developerPromptExtras??[])].join('\n\n'));
            return {...transformed,sections:[{name:'suna:character',interpolate:false,text:joinClientPromptLayers(characterPrompt,developerPrompt)}]};
          });
        }else agentCtx.systemPrompt.section({name:'suna:character',order:0,complete:true,interpolate:false,text:joinClientPromptLayers(characterPrompt,developerPrompt)});
        installClientPromptLayers(agentCtx,agent,{systemPrompt:characterPrompt,developerPrompt,resolveDeveloperPrompt:request.developerPromptSource==='dsh-original'?async()=>{
          if(!originalDeveloper)throw Error('DSH_ORIGINAL_PROMPT_UNAVAILABLE');return developerPrompt;
        }:undefined});
        agentCtx.tools.restrict({allow:native.enabledNames});
        if(native.unavailable.length)push(run,'native-tools-unavailable',{tools:native.unavailable});
        run.nativeExecution=(nativeRequest?.protocol===RUNTIME_NATIVE_PROTOCOL?installRuntimeNativeExecution:installNativeExecution)(agentCtx,{officialPermissions:executionPreset!==undefined,run,agent,enabledNames:native.enabledNames,signal:run.nativeController.signal,clientNames:request.tools||[],authorize:(spec,options)=>authorizeNative(run,spec,options)});
        if(run.nativeRevoked)run.nativeExecution.revoke();
        for(const name of request.tools || []){
          const schema=request.toolSchemas?.[name] || toolSchemas[name];
          if(!schema)throw new Error(`Unknown SUNA tool: ${name}`);
          const dispose=agentCtx.tools.register({name,description:request.toolDescriptions?.[name] || schema.description || name,parameters:schema.parameters,output,execute:async(args,exec)=>{
            const batch=run.toolBatch,coverageTicket=recovery.beginTool(exec);
            try{
              if(run.replyOnly&&!replyTools.includes(name))return failedToolReceipt();
              if(run.deliveryUncertain&&name==='send_message')return {ok:false,error:{code:'DELIVERY_UNCERTAIN',message:'消息投递状态尚未确认。'},terminate:false};
              const timeoutMs=request.toolTimeouts?.[name]??120000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>600000)throw new Error('Invalid client tool timeout');const value=await invoke(run,name,args,exec.signal,timeoutMs);
              const failed=value?.ok===false||value?.success===false||['failed','cancelled','canceled','error'].includes(value?.status)||value?.error!=null;
              const configured=request.toolTerminations?.[name] ?? (name==='no_reply'||request.terminalTools?.includes(name));
              const terminate=!failed&&(typeof value?.terminate==='boolean'?value.terminate:configured===true);
              recovery.receipt(request.a2a&&name==='end_a2a_session'?'no_reply':name,value,terminate,{ticket:coverageTicket});
              batch?.results.set(exec.callId,terminate);
              push(run,'tool-receipt',{name,callId:exec.callId,terminate});
              // DSH itself ORs concludesTurn across a step. Aggregate first so
              // a sibling false/error receipt still gets its next model step.
              // This never cancels other tools or closes the durable Session.
              if(batch?.ids.length&&batch.ids.every(id=>batch.results.get(id)===true))exec.concludeTurn();
              return value;
            }catch(error){batch?.results.set(exec.callId,false);if(exec.signal?.aborted||run.canceled)throw error;if(name==='send_message')run.deliveryUncertain=true;const value=failedToolReceipt(error);push(run,'tool-receipt',{name,callId:exec.callId,terminate:false,failed:true});return value;}
          }});clientToolDisposers.set(name,dispose);
        }
        agentCtx.on('agent/assistant-stream',({frame})=>{run.telemetry.frame(frame);if(frame.type==='chunk')push(run,'stream',{chunk:frame.chunk});});
        agentCtx.on('tools/result',(exec,result)=>{if(result.isError)run.toolBatch?.results.set(exec.callId,false);push(run,'tool-result',{name:exec.name,callId:exec.callId,isError:result.isError,concludesTurn:result.concludesTurn===true});});
        agentCtx.on('agent/pre-step',async(payload,next)=>{if(run.replyOnly){if(run.replyGenerationStarted)throw new Error('NO_VISIBLE_OUTPUT');run.replyGenerationStarted=true;}if(run.deliveryUncertain)throw Object.assign(new Error('DELIVERY_UNCERTAIN'),{code:'DELIVERY_UNCERTAIN'});if(payload.step>Math.min(100,Math.max(1,request.maxSteps || 24)))throw new Error('DSH turn exceeded its step limit');return next();});
        agentCtx.on('session/event',(_session,event)=>{
          run.telemetry.session(event);
          if(event.type==='user/message'){
            const message=event.data?.message||event.data,item=run.deliveries?.get(message.id);
            if(request.a2a||request.inputSource?.kind==='suna-context'){const source=message.source??{},content=(message.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('');push(run,'context-provenance',{contextId:request.contextId,sessionId:run.sessionId,contentSha256:createHash('sha256').update(content).digest('hex'),source:{kind:source.kind,...(source.form?{form:source.form}:{}),...(source.rpcId?{rpcId:source.rpcId}:{}),...(source.senderSessionId?{senderSessionId:source.senderSessionId}:{})},hasPrincipal:Object.hasOwn(source,'principal')});}
            if(message.id===run.inputMessageId&&!run.inputAdmitted){
              run.inputAdmitted=true;
              push(run,'input-admitted',{contextId:request.contextId,sessionId:run.sessionId,messageId:message.id,...(request.a2a?{a2aSource:{kind:message.source?.kind,form:message.source?.form,senderSessionId:message.source?.senderSessionId,hasPrincipal:Object.hasOwn(message.source??{},'principal'),hasRpcId:Object.hasOwn(message.source??{},'rpcId')}}:{}),inputDigest:createHash('sha256').update(string(request.input || request.messages?.at(-1)?.text || request.messages?.at(-1)?.content,2*1024*1024)).digest('hex')});
            }
            if(item){item.admitted=true;if(item.trustedHuman)push(run,'user-input-admitted',{deliveryId:item.deliveryId,contextId:request.contextId});else push(run,'ttm-admitted',{deliveryId:item.deliveryId,mode:item.mode,source:item.message.source,authorityRestricted:true});}
          }
          if(event.type==='assistant/message'){
            const message=event.data?.message || event.data;
            const calls=(message?.content || []).filter(block=>block.type==='tool-call');
            run.toolBatch={ids:calls.map(call=>call.id),results:new Map()};
            const text=(message?.content || []).filter(b=>b.type==='text').map(b=>b.text).join('');
            if(text)run.text+=text;
          }
          if(event.type==='turn/end')run.turnEnd=event.data?.reason;
        });
      };
      const agentOptions={provider:request.provider || 'deepseek-official',model:request.model || 'deepseek-chat',...(request.reasoningEffort?{reasoningEffort:request.reasoningEffort}:{}),maxTokens:request.maxTokens || 4096};
      reservation.authorizeSetup(setup);
      handle=contexts[request.contextId]
        ? await ctx.agents.resume({resumeSessionId:sessionId,agentOptions,setup})
        : await ctx.agents.create({sessionId,agentOptions,meta:{cwd:request.cwd || process.cwd()},setup});
      contexts[request.contextId]=sessionId;await persist();reservation.confirmPersisted();run.handle=handle;
      if(request.workspaceTitle)await workspaceMapping.attach({cwd:request.cwd,title:request.workspaceTitle},sessionId);
      if(run.canceled){handle.agent.cancel({kind:'user'});run.status='canceled';return;}
      if(probe){
        const assembly=await handle.agent.ctx.systemPrompt.assemble({agent:handle.agent,scope:handle.agent});
        run.probe={agentCreated:true,persistence:true,promptSections:assembly.sections?.map(s=>s.name),tools:assembly.tools?.map(t=>t.name)};
      }else{
        const text=string(request.input || request.messages?.at(-1)?.text || request.messages?.at(-1)?.content,2*1024*1024);
        if(!text)throw new Error('Message input is empty');
        run.inputMessageId=randomUUID();
        run.telemetry.activate();
        if(request.runtimeReviewInstruction&&!request.a2a&&!run.authorityRestricted){const instruction=request.runtimeReviewInstruction;if(typeof instruction.id!=='string'||instruction.id.length>200||typeof instruction.text!=='string'||instruction.text.length>200000)throw new Error('Invalid runtime review instruction');handle.agent.inject({id:randomUUID(),role:'user',content:[{type:'text',text:instruction.text}],source:{kind:'user',rpcId:'suna:'+instruction.id}});}
        handle.agent.followup({id:run.inputMessageId,role:'user',content:[{type:'text',text}],source:request.a2a?{kind:'agent-message',form:'relay',senderSessionId:request.a2a.senderSessionId}:request.inputSource?.kind==='suna-ttuf'?ttmSource(request.inputSource):request.inputSource?.kind==='suna-context'?{kind:'suna-context',form:'notice',summary:'Client conversation context'}:{kind:'user'}});
        run.acceptingInput=true;
        for(const item of run.pendingInputs||[])dispatchTtm(run,item);run.pendingInputs=[];
        await handle.agent.whenIdle();
        run.acceptingInput=false;
        if(run.budgetFailure)throw Object.assign(new Error(run.budgetFailure),{code:run.budgetFailure});
        const failure=recovery.failure({errored:run.turnEnd?.kind==='error'});
        if(failure)throw Object.assign(new Error(failure.code),failure);
        if(run.turnEnd?.kind==='error')throw new Error('DSH_MODEL_FAILED');
      }
      run.status=run.canceled?'canceled':'completed';
    }catch(error){run.status=run.canceled?'canceled':'failed';run.error=errorText(error);if(error.recovery||['DELIVERY_UNCERTAIN','RUNTIME_UNAVAILABLE','INPUT_CONTEXT_TOO_LARGE','MODEL_TEMPERATURE_INVALID','MODEL_TEMPERATURE_UNSUPPORTED','MODEL_TEMPERATURE_ROUTE_CHANGED'].includes(error.code)){run.errorCode=error.code;run.recovery=error.recovery;}push(run,'error',{message:run.error,code:run.errorCode,recovery:run.recovery});}
    finally{
      disposeTemperature?.();
      run.acceptingInput=false;run.settling=true;revokeNative(run);
      for(const item of run.deliveries?.values()||[])if(item.receipt?.accepted&&!item.admitted)push(run,item.trustedHuman?'user-input-unconsumed':'ttm-unconsumed',{deliveryId:item.deliveryId,mode:item.mode,source:item.message.source,contextId:request.contextId});
      try{if(handle)await handle.dispose();}catch(error){run.error ||= errorText(error);run.status='failed';if(request.a2a)run.a2aCleanupFailed=true;}
      reservation?.release();
      try{await nativePreset?.close();}catch{run.error||='Native execution preset cleanup failed';run.status='failed';}
      try{await imageAdapter?.end(run);}catch{run.error ||= 'Ephemeral run cleanup failed';run.status='failed';}
      run.telemetry?.finish(run.status);
      if(telemetryBySession.get(run.sessionId)===run.telemetry)telemetryBySession.delete(run.sessionId);
      const calls=run.telemetry?.calls() ?? [];
      if(calls.length){run.usage={};for(const [key,field] of Object.entries({inputTokens:'input',outputTokens:'output',cacheReadTokens:'cacheRead',cacheWriteTokens:'cacheWrite',totalTokens:'total'}))run.usage[key]=calls.every(call=>call.usage[field]!==null)?calls.reduce((sum,call)=>sum+call.usage[field],0):null;}
      delete run.handle;active.delete(request.contextId);run.settled=true;a2aSessions.settled(run);push(run,'done',{status:run.status,text:run.text,sessionId:run.sessionId,error:run.error,code:run.errorCode,recovery:run.recovery,probe:run.probe});
    }
  }
  function cancel(run){run.canceled=true;revokeNative(run);run.handle?.agent.cancel({kind:'user'});for(const call of pending.values())if(call.runId===run.id)call.finish(new Error('Run canceled'));}
  const server=http.createServer(async(req,res)=>{
    try{
      if(closing)return json(res,503,{error:'DSH bridge is closing'});
      const supplied=Buffer.from((req.headers.authorization || '').replace(/^Bearer /,''));const expected=Buffer.from(token);
      if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected))return json(res,401,{error:'Unauthorized'});
      if(req.headers.origin){const origin=new URL(req.headers.origin);if(!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))return json(res,403,{error:'Origin rejected'});}
      const url=new URL(req.url,'http://127.0.0.1');
      if(await pluginManagement.handle(req,res,url))return;
      if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true,apiVersion:API_VERSION,pluginVersion:PLUGIN_VERSION,runtimeVersion,pid:process.pid,a2aRuntimeId:a2aSessions.runtimeId,capabilities:['agents','tools','prompt','persistence','cancel','gui','ttm','tool-authority-claim','native-tools-auth-v1',...(autoReviewSupported?['runtime-permissions-v1','runtime-native-permissions-v2']:[]),'model-recovery-v1','client-tool-timeouts-v1','client-prompt-layers-v1','original-system-prompt-v1','temperature-v1','direct-user-steer-v1','a2a-sessions-v1','a2a-intrinsic-tools-v1',...(typeof isAgentLoopRequest==='function'?['context-budget-v1']:[]),...pluginManagement.health().capabilities],...Object.fromEntries(Object.entries(pluginManagement.health()).filter(([key])=>key!=='capabilities')),activeRuns:active.size});
      if(req.method==='POST'&&url.pathname==='/workspaces')return json(res,200,await workspaceMapping.sync((await body(req)).workspaces));
      if(req.method==='GET'&&url.pathname==='/native-tools')return json(res,200,await nativeToolCatalog.read());
      if(req.method==='GET'&&url.pathname==='/permission-presets')return json(res,200,runtimePermissionCatalog(ctx,autoReviewSupported));
      if(req.method==='GET'&&url.pathname==='/gui')return json(res,200,{url:resolveGui()});
      if(req.method==='GET'&&url.pathname==='/model-catalog'){const providers=[];for(const p of ctx.llm.listProviders().filter(p=>!['suna-openai','suna-model'].includes(p.id)&&!p.id.startsWith('suna-ephemeral-')&&!p.id.startsWith('suna-api-'))){try{const models=await ctx.llm.listModels(p.id);providers.push({id:p.id,name:p.name,models:await Promise.all(models.map(m=>describeDshModel(ctx,p.id,m)))});}catch{providers.push({id:p.id,name:p.name,models:[],unavailable:true});}}return json(res,200,{providers});}
      if(req.method==='GET'&&url.pathname==='/openai-models'){if(!modelProviders)return json(res,409,{error:'请先配置 OpenAI 授权'});return json(res,200,await modelProviders.liveModels());}
      if(url.pathname==='/openai-auth'){if(!modelProviders)return json(res,409,{error:'当前 DSH 不支持沙之书 OpenAI 授权'});if(req.method==='GET')return json(res,200,await modelProviders.status());if(req.method==='POST'){const input=await body(req);return json(res,200,await (input.action==='start'?modelProviders.start():modelProviders.respond(input)));}}
      if(req.method==='GET'&&url.pathname==='/model-info'){
        const provider=string(url.searchParams.get('provider'),300),model=string(url.searchParams.get('model'),300);
        if(!provider||!model)return json(res,400,{error:'Exact provider and model are required'});
        const info=await ctx.llm.resolveModelInfo(provider,model);
        const known=Array.isArray(info.inputModalities),inputModalities=known?[...info.inputModalities]:[];
        return json(res,200,{provider:info.provider,model:info.id,inputModalities,known,imageInput:known&&inputModalities.includes('image'),...(info.context?.contextWindow?{contextWindow:info.context.contextWindow}:{}),...(info.defaultMaxTokens?{maxTokens:info.defaultMaxTokens}:{})});
      }
      if(req.method==='POST'&&url.pathname==='/a2a/end')return json(res,200,await a2aSessions.end(await body(req)));
      if(req.method==='POST'&&url.pathname==='/user-inputs'){const item=userInput(await body(req));if(runs.get(active.get(item.contextId))?.a2a)return json(res,403,{error:'A2A contexts do not accept human input'});return json(res,202,await admitUserInput(runs.get(active.get(item.contextId)),item,push));}
      if(req.method==='POST'&&url.pathname==='/inputs'){
        const value=await body(req),item=ttmInput(value);if(typeof value.contextId!=='string'||!value.contextId.trim()||value.contextId.length>300)return json(res,400,{error:'Invalid TTM contextId'});const contextId=value.contextId,run=runs.get(active.get(contextId));
        if(!run)return json(res,200,{accepted:false,reason:'idle',appliedMode:null,queued:false,deliveryId:item.deliveryId});
        if(run.a2a)return json(res,403,{error:'A2A contexts do not accept TTM'});
        if(run.canceled||run.settling||run.status!=='running'||run.acceptingInput===false)return json(res,200,{accepted:false,reason:'settling',appliedMode:null,queued:false,deliveryId:item.deliveryId});
        run.deliveries ||= new Map();const duplicate=run.deliveries.get(item.message.id);
        if(duplicate){if(JSON.stringify(duplicate.message)!==JSON.stringify(item.message)||duplicate.mode!==item.mode)return json(res,409,{error:'TTM delivery ID already has different content'});return json(res,200,{...await duplicate.ready,duplicate:true});}
        if(run.deliveries.size>=200)return json(res,429,{error:'Too many TTM inputs in this run'});
        // Reserve before awaiting: concurrent retries must never inject twice.
        run.deliveries.set(item.message.id,item);run.authorityRestricted=true;revokeNative(run);
        item.ready=(async()=>{
          // Clear pixels/capture before admitting system input; do not cancel the agent.
          await imageAdapter?.restrict(run);
          if(run.canceled||run.settling||run.status!=='running'||run.acceptingInput===false)return item.receipt={accepted:false,reason:'settling',appliedMode:null,queued:false,deliveryId:item.deliveryId};
          item.receipt={accepted:true,runId:run.id,deliveryId:item.deliveryId,appliedMode:item.mode,queued:item.mode==='queue',authorityRestricted:true};
          if(run.acceptingInput)dispatchTtm(run,item);else(run.pendingInputs ||= []).push(item);
          push(run,'ttm-accepted',{...item.receipt,source:item.message.source});
          return item.receipt;
        })();
        return json(res,202,await item.ready);
      }
      if(req.method==='POST'&&url.pathname==='/original-system-prompt'){
        const request=await body(req);if(closing)return json(res,503,{error:'DSH bridge is closing'});
        if(typeof request.cwd!=='string'||!path.isAbsolute(request.cwd)||typeof request.provider!=='string'||typeof request.model!=='string')return json(res,400,{error:'Invalid original prompt scope'});
        let preset;
        try{
          const permission=request.runtimePermission?validateRuntimePermission(request.runtimePermission,runtimePermissionCatalog(ctx,autoReviewSupported)):undefined;
          const allow=request.nativeTools?.allow??[];
          if(allow.length){const catalog=await nativeToolCatalog.read();if(request.nativeTools.protocol!==RUNTIME_NATIVE_PROTOCOL||request.nativeTools.catalogRevision!==catalog.catalogRevision||allow.some(name=>!catalog.tools.some(t=>t.name===name&&t.available)))return json(res,409,{error:'Native tool catalog changed'});}
          if(permission)preset=await prepareNativeExecutionPreset(ctx,{permissionPreset:permission,allow,workspaceRoot:request.cwd,authorize:()=>true});
          let captureCtx=ctx;for(const name of ['agentLoop','agents','sessions','sessionPersistence','sessionProjections'])captureCtx=captureCtx.isolate(name);
          const captureKey={},captureScope=originalCaptureScope(captureCtx,captureKey);captureCtx=captureScope.ctx;
          const captureFibers=[];let result;try{for(const plugin of originalCapturePlugins)captureFibers.push(await captureCtx.plugin(plugin.default));
          result=await captureOriginalPrompt({ctx:captureCtx,persistenceObserver:ctx.get('sessionPersistence'),request,renderPrompt:renderNativePrompt,runtimeVersion,setup:async(agentCtx,agent)=>{const mounted=await preset?.mount(agentCtx,agent)??{enabledNames:[]};if(originalScopeParentOf(agent)===undefined)bindOriginalScopeParent(agent,captureKey);if(permission)applyRuntimePermission(agentCtx,agent,permission,{explicit:request.runtimePermission.explicit===true,newSession:true});agentCtx.tools.restrict({allow:mounted.enabledNames});}});
          }finally{for(const fiber of captureFibers.reverse())await fiber.dispose();await captureScope.dispose();}
          return json(res,200,result);
        }finally{await preset?.close();}
      }
      if(req.method==='POST'&&['/runs','/probe'].includes(url.pathname)){
        if(pluginManagement.busy())return json(res,409,{error:'插件管理操作正在处理中',code:'DSH_PLUGIN_BUSY'});
        const request=await body(req);if(request.inputSource?.kind==='suna-context'){if(Object.keys(request.inputSource).some(key=>key!=='kind'))throw new Error('Invalid Client context source');request.inputSource={kind:'suna-context'};}else if(request.inputSource)request.inputSource=ttmSource(request.inputSource);if(closing)return json(res,503,{error:'DSH bridge is closing'});if(!string(request.contextId,300))return json(res,400,{error:'contextId is required'});
        try{await a2aSessions.prepare(request);}catch{return json(res,400,{error:'Invalid A2A scope'});}
        if(pluginManagement.busy())return json(res,409,{error:'插件管理操作正在处理中',code:'DSH_PLUGIN_BUSY'});
        if(active.has(request.contextId))return json(res,409,{error:'This character conversation already has an active run'});
        if(runs.size>500)for(const [id,r] of runs){if(!['running','queued'].includes(r.status))runs.delete(id);if(runs.size<300)break;}
        const run={nativeController:new AbortController(),id:randomUUID(),contextId:request.contextId,status:'running',sequence:0,events:[],text:'',updatedAt:Date.now()};runs.set(run.id,run);active.set(request.contextId,run.id);if(request.nativeTools?.protocol===RUNTIME_NATIVE_PROTOCOL&&Array.isArray(request.nativeTools.allow)&&request.nativeTools.allow.length)run.nativeLifecycle=createRuntimeNativeLifecycle({onExpired:()=>revokeNative(run)});
        a2aSessions.bind(run,request,cancel);push(run,'started',{contextId:request.contextId});const task=execute(run,request,url.pathname==='/probe');run.execution=task;executions.add(task);void task.finally(()=>executions.delete(task));return json(res,202,{id:run.id});
      }
      const match=url.pathname.match(/^\/runs\/([\w-]+)(?:\/(cancel|tools|tools\/claim|native-authorizations))?$/);
      if(match){
        const run=runs.get(match[1]);if(!run)return json(res,404,{error:'Run not found'});
        if(req.method==='GET'&&!match[2])return json(res,200,{id:run.id,status:run.status,settled:run.settled===true,sequence:run.sequence,events:run.events.filter(e=>e.sequence>Number(url.searchParams.get('after') || 0)),text:run.text,error:run.error,errorCode:run.errorCode,recovery:run.recovery,sessionId:run.sessionId,probe:run.probe,usage:run.usage,modelCalls:run.telemetry?.calls() ?? []});
        if(req.method==='POST'&&match[2]==='native-authorizations'){const payload=await body(req);if(payload.action==='revoke'){revokeNative(run);return json(res,200,{ok:true});}if(payload.action==='heartbeat')return json(res,200,run.nativeLifecycle?.heartbeat()??{ok:false,active:false});const call=nativePending.get(payload.requestId);if(!call||call.runId!==run.id)return json(res,409,{error:'Native authorization is unavailable or already settled'});call.finish(payload.decision);return json(res,200,{ok:true});}
        if(req.method==='POST'&&match[2]==='cancel'){cancel(run);return json(res,200,{ok:true});}
        if(req.method==='POST'&&match[2]==='tools/claim'){const payload=await body(req),call=pending.get(payload.callId);if(!call||call.runId!==run.id||call.claimed)return json(res,409,{error:'Tool call is unavailable or already claimed'});call.claimed=true;return json(res,200,{authorityRestricted:run.authorityRestricted===true});}
        if(req.method==='POST'&&match[2]==='tools'){const payload=await body(req);const call=pending.get(payload.callId);if(!call || call.runId!==run.id)return json(res,409,{error:'Tool call has already settled'});call.finish(payload.error?new Error(string(payload.error)):null,payload.value);return json(res,200,{ok:true});}
      }
      json(res,404,{error:'Route not found'});
    }catch(error){if(!res.headersSent)json(res,error.status || 400,{error:errorText(error)});else res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port || 0,'127.0.0.1',resolve);});
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  await mkdir(path.dirname(discovery),{recursive:true,mode:0o700});await writeFile(discovery,JSON.stringify({apiVersion:API_VERSION,endpoint,token,pid:process.pid,createdAt:new Date().toISOString()}),{mode:0o600});
  ctx.on('dispose',async()=>{closing=true;await pluginManagement.close();a2aSessions.close();for(const run of runs.values())cancel(run);await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await Promise.allSettled([...executions]);await ownership.close();await a2aSessions.flush().catch(()=>{});await persistTail.catch(()=>{});try{const current=JSON.parse(await readFile(discovery,'utf8'));if(current.pid===process.pid)await rm(discovery,{force:true});}catch{}});
}
