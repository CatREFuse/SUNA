import {createHash} from 'node:crypto';
export const directInputId=(conversationId,requestId)=>'direct_'+createHash('sha256').update(JSON.stringify([conversationId,requestId])).digest('hex');
const terminal=new Set(['admitted','unconsumed','failed','unknown','cancelled']);
/** Durable admission queue. A lost runtime acknowledgement is never replayed. */
export function createDirectInputQueue({list,get,save,clock,active,busy,start,deliver,isOpen,hasStarted=()=>true,onError=()=>{}}){
 const pumps=new Map(),starting=new Set(),dirty=new Set();
 const update=(id,patch)=>{const prior=get(id);return prior?save(id,{...prior,...patch,updatedAt:clock()}):null};
 const pending=id=>list().filter(x=>x.conversationId===id&&x.status==='queued').sort((a,b)=>a.sequence-b.sequence);
 function offer(message,characterId,{requiresRun=!!message.attachments?.length}={}){
  const id=directInputId(message.conversationId,message.requestId),prior=get(id);
  if(prior)return prior;
  const item=save(id,{id,conversationId:message.conversationId,requestId:message.requestId,messageId:message.id,characterId,sequence:message.sequence,requiresRun,strategy:'steer',status:'queued',createdAt:clock(),updatedAt:clock()});
  wake(message.conversationId);return item;
 }
 function event(event,run){
  const item=event.deliveryId?get(event.deliveryId):list().find(x=>x.messageId===run.triggerId&&x.runId===run.id);
  if(!item||item.conversationId!==run.conversationId||item.characterId!==run.characterId||item.runId!==run.id)return;
  const status=event.type==='input-admitted'||event.type==='user-input-admitted'?'admitted':event.type==='user-input-unconsumed'?'unconsumed':event.type==='user-input-accepted'?'accepted':null;
  if(!status||item.status==='admitted'||['failed','cancelled','unconsumed'].includes(item.status))return;
  update(item.id,{status});
 }
 function wake(id){
  if(!isOpen())return;if(pumps.has(id)){dirty.add(id);return;}
  const task=Promise.resolve().then(async()=>{
   while(isOpen()){
    const next=pending(id)[0];if(!next)return;
    const running=active(id);
    if(!running){
     if(starting.has(id)||busy(id))return;
     starting.add(id);update(next.id,{status:'sending',appliedMode:'run'});
     try{
      const {runId,completion}=start(next);update(next.id,{runId});
      void Promise.resolve(completion).then(result=>{if(!isOpen())return;const current=get(next.id);if(current&&!terminal.has(current.status))update(next.id,{status:'failed',errorCode:result?.code??'DIRECT_INPUT_NOT_ADMITTED',error:'本轮未接纳消息'});}).catch(error=>{if(!isOpen())return;const current=get(next.id);if(current&&!terminal.has(current.status))update(next.id,{status:'failed',errorCode:error.code??'DIRECT_INPUT_FAILED',error:'本轮消息处理失败'});onError(error);}).finally(()=>{starting.delete(id);wake(id)});
     }catch(error){starting.delete(id);update(next.id,{status:'failed',errorCode:error.code??'DIRECT_INPUT_FAILED',error:'消息未能启动处理'});onError(error);}
     return;
    }
    // An attachment admitted while idle may race with another run starting.
    // Preserve the full message for its ordinary run, never inject text alone.
    if(!running.ready||next.requiresRun)return;
    update(next.id,{status:'sending',runId:running.runId,appliedMode:'steer'});
    try{
     const receipt=await deliver(next,running);
     if(!isOpen())return;
     const current=get(next.id);if(!current||terminal.has(current.status))continue;
     if(receipt?.accepted===true){update(next.id,current.runFinished?(current.runDefinitive===false?{status:'unknown',errorCode:'DIRECT_INPUT_UNCERTAIN',error:'运行结束状态未确认，插入消息不会自动重放'}:{status:'unconsumed',errorCode:'DIRECT_INPUT_UNCONSUMED',error:'本轮结束前未消费该插入消息'}):{status:'accepted'});continue;}
     if(['idle','settling'].includes(receipt?.reason)){update(next.id,current.cancelRequested?{status:'cancelled',errorCode:'RUN_CANCELLED',error:'待插入消息已取消'}:{status:'queued',runId:undefined,appliedMode:undefined,runFinished:undefined,runDefinitive:undefined});return;}
     update(next.id,{status:'failed',errorCode:'DIRECT_STEER_UNAVAILABLE',error:'当前运行不支持插入消息'});
    }catch(error){
     if(!isOpen())return;const current=get(next.id);
     if(current&&!terminal.has(current.status))update(next.id,{status:error.definite===true?'failed':'unknown',errorCode:error.code??'DIRECT_INPUT_UNCERTAIN',error:error.definite===true?'插入消息失败':'插入结果待确认，请勿重复发送'});
     onError(error);
    }
   }
  }).catch(onError).finally(()=>{if(pumps.get(id)===task)pumps.delete(id);if(dirty.delete(id))wake(id)});
  pumps.set(id,task);
 }
 function finish(run,{definitive=true}={}){
  for(const item of list())if(item.runId===run.id&&!terminal.has(item.status)&&item.status!=='queued'){
   // A POST may still return a definite *rejection* after the old run finishes.
   // Keep that distinction until its one response settles; do not consume it early.
   if(item.status==='sending'&&item.appliedMode==='steer')update(item.id,{runFinished:true,runDefinitive:definitive});
   else if(!definitive)update(item.id,{status:'unknown',errorCode:'DIRECT_INPUT_UNCERTAIN',error:'运行结束状态未确认，插入消息不会自动重放'});
   else update(item.id,{status:item.appliedMode==='steer'?'unconsumed':'failed',errorCode:item.appliedMode==='steer'?'DIRECT_INPUT_UNCONSUMED':run.code??'DIRECT_INPUT_NOT_ADMITTED',error:item.appliedMode==='steer'?'本轮结束前未消费该插入消息':'本轮未接纳消息'});
  }
  wake(run.conversationId);
 }
 function cancel(conversationId){for(const item of list())if(item.conversationId===conversationId&&!terminal.has(item.status)){
  if(item.status==='queued'||item.status==='sending'&&item.appliedMode==='run'&&!hasStarted(item.runId))update(item.id,{status:'cancelled',errorCode:'RUN_CANCELLED',error:'待插入消息已取消'});
  else update(item.id,{cancelRequested:true});
 }}
 function recover(){for(const item of list())if(['queued','sending','accepted'].includes(item.status))update(item.id,{status:item.status==='queued'?'cancelled':'unknown',errorCode:'DIRECT_INPUT_INTERRUPTED',error:'上次运行已中断；未自动重放插入消息'});}
 return {offer,wake,event,finish,cancel,recover,bind:(id,runId)=>update(id,{runId})};
}
