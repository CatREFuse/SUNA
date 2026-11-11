/** File staging is scoped to the conversation that opened the picker. */
export function createComposerDrafts({read,write,stage,makeId=()=>crypto.randomUUID(),createUrl=file=>URL.createObjectURL(file),revokeUrl=url=>URL.revokeObjectURL(url)}) {
  const urls=new Set(),controllers=new Map(),sources=new Map();let closed=false;
  async function add(conversationId,files) {
    if(closed||!conversationId)return;
    const jobs=files.map(file=>{
      const key=makeId(),previewUrl=/^image\/(png|jpeg|gif|webp)$/.test(file.type)?createUrl(file):undefined;
      if(previewUrl)urls.add(previewUrl);
      return {file,draft:{key,name:file.name,size:file.size,mime:file.type,kind:previewUrl?'image':'file',previewUrl,status:'uploading'}};
    });
    write(conversationId,[...read(conversationId),...jobs.map(job=>job.draft)]);
    for(const job of jobs)sources.set(job.draft.key,{conversationId,...job});
    await Promise.all(jobs.map(job=>run(conversationId,job)));
  }
  async function run(conversationId,{file,draft}){
      const controller=new AbortController();controllers.set(draft.key,controller);
      try {
        const descriptor=await stage(conversationId,file,controller.signal,draft.key,({loaded,total})=>{if(closed||controller.signal.aborted)return;write(conversationId,read(conversationId).map(item=>item.key===draft.key?{...item,status:'uploading',loaded,total}:item));});
        if(closed||controller.signal.aborted)return;sources.delete(draft.key);
        write(conversationId,read(conversationId).map(item=>item.key===draft.key?{...draft,...descriptor,key:draft.key,previewUrl:draft.previewUrl??descriptor.url,status:'ready'}:item));
      } catch(error) {
        if(closed||controller.signal.aborted)return;if(error?.code!=='ATTACHMENT_UNKNOWN')sources.delete(draft.key);
        write(conversationId,read(conversationId).map(item=>item.key===draft.key?{...item,status:error?.code==='ATTACHMENT_UNKNOWN'?'unknown':'error',error:String(error?.message??error)}:item));
      } finally {controllers.delete(draft.key);}
  }
  function detach(conversationId,key) {
    controllers.get(key)?.abort();controllers.delete(key);sources.delete(key);
    write(conversationId,read(conversationId).filter(item=>item.key!==key));
    // Submitted / failed bundles may still own this preview. Revoke at window teardown.
  }
  function dispose(){closed=true;for(const controller of controllers.values())controller.abort();controllers.clear();sources.clear();for(const url of urls)revokeUrl(url);urls.clear();}
  return {add,detach,dispose,async retry(conversationId,key){const job=sources.get(key);if(!job||job.conversationId!==conversationId||controllers.has(key))return;await run(conversationId,job);}};
}
