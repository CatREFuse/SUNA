const composerFlags=['composerAttachmentsV1','composerScreenCaptureV1'];
/** Normalize only server-supplied composer flags; this grants no permission. */
export function normalizeSnapshotCapabilities(snapshot){
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))return snapshot;
 const original=snapshot.capabilities;
 const capabilities=original&&typeof original==='object'&&!Array.isArray(original)?original:{};
 let normalized;
 for(const key of composerFlags){
  const nested=Object.hasOwn(capabilities,key);
  if(!nested&&!Object.hasOwn(snapshot,key))continue;
  const value=(nested?capabilities[key]:snapshot[key])===true;
  if(nested&&capabilities[key]===value)continue;
  normalized??={...capabilities};normalized[key]=value;
 }
 return normalized?{...snapshot,capabilities:normalized}:snapshot;
}
