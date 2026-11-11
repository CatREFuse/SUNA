import {credentialKey} from '../src/core/role-credential-store.mjs';
const messages={CREDENTIAL_WINDOW_DENIED:'凭证只能从桌面应用保存',CREDENTIAL_INPUT_INVALID:'凭证提交参数无效',CREDENTIAL_SCOPE_DENIED:'凭证表单不属于当前角色或会话',INTERACTION_CLOSED:'凭证表单已处理，请重新读取',VERSION_CONFLICT:'凭证已更新，请重新读取',CREDENTIAL_SUBMIT_FAILED:'凭证保存失败，请重试'};
const denied=code=>({ok:false,error:{code,message:messages[code]??messages.CREDENTIAL_SUBMIT_FAILED}});
const record=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&(!allowed||allowed.includes(key))&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x1f]/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
/** Dedicated trusted application-frame mutation. API holds native headers in Main;
 * neither a generic proxy nor the native token is exposed to the renderer. */
export function createCredentialSubmissionHandler({applicationFrame,api}){
 return async(event,input)=>{
  try{applicationFrame(event);}catch{return denied('CREDENTIAL_WINDOW_DENIED');}
  if(!record(input,['conversationId','characterId','id','expectedVersion','credentialVersion','values'])||!['conversationId','characterId','id'].every(key=>id(input[key]))||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||!Number.isSafeInteger(input.credentialVersion)||input.credentialVersion<0||!record(input.values)||Object.keys(input.values).length<1||Object.keys(input.values).length>64||Object.entries(input.values).some(([key,value])=>!credentialKey(key)||typeof value!=='string'||Buffer.byteLength(value)>16384))return denied('CREDENTIAL_INPUT_INVALID');
  const route=`/conversations/${encodeURIComponent(input.conversationId)}/interactions/${encodeURIComponent(input.id)}`;
  // Private copy: IPC inputs and every source check remain out of diagnostics.
  const values={...input.values};
  try{
   const form=await api(route);
   if(form?.kind!=='request_credentials'||form.id!==input.id||form.characterId!==input.characterId||form.conversationId!==input.conversationId)return denied('CREDENTIAL_SCOPE_DENIED');
   if(form.status!=='pending')return denied('INTERACTION_CLOSED');
   if(form.version!==input.expectedVersion||form.credentialVersion!==input.credentialVersion)return denied('VERSION_CONFLICT');
   try{applicationFrame(event);}catch{return denied('CREDENTIAL_WINDOW_DENIED');}
   const result=await api(route+'/answer',{expectedVersion:input.expectedVersion,credentialVersion:input.credentialVersion,values});
   const saved=result?.interaction;
   if(saved?.kind!=='request_credentials'||saved.status!=='saved'||saved.id!==form.id||saved.characterId!==form.characterId||saved.conversationId!==form.conversationId||!Number.isSafeInteger(saved.version)||saved.version<=form.version||!Array.isArray(saved.savedKeys)||saved.savedKeys.some(key=>!form.fields?.some(field=>field.key===key)))return denied('CREDENTIAL_SUBMIT_FAILED');
   return {ok:true,result:{interaction:{id:form.id,kind:form.kind,characterId:form.characterId,conversationId:form.conversationId,title:form.title,fields:form.fields.map(field=>({key:field.key,label:field.label,type:field.type,required:field.required})),status:'saved',version:saved.version,savedKeys:[...saved.savedKeys]},...(id(result.messageId)?{messageId:result.messageId}:{})}};
  }catch(error){return denied(Object.hasOwn(messages,error?.code)?error.code:'CREDENTIAL_SUBMIT_FAILED');}
  finally{for(const key of Object.keys(values))delete values[key];for(const key of Object.keys(input.values))delete input.values[key];}
 };
}
