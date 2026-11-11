const controllerWrites=['create','fork','prompt','updateQueue','cancel','rename','selectModel','resolveAgent'];

function addressedSessions(request) {
  if(typeof request==='string')return [request];
  if(!request||typeof request!=='object')return [];
  const ids=[request.sessionId,request.agentId,request.sourceSessionId,request.targetSessionId,request.resumeSessionId];
  for(const address of [request.address,request.source,request.target]) {
    if(address?.kind==='session'||address?.kind==='agent')ids.push(address.sessionId,address.agentId,address.id);
  }
  return ids.filter(id=>typeof id==='string');
}

// Wrap the official service's public write APIs. Preserve the receiver so Cordis
// can still supply each Gateway call's this.ctx.invocation. No private commands
// or core files are changed. Restore only wrappers we still own on unload.
export function guardSessionControllerWrites(controller,assertWritable) {
  return guardPublicMethods(controller,controllerWrites,(name,args)=>{
    for(const id of addressedSessions(args[0]))assertWritable(id);
  });
}

export function guardAgentRegistryActivation(registry,assertAllowed) {
  return guardPublicMethods(registry,['create','resume'],(_name,args)=>assertAllowed(args[0]));
}

// DSH rc.5 relays every Session detach as api-session/removed, including a
// bridge run closing its writer while retaining the durable conversation. Map
// only those reserved, already-persisted SUNA identities to the official idle
// status event. All Session teardown still runs; no writer is retained and no
// official source or private event listener table is changed.
export function guardManagedSessionVisibility(events,retainIdentity) {
  return guardPublicMethods(events,['emit'],()=>{},(_name,args)=>{
    const offset=typeof args[0]==='string'?0:1;
    if(args[offset]!=='api-session/removed'||!retainIdentity(args[offset+1]))return args;
    return [...args.slice(0,offset),'api-session/status',args[offset+1],false];
  });
}

function guardPublicMethods(controller,names,check,mapArgs=(_name,args)=>args) {
  const installed=[];let enabled=true;
  for(const name of names) {
    const own=Object.getOwnPropertyDescriptor(controller,name);
    let descriptor=own;
    for(let proto=Object.getPrototypeOf(controller);!descriptor&&proto;proto=Object.getPrototypeOf(proto))descriptor=Object.getOwnPropertyDescriptor(proto,name);
    if(typeof descriptor?.value!=='function')continue;
    const original=descriptor.value;
    const wrapper=function(...args){if(enabled){check(name,args);args=mapArgs(name,args);}return Reflect.apply(original,this,args);};
    Object.defineProperty(controller,name,{configurable:true,writable:true,enumerable:own?.enumerable??false,value:wrapper});
    installed.push({name,own,wrapper});
  }
  return ()=>{
    enabled=false;
    for(const {name,own,wrapper} of installed) {
      if(Object.getOwnPropertyDescriptor(controller,name)?.value!==wrapper)continue;
      if(own)Object.defineProperty(controller,name,own);else delete controller[name];
    }
  };
}

/**
 * Reserve SUNA sessions for bridge-created Agent instances. DSH's agent/created
 * event is awaited before queued input is released; rejecting it rolls back the
 * new Agent and closes its persistence handle. It does not delete session data.
 *
 * A reservation must outlive its AgentHandle: release only after dispose settles.
 * Aborting a request alone is not proof that its writer has finished closing.
 */
export function createSessionOwnershipGuard(ctx, {isManagedSession} = {}) {
  if (typeof isManagedSession !== 'function') throw new TypeError('isManagedSession must be a function');
  const reservations = new Map();
  // Failed context persistence can leave a newly assigned ID in the bridge's
  // in-memory map. Keep it unconfirmed across retries in this plugin lifetime.
  const unconfirmed = new Set();
  const owners = new WeakMap();
  let closed = false;

  // Context.emit is the public Cordis Events service mixin. Interpose on its
  // public method rather than suppressing session/disposed (which must release
  // persistence, projections, observers and every other lifecycle resource).
  const restoreVisibility=ctx.events?guardManagedSessionVisibility(ctx.events,
    id=>typeof id==='string'&&reservations.get(id)?.persisted===true&&isManagedSession(id)):undefined;

  const ownedError = () => Object.assign(
    new Error('此会话由沙之书管理，请在沙之书中继续对话。'),
    {name: 'SunaSessionOwnershipError', code: 'SUNA_SESSION_MANAGED'},
  );
  const unregister = ctx.on('agent/created', ({agent}) => {
    if (!reservations.has(agent.id) && !isManagedSession(agent.id)) return;
    const reservation = reservations.get(agent.id);
    if (!reservation || owners.get(agent) !== reservation) throw ownedError();
  }, {global: true});
  // Cold GUI follow promotes a persisted observation after sending its snapshot.
  // Refuse that resume before a Session/writer exists: rejecting agent/created
  // alone rolls it back with session/disposed, which removes the GUI list row.
  const restoreActivation=ctx.agents?guardAgentRegistryActivation(ctx.agents,request=>{
    const id=request?.resumeSessionId??request?.sessionId;
    if(typeof id!=='string'||(!reservations.has(id)&&!isManagedSession(id)))return;
    const reservation=reservations.get(id);
    if(!reservation?.setups.has(request.setup))throw ownedError();
  }):undefined;
  // The GUI can reuse an active Agent without agent/created. Guard admission at
  // the public SessionController boundary before any input, queue, or cancel write.
  const controllerHook=ctx.inject?.(['sessionController'],scope=>{
    scope.effect(()=>guardSessionControllerWrites(scope.sessionController,id=>{
      if(reservations.has(id)||isManagedSession(id))throw ownedError();
    }));
  });

  return {
    reserve(sessionId) {
      if (closed) throw new Error('SUNA session ownership guard is closed');
      if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId must be a nonempty string');
      if (reservations.has(sessionId)) throw Object.assign(new Error('SUNA session already has an active bridge reservation'), {code: 'SUNA_SESSION_BUSY'});
      const reservation = {setups:new WeakSet(),persisted:isManagedSession(sessionId)&&!unconfirmed.has(sessionId)};
      if(!reservation.persisted)unconfirmed.add(sessionId);
      reservations.set(sessionId, reservation);
      let marked;
      let released = false;
      return {
        confirmPersisted() {
          if(released||closed||reservations.get(sessionId)!==reservation)throw new Error('SUNA session reservation is no longer active');
          if(!isManagedSession(sessionId))throw new Error('SUNA session context mapping is missing');
          reservation.persisted=true;unconfirmed.delete(sessionId);
        },
        authorizeSetup(setup) {
          if(released||closed||reservations.get(sessionId)!==reservation)throw new Error('SUNA session reservation is no longer active');
          if(typeof setup!=='function')throw new TypeError('Agent setup must be a function');
          reservation.setups.add(setup);return setup;
        },
        mark(agent) {
          if (released || closed || reservations.get(sessionId) !== reservation) throw new Error('SUNA session reservation is no longer active');
          if (!agent || typeof agent !== 'object' || agent.id !== sessionId) throw new TypeError('Agent does not match the reserved session');
          if (marked && marked !== agent) throw new Error('SUNA session reservation already has an Agent');
          marked = agent;
          owners.set(agent, reservation);
        },
        release() {
          if (released) return;
          released = true;
          if (marked) owners.delete(marked);
          if (reservations.get(sessionId) === reservation) reservations.delete(sessionId);
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      reservations.clear();
      unconfirmed.clear();
      restoreVisibility?.();
      restoreActivation?.();
      await controllerHook?.dispose();
      await unregister();
    },
  };
}
