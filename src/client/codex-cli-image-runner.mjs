import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {homedir} from 'node:os';
import {openCodexImageRpc} from './codex-cli-image-rpc.mjs';
import {codexImageFailureCode} from './codex-cli-image-errors.mjs';
import {assertCodexImageMcpSafety,codexMcpSafetyReason,watchCodexImageMcpSafety} from './codex-cli-image-mcp.mjs';
import {stageCodexNativeImage,stageCodexInputImages} from './codex-cli-image-artifacts.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code})};
const disabled=['shell_tool','multi_agent','multi_agent_v2','apps','plugins','remote_plugin','hooks','browser_use','browser_use_external','browser_use_full_cdp_access','in_app_browser','view_image','skill_mcp_dependency_install','skill_search'];
const safeModel=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const own=(root,file)=>file===root||file.startsWith(root+path.sep);
export function codexImageArguments(cwd,{mcpIds=[],pluginIds=[]}={}){
 return ['--strict-config','--enable','image_generation',...disabled.flatMap(name=>['--disable',name]),'-c','web_search="disabled"','-c','skills.bundled.enabled=false','-c','project_doc_max_bytes=0','-c','default_permissions="suna_image_only"','-c','permissions.suna_image_only={filesystem={'+JSON.stringify(cwd)+'="write"},network={enabled=false}}',
 ...mcpIds.length?['-c','mcp_servers={'+mcpIds.map(name=>JSON.stringify(name)+'={enabled=false}').join(',')+'}']:[],
 ...pluginIds.length?['-c','plugins={'+pluginIds.map(name=>JSON.stringify(name)+'={enabled=false}').join(',')+'}']:[],
 'app-server'];
}
function environment(cwd,source){return {HOME:homedir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:cwd,LANG:'en_US.UTF-8',TERM:'dumb',...(source.CODEX_HOME?{CODEX_HOME:source.CODEX_HOME}:{})};}
/** New ephemeral native Codex thread per image job, never a DSH/worker session.
 * No CLI launch/job retry. The caller owns publication and send_message. */
export function createCodexCliImageRunner({executable,jobRoot,environment:source=process.env,spawnProcess,timeoutMs=600000,onDiagnostic=()=>{}}={}){
 if(typeof executable!=='string'||!path.isAbsolute(executable)||typeof jobRoot!=='string'||!path.isAbsolute(jobRoot))throw TypeError('Host executable and job root required');
 let active,closing=false;
 async function withJob(input,scope={},probeOnly=false){
  if(closing)fail('IMAGE_CLI_CLOSED');if(active)fail('IMAGE_BUSY');const local=new AbortController(),signal=AbortSignal.any([local.signal,...scope.signal?[scope.signal]:[]]),timer=setTimeout(()=>local.abort(),Math.min(timeoutMs,scope.deadline?Math.max(1,scope.deadline-Date.now()):timeoutMs));
  let cleanupFinished;const cleanup=new Promise(resolve=>cleanupFinished=resolve);const marker={abort:()=>local.abort(),done:null,cleanup};active=marker;let rpc,cwd,interval,accepted=false,outputBytes,protocolFault,disposeNotifications,mcpFence,shuttingDown=false,phase='discovery';const diagnostic=value=>{try{const result=onDiagnostic({...value,...(scope.runId?{runId:scope.runId}:{}),...(scope.toolName?{toolName:scope.toolName}:{})});Promise.resolve(result).catch(()=>{});}catch{}};
  const check=()=>{if(protocolFault)fail(protocolFault);if(signal.aborted)fail('IMAGE_CANCELLED');if(scope.assertCurrent?.()===false)fail('IMAGE_CANCELLED');};
  const run=(async()=>{
   check();await fs.mkdir(jobRoot,{recursive:true,mode:0o700});if(await fs.realpath(jobRoot)!==jobRoot)fail('IMAGE_WORKSPACE_INVALID');cwd=await fs.realpath(await fs.mkdtemp(path.join(jobRoot,'image-')));
   const start=()=>{check();const value=openCodexImageRpc({executable,args:codexImageArguments(cwd,argumentsForProcess),cwd,env:environment(cwd,source),signal,spawnProcess});marker.rpc=value;return value;};let argumentsForProcess={};
   async function initialize(){await rpc.request('initialize',{clientInfo:{name:'suna_image_server',title:'SUNA image service',version:'1.0.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');}
   diagnostic({phase,status:'started'});rpc=start();await initialize();const initial=(await rpc.request('config/read',{cwd,includeLayers:false})).config??{};
   argumentsForProcess={mcpIds:Object.keys(initial.mcp_servers??{}),pluginIds:Object.keys(initial.plugins??{})};
   if([...argumentsForProcess.mcpIds,...argumentsForProcess.pluginIds].some(id=>typeof id!=='string'||id.length>300||/[\x00-\x1f\x7f]/.test(id)))fail('IMAGE_CLI_CONFIGURATION_UNSAFE');
   const discoveredStop=await rpc.close();if(discoveredStop.processGroupGone!==true)fail('IMAGE_CLI_CLEANUP_UNCERTAIN');check();rpc=start();await initialize();
   const config=(await rpc.request('config/read',{cwd,includeLayers:false})).config??{};
   if(Object.values(config.mcp_servers??{}).some(item=>item.enabled!==false)||Object.values(config.plugins??{}).some(item=>item.enabled!==false))fail('IMAGE_CLI_CONFIGURATION_UNSAFE');
   const account=await rpc.request('account/read',{refreshToken:false});if(!account.account)fail('IMAGE_CLI_AUTH_REQUIRED');
   const capability=await rpc.request('modelProvider/capabilities/read',{});if(capability.imageGeneration!==true)fail('IMAGE_CLI_IMAGE_UNAVAILABLE');
   if(probeOnly)return {available:true};phase='thread';
   if(!input||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000||!safeModel(scope.modelId))fail('IMAGE_ARGUMENTS_INVALID');
   const expectedInputs=await stageCodexInputImages({jobDirectory:cwd,referenceImages:input.referenceImages??[],signal,assertCurrent:scope.assertCurrent??(()=>true)});
   mcpFence=watchCodexImageMcpSafety({rpc});
   check();const response=await rpc.request('thread/start',{cwd,model:scope.modelId,ephemeral:true,approvalPolicy:'never',permissions:'suna_image_only',baseInstructions:'You are an image generation service. Use the native image_gen tool exactly once. Do not use other tools. Never read existing files, history or private data except the explicitly provided frozen reference images. Return one image.',developerInstructions:'Generate the requested image once with no retries. '+(expectedInputs.length?'Use only the explicitly provided frozen reference images with the native image tool.':'Use no reference images.')+' Never claim success without the native image tool.',config:{'web_search':'disabled'}});check();
   phase='thread-contract';const threadId=response.thread?.id;if(!/^[A-Za-z0-9_-]{1,128}$/.test(threadId??'')||response.thread?.ephemeral!==true||response.model!==scope.modelId||response.modelProvider!=='openai'||response.cwd!==cwd||response.activePermissionProfile?.id!=='suna_image_only'||response.activePermissionProfile?.extends||response.sandbox?.networkAccess!==false||!(response.sandbox?.writableRoots??[]).every(root=>own(cwd,root)))fail('IMAGE_CLI_CONFIGURATION_UNSAFE');
   const environments=response.thread?.environments;if(!Array.isArray(environments)||environments.length!==1||environments[0].environmentId!=='local'||environments[0].cwd!==cwd||JSON.stringify(environments[0].runtimeWorkspaceRoots)!==JSON.stringify([cwd])||JSON.stringify(response.runtimeWorkspaceRoots)!==JSON.stringify([cwd]))fail('IMAGE_CLI_CONFIGURATION_UNSAFE');
   mcpFence.bindThread(threadId);
   phase='features';const flags=(await rpc.request('experimentalFeature/list',{threadId,limit:200})).data??[];const values=Object.fromEntries(flags.map(value=>[value.name,value.enabled]));if(disabled.some(name=>values[name]!==false)||values.image_generation!==true)fail('IMAGE_CLI_CONFIGURATION_UNSAFE');
   phase='mcp';const mcp=await assertCodexImageMcpSafety({rpc,threadId,cwd,config,check});diagnostic({phase,status:'checked',...mcp});
   let completedItem,turnId,imageId,starts=0,finish,rejectTurn,agentClaim='NONE',queued=[];const done=new Promise((resolve,reject)=>{finish=resolve;rejectTurn=reject});void done.catch(()=>{});
   const handleNotification=message=>{
    const p=message.params??{};if(p.threadId!==threadId)return;if(!turnId){if(queued.length>=100){rpc.fail('IMAGE_CLI_PROTOCOL_INVALID');return;}queued.push(message);return;}const actualTurn=message.method==='turn/completed'?p.turn?.id:p.turnId;if(actualTurn!==turnId)return;
    if(message.method==='item/started'||message.method==='item/completed'){
     const item=p.item??{};if(item.type==='agentMessage'&&typeof item.text==='string'&&/(?:image_gen|生图|图像生成|图片生成)/i.test(item.text)&&/(?:not.*available|do not have|don't have|不能|没有|不可用|不支持|未提供|无法)/i.test(item.text))agentClaim='IMAGE_TOOL_UNAVAILABLE_CLAIM';
     if(item.type==='imageGeneration'){
      if(imageId&&imageId!==item.id){rpc.fail('IMAGE_CLI_BUDGET_EXHAUSTED');return;}imageId=item.id;
      if(message.method==='item/started'){if(completedItem||++starts>1){rpc.fail('IMAGE_CLI_BUDGET_EXHAUSTED');return;}imageId=item.id;}
      if(message.method==='item/completed'){if(imageId&&imageId!==item.id||completedItem){rpc.fail('IMAGE_CLI_BUDGET_EXHAUSTED');return;}completedItem=item;if(item.failure!==undefined&&item.failure!==null){rpc.fail(codexImageFailureCode(item.failure));return;}}
     }else if(!['agentMessage','reasoning','userMessage','plan'].includes(item.type)){rpc.fail('IMAGE_CLI_UNEXPECTED_TOOL');}
    }
    if(message.method==='turn/completed'){if(p.turn?.status!=='completed'){rpc.fail(codexImageFailureCode(p.turn?.error));return;}finish();}
   };const stopListen=rpc.onNotification(handleNotification);const stopError=rpc.onError(reason=>{if(shuttingDown&&reason?.code==='IMAGE_CLI_EXITED')return;protocolFault=/^IMAGE_[A-Z0-9_]+$/.test(reason?.code??'')?reason.code:'IMAGE_CLI_PROTOCOL_INVALID';rejectTurn(reason);});disposeNotifications=()=>{stopListen();stopError();};
   interval=setInterval(()=>{try{check()}catch{rpc.fail('IMAGE_CANCELLED')}},100);interval.unref?.();
   try{
    check();phase='turn';diagnostic({phase,status:'started'});const request=await rpc.request('turn/start',{threadId,cwd,environments,approvalPolicy:'never',permissions:'suna_image_only',input:[{type:'text',text:'Generate one image. '+(expectedInputs.length?'Use referenced_image_paths exactly '+JSON.stringify(expectedInputs.map(value=>value.path))+'. Do not use any other images.':'No reference images.')+' Requested size: '+(input.size??'1024x1024')+'; requested quality: '+(input.quality??'low')+'. These are image preferences. Prompt: '+input.prompt},...expectedInputs.map(value=>({type:'localImage',path:value.path}))]});turnId=request.turn?.id;if(!/^[A-Za-z0-9_-]{1,128}$/.test(turnId??''))fail('IMAGE_CLI_PROTOCOL_INVALID');for(const message of queued)handleNotification(message);queued=[];
    await done;check();diagnostic({phase,status:'completed',nativeImageCount:completedItem?1:0,agentClaim});if(!completedItem)fail('IMAGE_CLI_OUTPUT_MISSING');phase='artifact';
    
    const nativeRoot=path.join(source.CODEX_HOME??path.join(homedir(),'.codex'),'generated_images');const result=await stageCodexNativeImage({jobDirectory:cwd,nativeRoot,threadId,item:completedItem,signal,expectedInputs,assertCurrent:scope.assertCurrent??(()=>true)});outputBytes=result.bytes;check();accepted=true;
    diagnostic({phase,status:'completed',nativeImageCount:1,referenceImageCount:expectedInputs.length,referenceSha256s:expectedInputs.map(value=>value.sha256),referenceMappings:(input.referenceImages??[]).map(value=>({sourceSha256:/^[a-f0-9]{64}$/.test(value.sourceSha256??'')?value.sourceSha256:null,referenceSha256:createHash('sha256').update(value.bytes).digest('hex')})),nativeThreadId:threadId,nativeItemId:result.native.itemId,bytes:result.bytes.length,mime:result.descriptor.mime});
    return {...result,jobDirectory:cwd,cleanup:()=>fs.rm(cwd,{recursive:true,force:true})};
   }finally{/* Keep native lifecycle fences active until owned process cleanup finishes. */}
  })();marker.done=run;
  try{return await run;}catch(e){const code=/^IMAGE_[A-Z0-9_]+$/.test(e?.code??'')?e.code:'IMAGE_CLI_FAILED',safetyReason=codexMcpSafetyReason(e)??mcpFence?.safetyReason;diagnostic({phase,status:'failed',code,...(safetyReason?{safetyReason}:{})});throw Object.assign(new Error(code),{code});}
  finally{clearInterval(interval);clearTimeout(timer);let verified=true;try{shuttingDown=true;const stopped=await rpc?.close();if(stopped&&stopped.processGroupGone!==true){verified=false;marker.quarantined=true;accepted=false;fail('IMAGE_CLI_CLEANUP_UNCERTAIN');}if(protocolFault||signal.aborted||scope.assertCurrent?.()===false){accepted=false;fail(protocolFault??'IMAGE_CANCELLED');}}finally{mcpFence?.close();disposeNotifications?.();if(!accepted)outputBytes?.fill(0);if(cwd&&!accepted&&verified)await fs.rm(cwd,{recursive:true,force:true}).catch(()=>{});if(active===marker&&verified)active=null;cleanupFinished();}}
 }
 return {generate:withJob,available:scope=>withJob(null,scope,true),async close(){closing=true;if(active){const job=active;job.abort();await job.cleanup;if(job.quarantined)fail('IMAGE_CLI_CLEANUP_UNCERTAIN');}}};
}
