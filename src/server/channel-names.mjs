// Read-only OneBot metadata. This module never runs from snapshot/render paths.
export function createChannelNameResolver({host,getAccounts,listConversations,setDetails,cleanName=value=>typeof value==='string'?value.trim().slice(0,256):'',onChanged=()=>{},ttlMs=300000,backoffMs=30000,timeoutMs=8000,maxEntries=10000,maxAccounts=64,concurrency=2,now=Date.now}) {
  const cache=new Map(),pending=new Map(),queue=[],cancelQueries=new Set();let active=0,closed=false;
  const accounts=()=>Array.from(getAccounts());
  const signature=a=>JSON.stringify([a.pluginId,a.platform,a.characterId,a.selfId,a.config]);
  function eligible(id){const a=accounts().find(a=>a.accountId===id);return a?.platform==='qq'&&a.pluginId==='suna-napcat'&&host.listConnections().some(c=>c.accountId===id&&c.status==='connected')?a:null;}
  function pump(){while(!closed&&active<Math.max(1,Math.min(2,concurrency))&&queue.length){const job=queue.shift();active++;job.run().finally(()=>{active--;pump();});}}
  function query(accountId,action,valid){return new Promise(resolve=>{
    let settled=false,job;const cancel=()=>finish(null);const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);cancelQueries.delete(cancel);const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);resolve(value);};
    const timer=setTimeout(()=>finish(null),Math.max(1,timeoutMs));
    cancelQueries.add(cancel);job={run:async()=>{if(settled||!valid()){finish(null);return;}try{const result=await host.execute(accountId,action,{});finish(valid()&&result?.status==='ok'&&Number(result.retcode??0)===0&&Array.isArray(result.data)?result.data:null);}catch{finish(null);}}};queue.push(job);pump();
  });}
  function apply(conversation){
    if(closed||conversation.channel!=='onebot')return false;
    const target=conversation.channelTarget,entry=target&&cache.get(target.accountId),account=target&&eligible(target.accountId);
    if(!entry||!account||entry.signature!==signature(account)||target.platform!==account.platform||!['private','group'].includes(target.kind))return false;
    if(account.characterId&&!conversation.participantIds?.includes(account.characterId))return false;
    const field=target.kind==='group'?'groupName':'peerName',name=entry[target.kind].get(String(target.externalTargetId));
    if(!name||conversation.channelDetails?.[field]===name)return false;
    setDetails(conversation.id,{[field]:name});return true;
  }
  function refresh(accountId,{force=false}={}){
    if(closed)return Promise.resolve(false);
    const account=eligible(accountId);if(!account)return Promise.resolve(false);
    const stamp=signature(account),previous=cache.get(accountId);
    if(pending.has(accountId))return pending.get(accountId);
    if(previous?.signature===stamp&&(previous.retryAfter>now()||(!force&&previous.expires>now())))return Promise.resolve(false);
    const entry=previous?.signature===stamp?previous:{signature:stamp,private:new Map(),group:new Map(),expires:0,retryAfter:0};
    cache.delete(accountId);cache.set(accountId,entry);
    // Evict only idle entries. If every slot is in flight, decline extra work.
    while(cache.size>Math.max(1,maxAccounts)){const oldest=[...cache.keys()].find(id=>id!==accountId&&!pending.has(id));if(oldest===undefined){cache.delete(accountId);return Promise.resolve(false);}cache.delete(oldest);}
    const valid=()=>!closed&&cache.get(accountId)===entry&&signature(eligible(accountId)??{})===stamp;
    const task=(async()=>{
      const results=await Promise.all([query(accountId,'get_friend_list',valid),query(accountId,'get_group_list',valid)]);
      if(!valid())return false;
      let success=true;
      for(let index=0;index<2;index++){
        const rows=results[index];if(!rows){success=false;continue;}
        const kind=index===0?'private':'group',names=new Map(entry[kind]);
        for(const row of rows.slice(0,Math.max(0,maxEntries))){if(!row||typeof row!=='object')continue;const id=row[index===0?'user_id':'group_id'];if(!['string','number'].includes(typeof id)||!/^\d{1,20}$/.test(String(id)))continue;const name=index===0?(cleanName(row.remark,account)||cleanName(row.nickname,account)):cleanName(row.group_name,account);if(name)names.set(String(id),name);}
        while(names.size>Math.max(0,maxEntries))names.delete(names.keys().next().value);
        entry[kind]=names;
      }
      entry.expires=success?now()+ttlMs:0;entry.retryAfter=success?0:now()+backoffMs;
      let changed=false;for(const conversation of listConversations())changed=apply(conversation)||changed;
      if(changed)onChanged();return changed;
    })();
    pending.set(accountId,task);void task.finally(()=>{if(pending.get(accountId)===task)pending.delete(accountId);}).catch(()=>{});return task;
  }
  return {refresh,apply,invalidate(accountId){cache.delete(accountId);},close(){closed=true;cache.clear();for(const cancel of [...cancelQueries])cancel();queue.length=0;}};
}
