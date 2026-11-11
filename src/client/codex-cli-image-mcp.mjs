// Validate only metadata from the owned native CLI. No server names, endpoints,
// tool schemas or config contents are included in diagnostic/error receipts.
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=300&&!/[\x00-\x1f\x7f]/.test(value);
const safeStates=new Set(['disabled','notStarted','failed','cancelled']);
const reasons=new Set(['mcp-response-invalid','mcp-page-limit','mcp-cursor-invalid','mcp-server-limit','mcp-server-duplicate','mcp-tools-present','mcp-resources-present','mcp-catalog-unavailable','mcp-state-active','mcp-state-unproven','mcp-config-invalid','mcp-config-enabled','mcp-config-changed','mcp-runtime-changed']);
const deny=safetyReason=>{throw Object.assign(new Error('IMAGE_CLI_CONFIGURATION_UNSAFE'),{code:'IMAGE_CLI_CONFIGURATION_UNSAFE',safetyReason});};
export const codexMcpSafetyReason=error=>reasons.has(error?.safetyReason)?error.safetyReason:undefined;
export function watchCodexImageMcpSafety({rpc,threadId}){
 let safetyReason,ownedThreadId=threadId;
 const close=rpc.onNotification(message=>{
  if(message.method!=='mcpServer/startupStatus/updated')return;
  const p=message.params;
  if(plain(p)&&p.threadId!==undefined&&p.threadId!==null&&identifier(p.threadId)&&ownedThreadId!==undefined&&p.threadId!==ownedThreadId)return;
  if(!plain(p)||p.threadId!==undefined&&p.threadId!==null&&!identifier(p.threadId)||!identifier(p.name)||!['failed','cancelled'].includes(p.status)){
   safetyReason='mcp-runtime-changed';rpc.fail('IMAGE_CLI_CONFIGURATION_UNSAFE');
  }
 });
 return {close,bindThread(id){ownedThreadId=id;},get safetyReason(){return safetyReason;}};
}
function disabledConfiguration(config){
 if(!plain(config))deny('mcp-config-invalid');
 const groups={};
 for(const key of ['mcp_servers','plugins']){
  const values=config[key]===undefined?{}:config[key];if(!plain(values))deny('mcp-config-invalid');
  if(Object.entries(values).some(([id,value])=>!identifier(id)||!plain(value)))deny('mcp-config-invalid');
  if(Object.values(values).some(value=>value.enabled!==false))deny('mcp-config-enabled');
  groups[key]=new Set(Object.keys(values));
 }
 return {...groups,fingerprint:JSON.stringify(Object.entries(groups).map(([key,values])=>[key,[...values].sort()]))};
}
function provenDisabled(row,config){
 const server=config.mcp_servers.has(row.name);
 // A plugin-owned entry must also have its actual plugin explicitly disabled;
 // a colliding disabled server name cannot stand in for another plugin source.
 const plugin=row.pluginId!==undefined&&row.pluginId!==null;
 return plugin?config.plugins.has(row.pluginId):server;
}
export async function assertCodexImageMcpSafety({rpc,threadId,cwd,config,check=()=>{}}){
 const disabled=disabledConfiguration(config),cursors=new Set(),servers=new Set();
 let cursor,pageCount=0,serverCount=0,unknownStateCount=0;
 for(;;){
  check();if(++pageCount>8)deny('mcp-page-limit');
  const page=await rpc.request('mcpServerStatus/list',{threadId,limit:200,detail:'toolsAndAuthOnly',...(cursor?{cursor}:{})});check();
  if(!plain(page)||!Array.isArray(page.data))deny('mcp-response-invalid');
  for(const row of page.data){
   if(++serverCount>1024)deny('mcp-server-limit');
   if(!plain(row)||!identifier(row.name)||!plain(row.tools)||row.pluginId!==undefined&&row.pluginId!==null&&!identifier(row.pluginId))deny('mcp-response-invalid');
   const key=JSON.stringify([row.name,row.pluginId??null]);if(servers.has(key))deny('mcp-server-duplicate');servers.add(key);
   if(Object.keys(row.tools).length)deny('mcp-tools-present');
   for(const field of ['resources','resourceTemplates'])if(row[field]!==undefined&&(!Array.isArray(row[field])||row[field].length))deny('mcp-resources-present');
   if(row.toolsError!==undefined&&row.toolsError!==null)deny('mcp-catalog-unavailable');
   if(row.runtimeStatus!==undefined&&row.runtimeStatus!==null&&!safeStates.has(row.runtimeStatus))deny('mcp-state-active');
   // Inactive is not a disabled-source proof: an unconfigured failed/notStarted
   // source could reconnect on first use. Require provenance in every state.
   if(!provenDisabled(row,disabled))deny('mcp-state-unproven');
   if(row.runtimeStatus===undefined||row.runtimeStatus===null)unknownStateCount++;
  }
  if(page.nextCursor===undefined||page.nextCursor===null)break;
  if(typeof page.nextCursor!=='string'||!page.nextCursor||page.nextCursor.length>1024||/[\x00-\x1f\x7f]/.test(page.nextCursor)||cursors.has(page.nextCursor))deny('mcp-cursor-invalid');
  cursor=page.nextCursor;cursors.add(cursor);
 }
 // Null state can mean a configuration transition. Recheck the complete
 // disabled-source proof immediately before admitting the native model turn.
 const current=await rpc.request('config/read',{cwd,includeLayers:false});check();
 const latest=disabledConfiguration(current?.config);
 if(latest.fingerprint!==disabled.fingerprint)deny('mcp-config-changed');
 return {pageCount,serverCount,unknownStateCount};
}
