import {normalizeProfileSubject} from './person-profile-store.mjs';

export const ADD_USER_PROFILE_DESCRIPTION = '更新当前说话者的人物画像。长期有用的身份、能力、资源、偏好、习惯、边界、目标和首选称呼有新增或更正时，可调用 action=record；明确表达的偏好第一次出现即可记录，不必等待“记住”指令。profile 是保留仍有效内容后的完整聚合认知；addressNames 是完整有序称呼列表，第一项为首选。缺失或 null 保持原值，空正文或空数组表示清空。无依据变化时 action=skip 或不调用，不能阻断正常回复。只记录当前说话者，不记录一次性任务、聊天摘要、猜测、敏感推断或他人的信息；不把玩笑、角色扮演和虚构场景当作真实经历。观察角色、说话者真实身份和来源由宿主绑定，不能由参数或正文选择其他人。画像与角色本人人格、工作记忆分别保存。';
export const ADD_USER_PROFILE_PARAMETERS = Object.freeze({
  type:'object',additionalProperties:false,properties:{
    action:{type:'string',enum:['record','skip']},
    profile:{type:['string','null'],maxLength:262144,description:'完整更新后的聚合画像；缺失/null保留，空文本清空。'},
    addressNames:{type:['array','null'],maxItems:256,items:{type:'string',maxLength:512},description:'完整有序称呼，首项优先；缺失/null保留，空数组清空。'},
  },required:['action'],
});
const invalid=message=>Object.assign(new Error(message),{code:'PROFILE_TOOL_INVALID'});
function validateInput(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!['action','profile','addressNames'].includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value'))||!Object.hasOwn(input,'action')||!['record','skip'].includes(input.action))throw invalid('画像工具仅接受 action/profile/addressNames，不能修改绑定身份');
  const validText=(value,max)=>typeof value==='string'&&value.length<=max&&!value.includes('\0');
  if(input.profile!=null&&!validText(input.profile,262144)||input.addressNames!=null&&(!Array.isArray(input.addressNames)||input.addressNames.length>256||input.addressNames.some(value=>!validText(value,512))))throw Object.assign(new Error('画像正文或称呼无效'),{code:'PROFILE_INVALID'});
}
/** One host-bound speaker decision per turn. No model-supplied identity is accepted. */
export function createPersonProfileTool({store,characterId,subject,sourceDecisionKey,source,signal,assertCurrent}={}){
  if(['get','update','hasDecision','completeDecision'].some(key=>typeof store?.[key]!=='function'))throw new TypeError('Profile tool requires a profile store with durable decisions');
  if(typeof assertCurrent!=='function'||typeof sourceDecisionKey!=='string'||!sourceDecisionKey||sourceDecisionKey!==sourceDecisionKey.trim()||sourceDecisionKey.length>512||/[\x00-\x1f]/.test(sourceDecisionKey)||source?.kind!=='tool')throw new TypeError('Profile tool requires a Host lifetime guard, decision key and tool source');
  function assertActive(){
    if(signal?.aborted)throw Object.assign(new Error('画像更新已取消'),{code:'RUN_CANCELLED'});
    if(assertCurrent()===false||signal?.aborted)throw Object.assign(new Error('画像执行轮已失效'),{code:'RUN_CANCELLED'});
  }
  assertActive();
  const boundSubject=normalizeProfileSubject(subject),boundSource=source==null?source:structuredClone(source);
  const identity={characterId,subject:boundSubject,sourceDecisionKey};
  let current=store.get({characterId,subject:boundSubject}),decision,conflicted=false;
  function snapshot(){assertActive();return current?structuredClone(current):null;}
  const duplicate=()=>{decision='completed';return {ok:false,code:'PROFILE_DECISION_DUPLICATE',duplicate:true,error:'本轮画像决定已完成。'};};
  const conflict=()=>({ok:false,code:'PROFILE_VERSION_CONFLICT',error:'画像已有新版本，本轮不再更新；请在新的执行轮重新读取并整理。'});
  async function execute(input){
    assertActive();validateInput(input);
    if(decision!==undefined||store.hasDecision(identity))return duplicate();
    if(input.action==='record'&&conflicted)return conflict();
    decision='pending';
    try{
      assertActive();
      if(input.action==='skip'){
        if(store.completeDecision(identity).duplicate)return duplicate();
        decision='completed';return {ok:true,action:'skip',recorded:false};
      }
      const result=store.update({characterId,subject:boundSubject,expectedVersion:current?.version??0,baseSnapshot:current,...(Object.hasOwn(input,'profile')?{profile:input.profile}:{}),...(Object.hasOwn(input,'addressNames')?{addressNames:input.addressNames}:{}),sourceDecisionKey,source:boundSource});
      if(result.duplicate)return duplicate();
      current=result.item;decision='completed';
      return {ok:true,action:'record',recorded:result.changed,duplicate:result.duplicate,profileId:current?.id??null,version:current?.version??0,addressNameCount:current?.addressNames.length??0};
    }catch(error){
      decision=undefined;
      if(error.code==='VERSION_CONFLICT'){
        conflicted=true;assertActive();return conflict();
      }
      throw error;
    }
  }
  return {execute,current:snapshot,decisionResolved:()=>decision==='completed'};
}
