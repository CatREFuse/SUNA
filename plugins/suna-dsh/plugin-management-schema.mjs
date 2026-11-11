const deny=code=>{throw Object.assign(new Error(code),{code})};
const dangerous=new Set(['__proto__','constructor','prototype']);
const secretName=k=>/(?:token|api.?key|pass(?:word)?|secret|credential|authorization)/i.test(k);
const own=(o,k)=>o!=null&&Object.hasOwn(o,k);
const valueAt=(o,path)=>path.reduce((value,k)=>own(value,k)?value[k]:undefined,o);
const isSecret=f=>f.type==='secret'||f.fields?.some(isSecret)||f.item&&isSecret(f.item);
const label=(meta,path)=>{const v=meta?.description;return(typeof v==='string'?v:typeof v?.['zh-CN']==='string'?v['zh-CN']:path.at(-1)??'配置').slice(0,200)};
/** Project only recognized native schema leaves, never raw config or secret defaults. */
export function projectPluginConfiguration(schema,config,{isNativeConfigSchema,limit=256}={}){
 const hasSecrets=[];let count=0;
 const unsupported={fields:[],values:{},hasSecrets:[],readOnly:true,reason:'DSH_PLUGIN_SCHEMA_UNSUPPORTED'};
 if(typeof isNativeConfigSchema!=='function'||!isNativeConfigSchema(schema))return unsupported;
 function field(node,path,depth=0){
  if(!node||depth>12||++count>limit||!isNativeConfigSchema(node)||path.some(k=>dangerous.has(k)))return null;
  const meta=node.meta??{},base={path,label:label(meta,path),...(meta.required?{required:true}:{})};
  if(meta.hidden)return{...base,type:'secret',readOnly:true};
  if(['secret','password'].includes(meta.role)||secretName(path.at(-1)??''))return{...base,type:'secret'};
  if(node.type==='object'){
   if(!node.dict||typeof node.dict!=='object')return null;
   const fields=[];for(const[k,child]of Object.entries(node.dict)){const next=field(child,[...path,k],depth+1);if(!next)return null;fields.push(next)}return{...base,type:'object',fields};
  }
  if(node.type==='array'){const item=field(node.inner,[...path,'*'],depth+1);return item?{...base,type:'array',item,structureReadOnly:!!isSecret(item)}:null}
  if(node.type==='string')return{...base,type:meta.role==='textarea'?'textarea':'text',...(Number.isSafeInteger(meta.max)?{maxLength:meta.max}:{})};
  if(node.type==='number')return{...base,type:'number',...(Number.isFinite(meta.min)?{minimum:meta.min}:{}),...(Number.isFinite(meta.max)?{maximum:meta.max}:{})};
  if(node.type==='boolean')return{...base,type:'boolean'};
  if(node.type==='union'&&Array.isArray(node.list)&&node.list.every(n=>n.type==='const'&&['string','number','boolean'].includes(typeof n.value)))return{...base,type:'select',options:node.list.map(n=>({label:String(n.value).slice(0,200),value:n.value}))};
  return null;
 }
 const root=field(schema,[]);if(!root||root.type!=='object')return unsupported;
 function project(f,v,path){
  if(f.type==='secret'){if(v!==undefined&&v!==null&&v!=='')hasSecrets.push(path);return undefined}
  if(v===undefined)return undefined;
  if(f.type==='object'){if(!v||typeof v!=='object'||Array.isArray(v))return undefined;const out={};for(const child of f.fields){const k=child.path.at(-1),result=project(child,v[k],[...path,k]);if(result!==undefined)out[k]=result}return out}
  if(f.type==='array'){if(!Array.isArray(v)||v.length>512)return undefined;return v.map((item,index)=>project(f.item,item,[...path,String(index)])??null)}
  if(['string','number','boolean'].includes(typeof v)&&JSON.stringify(v).length<=16384)return v;
  return undefined;
 }
 return{fields:root.fields,values:project(root,config,[])??{},hasSecrets,readOnly:false};
}
/** Apply only explicit schema-bound leaf changes. Hidden values survive other field edits. */
export function applyPluginConfigurationChanges(schema,config,changes,options){
 const projection=projectPluginConfiguration(schema,config,options);if(projection.readOnly)deny('DSH_PLUGIN_SCHEMA_UNSUPPORTED');
 const match=(f,path)=>f.path.length===path.length&&f.path.every((k,i)=>k===path[i]||k==='*'&&/^(0|[1-9]\d*)$/.test(path[i]));
 const flat=[];const visit=f=>{flat.push(f);f.fields?.forEach(visit);if(f.item)visit(f.item)};projection.fields.forEach(visit);
 const next=structuredClone(config);
 for(const change of changes){
  if(!Array.isArray(change.path)||change.path.some(k=>typeof k!=='string'||dangerous.has(k)||k==='*'))deny('DSH_PLUGIN_INPUT_INVALID');
  const f=flat.find(f=>match(f,change.path));if(!f||f.readOnly)deny('DSH_PLUGIN_SCHEMA_UNSUPPORTED');
  if((f.type==='object'||f.type==='array')&&isSecret(f))deny('DSH_PLUGIN_SECRET_STRUCTURE');
  for(let i=0;i<change.path.length;i++)if(/^\d+$/.test(change.path[i])){const arr=valueAt(next,change.path.slice(0,i));if(!Array.isArray(arr)||Number(change.path[i])>=arr.length)deny('DSH_PLUGIN_INPUT_INVALID')}
  if(change.op==='set'){
   const v=change.value;if(f.type==='number'&&(typeof v!=='number'||!Number.isFinite(v)||f.minimum!==undefined&&v<f.minimum||f.maximum!==undefined&&v>f.maximum)||f.type==='boolean'&&typeof v!=='boolean'||['text','textarea','secret'].includes(f.type)&&(typeof v!=='string'||v.length>(f.maxLength??16384))||f.type==='select'&&!f.options.some(o=>o.value===v)||f.type==='array'&&!Array.isArray(v)||f.type==='object'&&(!v||typeof v!=='object'||Array.isArray(v)))deny('DSH_PLUGIN_INPUT_INVALID');
  }else if(change.op!=='unset'||f.required)deny('DSH_PLUGIN_INPUT_INVALID');
  let parent=next;for(const k of change.path.slice(0,-1)){if(!own(parent,k)){if(change.op==='unset'){parent=null;break}parent[k]={}}parent=parent[k];if(!parent||typeof parent!=='object')deny('DSH_PLUGIN_INPUT_INVALID')}
  if(parent){const key=change.path.at(-1);if(change.op==='unset'){if(Array.isArray(parent))deny('DSH_PLUGIN_INPUT_INVALID');delete parent[key]}else parent[key]=structuredClone(change.value)}
 }
 return next;
}
