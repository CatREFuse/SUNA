export const DESKTOP_MODERATOR_PROMPT='你是内置群聊的主持调度器。根据本群公开对话，选择最适合接着发言的一位候选角色；每位角色会使用自己的真实身份回复。等上一位结束后再安排下一位。问题已回答、内容开始重复、没有相关角色或无需继续时结束讨论。兼顾角色相关性与发言机会，不要求每个人都发言。你只负责选人和结束，不生成角色回复。';
export const DESKTOP_GROUP_SCHEDULER_DEFAULTS=Object.freeze({mode:'existing',decisionTimeoutMs:30000,historyLimit:40,decisionPrompt:DESKTOP_MODERATOR_PROMPT});
const ranges={decisionTimeoutMs:[1000,120000],historyLimit:[1,200]};
const invalid=message=>Object.assign(new Error(message),{code:'INVALID_DESKTOP_GROUP_SCHEDULER'});
export function validateDesktopGroupScheduler(patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw invalid('内置群聊调度设置格式无效');
 const clean={};
 for(const [key,value]of Object.entries(patch)){
  if(!Object.hasOwn(DESKTOP_GROUP_SCHEDULER_DEFAULTS,key))throw invalid('未知内置群聊调度设置');
  if(value===null){clean[key]=null;continue;}
  if(key==='mode'){if(!['existing','moderated'].includes(value))throw invalid('请选择有效的群聊调度方式');}
  else if(key==='decisionPrompt'){if(typeof value!=='string'||!value.trim()||value.length>8000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value))throw invalid('主持提示词须为 1 至 8000 字符的非空文本');}
  else{const [min,max]=ranges[key];if(!Number.isSafeInteger(value)||value<min||value>max)throw invalid(`${key} 必须是 ${min} 至 ${max} 的整数`);}
  clean[key]=value;
 }
 return clean;
}
export function mergeDesktopGroupScheduler(current,patch){
 if(patch===null)return {};
 const next={...current};for(const [key,value]of Object.entries(validateDesktopGroupScheduler(patch))){if(value===null)delete next[key];else next[key]=value;}return next;
}
export function resolveDesktopGroupScheduler(raw={}){
 const result={...DESKTOP_GROUP_SCHEDULER_DEFAULTS};
 for(const key of Object.keys(result))try{if(raw?.[key]!==undefined&&raw[key]!==null)result[key]=validateDesktopGroupScheduler({[key]:raw[key]})[key];}catch{}
 return result;
}
export const isDesktopModeratedGroup=conv=>conv?.channel==='desktop'&&conv.kind==='group'&&resolveDesktopGroupScheduler(conv.desktopGroupScheduler).mode==='moderated';
