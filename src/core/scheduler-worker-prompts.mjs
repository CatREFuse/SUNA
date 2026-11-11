import {GROUP_DECISION_DEFAULT_PROMPT} from './group-scheduler.mjs';
import {DESKTOP_MODERATOR_PROMPT} from './desktop-group-moderator-policy.mjs';
export const SCHEDULER_WORKER_NAMES=['group_scheduler','group_moderator'];
export const schedulerWorkerDefaults=[{name:'group_scheduler',label:'群聊参与判断',prompt:GROUP_DECISION_DEFAULT_PROMPT},{name:'group_moderator',label:'群聊主持',prompt:DESKTOP_MODERATOR_PROMPT}].map(({prompt,...entry})=>({...entry,scope:'worker',content:JSON.stringify({messages:[{role:'system',content:prompt}],response_format:{type:'json_object'}},null,2),metadata:{enabled:true}}));
export function schedulerGuidance(entry,{prompt,defaultPrompt}){
 // Existing per-group nondefault overrides remain authoritative.
 if(prompt!==defaultPrompt||!entry)return prompt;
 const fail=()=>{throw Object.assign(new Error('群聊调度 Worker 提示词无效或已停用，请检查已发布配置'),{code:'GROUP_DECISION_CONFIG'});};
 if(entry.metadata?.enabled===false)fail();let value;try{value=JSON.parse(entry.content)}catch{fail()}
 if(!Array.isArray(value.messages)||!value.messages.length||value.messages.some(m=>!['system','developer'].includes(m.role)||typeof m.content!=='string'||!m.content.trim())||value.response_format?.type!=='json_object')fail();
 const content=value.messages.map(m=>m.content).join('\n\n');if(content.length>12000)fail();return content;
}
