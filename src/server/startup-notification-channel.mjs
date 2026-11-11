// Host-only port. No renderer, model arguments or connector config selects an administrator.
export function createStartupNotificationChannel({router,host}){
  const numeric=value=>typeof value==='string'&&/^\d{5,20}$/.test(value);
  function state(target){
    let record,connection;try{record=router.account(target.accountId);connection=host.connection(target.accountId);}catch{return null;}
    const permission=router.permissionStatus({accountId:target.accountId,characterId:target.characterId});
    if(record.platform!=='qq'||record.characterId!==target.characterId||record.pluginId!==target.pluginId||record.administratorUid!==target.administratorUid||!permission.ready||permission.administratorUid!==target.administratorUid||!numeric(record.administratorUid)||connection.status!=='connected'||connection.enabled===false||connection.disposed||record.enabled===false||record.disabled===true||record.config?.enabled===false||record.config?.disabled===true)return null;
    const selfId=String(record.config?.expectedSelfId||record.selfId||'');
    if(!selfId||String(record.selfId??'')!==selfId||target.expectedSelfId&&target.expectedSelfId!==selfId)return null;
    return {record,config:record.config,connection,generation:connection.generation,selfId};
  }
  const unchanged=(target,lease)=>{const current=state(target);return current&&current.record===lease.record&&current.config===lease.config&&current.connection===lease.connection&&current.generation===lease.generation&&current.selfId===lease.selfId;};
  return {
    targets(){return router.list().connections.filter(a=>a.platform==='qq'&&numeric(a.administratorUid)&&a.administratorStatus?.ready).map(a=>({accountId:a.accountId,characterId:a.characterId,pluginId:a.pluginId,administratorUid:a.administratorUid,expectedSelfId:String(a.config?.expectedSelfId||a.selfId||'')}));},
    async prepare(target,{signal}){
      signal.throwIfAborted();const lease=state(target);if(!lease)return null;
      const status=await host.execute(target.accountId,'get_status');signal.throwIfAborted();
      if(status?.status!=='ok'||Number(status.retcode)!==0||status.data?.online!==true||status.data?.good===false||!unchanged(target,lease))return null;
      const identity=await host.execute(target.accountId,'get_login_info');signal.throwIfAborted();
      if(identity?.status!=='ok'||Number(identity.retcode)!==0||String(identity.data?.user_id)!==lease.selfId||!unchanged(target,lease))return null;
      return lease;
    },
    async send(target,lease,text,{signal}){
      if(signal.aborted||!unchanged(target,lease))throw Object.assign(new Error('STARTUP_TARGET_CHANGED'),{preDispatch:true});
      return host.execute(target.accountId,'send_msg',{message_type:'private',user_id:target.administratorUid,message:[{type:'text',data:{text}}]});
    }
  };
}
