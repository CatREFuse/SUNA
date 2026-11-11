import {createHash} from 'node:crypto';
export const RUNTIME_PERMISSION_PROTOCOL='SUNA_RUNTIME_PERMISSIONS_V1';
const labels={'auto':'帮我审核','read-only':'只读','workspace-write':'工作区内修改','danger-full-access':'完全访问'};
const unavailable=()=>({protocol:RUNTIME_PERMISSION_PROTOCOL,status:'unsupported',defaultPreset:'auto',options:[],revision:null});
export function runtimePermissionCatalog(ctx,autoCompatible=true){
  const presets=ctx.get?.('permissionPresets');
  if(!presets||typeof presets.catalog!=='function'||!ctx.get?.('sandboxPolicy'))return unavailable();
  const catalog=presets.catalog();
  const options=catalog.options.filter(option=>option.value!=='custom').map(option=>{
    const spec=presets.resolve(option.value);
    return {value:option.value,label:labels[option.value]??option.name,sandbox:spec.sandbox,approval:spec.approval};
  });
  const revision=createHash('sha256').update(JSON.stringify(options)).digest('hex');
  return {protocol:RUNTIME_PERMISSION_PROTOCOL,status:autoCompatible&&options.some(option=>option.value==='auto')?'connected':'unsupported',defaultPreset:'auto',options,revision};
}
export function validateRuntimePermission(request,catalog){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['protocol','preset','revision','explicit'].includes(key))||request.protocol!==RUNTIME_PERMISSION_PROTOCOL||typeof request.preset!=='string'||request.preset==='custom'||request.explicit!==undefined&&typeof request.explicit!=='boolean')throw Object.assign(new Error('运行权限配置无效'),{code:'RUNTIME_PERMISSION_INVALID'});
  if(catalog.status!=='connected'||request.revision!==catalog.revision||!catalog.options.some(option=>option.value===request.preset))throw Object.assign(new Error('运行权限选项已更新，请重新读取'),{code:'RUNTIME_PERMISSION_UNAVAILABLE'});
  return request.preset;
}
export function applyRuntimePermission(ctx,agent,preset,{explicit=false,newSession=false}={}){
  const service=ctx.get?.('permissionPresets');
  if(!service||!service.names.includes(preset))throw Object.assign(new Error('当前 DSH 不支持此运行权限'),{code:'RUNTIME_PERMISSION_UNAVAILABLE'});
  const events=agent.session.snapshotEvents();
  // Existing sessions may have an explicit choice before their first turn.
  // Only a known-new SDK create can treat constructor seeds as bootstrap.
  const legacy=!newSession&&events.some(event=>['permission/preset','sandbox/mode','approval/policy'].includes(event.type));
  const prior=service.current(agent.session);
  if(!explicit&&legacy&&prior!=='auto'){const policy=ctx.get('sandboxPolicy').resolve({session:agent.session});return {preset:prior,sandbox:policy.mode,approval:ctx.get('approval')?.overrideOf(agent.session)??ctx.get('approval')?.config.policy??'ask',source:'legacy-session'};}
  service.set(agent.session,preset);
  const policy=ctx.get('sandboxPolicy').resolve({session:agent.session});
  const current=service.current(agent.session),spec=service.resolve(preset);
  if(current!==preset||policy.mode!==spec.sandbox)throw Object.assign(new Error('运行权限未生效'),{code:'RUNTIME_PERMISSION_NOT_APPLIED'});
  return {preset:current,sandbox:policy.mode,approval:spec.approval};
}
export function runtimePermissionInstructions(ctx,agent){
  const service=ctx.get('permissionPresets'),preset=service.current(agent.session),policy=ctx.get('sandboxPolicy').resolve({session:agent.session});
  return `本轮使用 DSH 原生执行环境，运行权限为${labels[preset]??preset}，文件沙箱模式为 ${policy.mode}。按本轮工具定义、运行上下文和实际审核结果执行；历史沙箱错误不代表本轮权限。DSH 原生工具由 DSH 审核；Client 工具按其独立角色与会话授权执行。`;
}
