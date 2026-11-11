import {readFile,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {resolveRuntimeModelDependencies} from '../runtime/runtime-dependencies.mjs';

const fail=code=>Object.assign(new Error({WORKER_CLIENT_DSH_AUTH_UNSUPPORTED:'此 DSH 授权方式暂不支持 Client Worker，请选择 API Key 或 Client OpenAI 授权',WORKER_CLIENT_DSH_CONFIG:'无法读取所选 DSH 模型的 Client 配置',WORKER_CLIENT_DSH_AUTH:'所选 DSH 模型没有可用的 API Key'}[code]),{code});
async function optional(file){try{return await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}}

// This reader never starts DSH, edits its files, refreshes its grants, or falls
// back to a different provider's credentials. Its return value is server-only.
export async function readDshClientModelConfig({runtimeDir,home,profile='suna',cwd,env={},provider,model,signal}){
 try{
  signal?.throwIfAborted();
  if(!provider||!model||!home||!cwd||!/^[-\w]+$/.test(profile))throw fail('WORKER_CLIENT_DSH_CONFIG');
  const root=await realpath(runtimeDir),req=createRequire(await realpath(path.join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js')));
  const base=createRequire(req.resolve('@deepseek-ai/dsh-base/package.json'));
  const credentialModule=base.resolve('@deepseek-ai/dsh-credentials-local');
  const yaml=createRequire(credentialModule)('yaml');
  const parse=text=>{if(!text.trim())return undefined;const document=yaml.parseDocument(text,{uniqueKeys:true});if(document.errors.length)throw fail('WORKER_CLIENT_DSH_CONFIG');return document.toJS({maxAliasCount:100});};
  const rows=new Map();
  function patch(value){if(!Array.isArray(value))throw fail('WORKER_CLIENT_DSH_CONFIG');for(const entry of value){if(!entry||typeof entry!=='object'||(!entry.id&&!entry.insert)||Object.keys(entry).some(key=>!['id','name','config','disabled','insert','before','after'].includes(key)))throw fail('WORKER_CLIENT_DSH_CONFIG');if(entry.insert)patch(entry.insert);if(entry.id){const previous=rows.get(entry.id)||{};rows.set(entry.id,{...previous,...entry});}}}
  const profileDir=path.join(home,'profiles',profile),profilePackage=parse(await optional(path.join(profileDir,'package.json')))||{};
  for(const bundle of profilePackage.dsh?.profile?.bundles||['@deepseek-ai/dsh-base']){
   // Only the installed runtime and this profile's declared bundles participate.
   let manifest;try{manifest=base.resolve(bundle+'/package.json');}catch{try{if(!/^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(bundle))throw Error();manifest=path.join(profileDir,'node_modules',bundle,'package.json');await readFile(manifest,'utf8');}catch{throw fail('WORKER_CLIENT_DSH_CONFIG');}}
   const metadata=JSON.parse(await readFile(manifest,'utf8'));const filename=metadata.dsh?.bundle?.patch||'cordis.patch.yml';
   const text=await optional(path.resolve(path.dirname(manifest),filename));if(text.trim())patch(parse(text));
  }
  for(const file of [path.join(profileDir,'cordis.patch.yml'),path.join(home,'cordis.patch.yml'),...(profilePackage.sunaManagedProfile===1?[path.join(profileDir,'suna-base.patch.json')]:[])]){const text=await optional(file);if(text.trim())patch(parse(text));}
  const credentialsConfig=rows.get('credentials')?.config||{};
  const credentialsPath=path.resolve(cwd,credentialsConfig.path||path.join(credentialsConfig.dshHome||home,'.credentials.yaml'));
  const credentials=parse(await optional(credentialsPath))||{};
  if(Object.keys(credentials).length&&credentials.version!==1)throw fail('WORKER_CLIENT_DSH_CONFIG');
  const projectEnv=parseEnv(await optional(path.join(cwd,'.env'))),homeEnv=parseEnv(await optional(path.join(home,'.env')));
  const value=name=>credentials.refs?.[name]??env[name]??projectEnv[name]??homeEnv[name];
  let config,descriptor,apiKey;
  if(provider==='deepseek-official'){
   const row=rows.get('llm-deepseek');if(!row||row.disabled===true||(row.disabled!==undefined&&typeof row.disabled!=='boolean'))throw fail('WORKER_CLIENT_DSH_CONFIG');
   const native=await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm-deepseek-api-key')).href);
   const resolved=native.resolveAdapterOptions(row?.config||{},{get:name=>{const v=env[name]??projectEnv[name]??homeEnv[name];return v===undefined?undefined:{value:v};}});
   const known=resolved.models.find(item=>item.id===model);if(!known)throw fail('WORKER_CLIENT_DSH_CONFIG');
   apiKey=value(resolved.apiKeyEnv);
   config={api:'anthropic-messages',baseURL:resolved.baseURL,reasoningEffort:resolved.defaults.reasoningEffort??(resolved.defaults.thinking==='disabled'?'off':'high'),nativeDeepSeek:true,models:resolved.models.map(m=>({id:m.id,reasoningEfforts:resolved.defaults.thinking==='disabled'?['off']:['off','low','high','max']}))};
   descriptor={id:model,name:known.name||model,provider,api:config.api,baseUrl:config.baseURL,reasoning:true,input:['text'],contextWindow:known.contextWindow||resolved.defaultContextWindow,maxTokens:known.maxTokens||resolved.maxTokens};
  }else{
   const row=rows.get('llm-pi-ai'),profileConfig=row?.config?.providers?.[provider];
   if(row?.disabled===true||!profileConfig){if(provider==='deepseek-account')throw fail('WORKER_CLIENT_DSH_AUTH_UNSUPPORTED');throw fail('WORKER_CLIENT_DSH_CONFIG');}
   const {piDist}=await resolveRuntimeModelDependencies(root),catalog=await import(pathToFileURL(path.join(piDist,'providers/all.js')).href);
   const builtin=catalog.getBuiltinModels(provider)||[],known=builtin.find(item=>item.id===model);
   const declared=profileConfig.models?.length?profileConfig.models.find(item=>item.id===model):known?{...known,...profileConfig.modelOverrides?.[model]}:null;
   if(!declared)throw fail('WORKER_CLIENT_DSH_CONFIG');
   const record=credentials.records?.['llm-pi-ai/'+provider];
   if(profileConfig.apiKeyEnv)apiKey=value(profileConfig.apiKeyEnv);
   else if(record?.kind==='grant')throw fail('WORKER_CLIENT_DSH_AUTH_UNSUPPORTED');
   else if(record?.kind==='api-key')apiKey=record.key;
   else throw fail('WORKER_CLIENT_DSH_AUTH');
   const efforts=declared.reasoningEfforts;
   descriptor={...known,...declared,id:model,provider,api:profileConfig.api||known?.api,baseUrl:profileConfig.baseURL||known?.baseUrl,
    ...(efforts===false?{reasoning:false}:efforts&&typeof efforts==='object'?{reasoning:true,thinkingLevelMap:Object.fromEntries(['off','minimal','low','medium','high','xhigh','max'].filter(level=>!(level==='off'&&efforts[level]===null)).map(level=>[level,efforts[level]??null]))}:{}),compat:{...known?.compat,...profileConfig.compat,...declared.compat}};
   config={api:descriptor.api,baseURL:descriptor.baseUrl,reasoningEffort:profileConfig.reasoning,headers:profileConfig.headers,models:[{id:model,...(efforts===false?{reasoningEfforts:['off']}:efforts?{reasoningEfforts:Object.keys(efforts)}:{})}]};
  }
  if(typeof apiKey!=='string'||!apiKey.trim())throw fail('WORKER_CLIENT_DSH_AUTH');
  signal?.throwIfAborted();return {...config,provider,model,apiKey,modelDescriptor:descriptor};
 }catch(error){if(error.code?.startsWith('WORKER_CLIENT_DSH_'))throw error;throw fail('WORKER_CLIENT_DSH_CONFIG');}
}
