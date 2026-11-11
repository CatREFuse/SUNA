import {readZip,sha256} from '../channels/archive.mjs';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=code=>{throw new Error(code)};
const safeKey=value=>typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(value)&&!['constructor','prototype','__proto__'].includes(value);
const types=new Set(['string','number','integer','boolean','object','array','null']);
const keywords=new Set(['type','properties','required','additionalProperties','items','enum','const','anyOf','minimum','maximum','minLength','maxLength','minItems','maxItems','description','title']);
export function validateToolSchema(schema,depth=0){
 if(!plain(schema)||depth>16||Buffer.byteLength(JSON.stringify(schema))>32768)fail('TOOL_SCHEMA_INVALID');
 for(const [key,value]of Object.entries(schema)){
  if(!keywords.has(key))fail('TOOL_SCHEMA_INVALID');
  if(key==='type'){const values=Array.isArray(value)?value:[value];if(!values.length||new Set(values).size!==values.length||!values.every(t=>types.has(t)))fail('TOOL_SCHEMA_INVALID');}
  else if(key==='properties'){if(!plain(value)||Object.keys(value).some(k=>!safeKey(k)))fail('TOOL_SCHEMA_INVALID');for(const child of Object.values(value))validateToolSchema(child,depth+1);}
  else if(key==='items')validateToolSchema(value,depth+1);
  else if(key==='additionalProperties'&&value!==false)fail('TOOL_SCHEMA_INVALID');
  else if(key==='required'&&(!Array.isArray(value)||value.some(v=>!safeKey(v))))fail('TOOL_SCHEMA_INVALID');
  else if(key==='anyOf'){if(!Array.isArray(value)||!value.length||value.length>16)fail('TOOL_SCHEMA_INVALID');for(const child of value)validateToolSchema(child,depth+1);}
  else if(['enum'].includes(key)&&(!Array.isArray(value)||!value.length||value.length>100))fail('TOOL_SCHEMA_INVALID');
  else if(['minLength','maxLength','minItems','maxItems'].includes(key)&&(!Number.isSafeInteger(value)||value<0||value>262144))fail('TOOL_SCHEMA_INVALID');
  else if(['minimum','maximum'].includes(key)&&(typeof value!=='number'||!Number.isFinite(value)))fail('TOOL_SCHEMA_INVALID');
  else if(['description','title'].includes(key)&&(typeof value!=='string'||value.length>4000))fail('TOOL_SCHEMA_INVALID');
 }
 return schema;
}
export function matchesToolSchema(value,schema){
 const type=t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?plain(value):t==='integer'?Number.isSafeInteger(value):typeof value===t;
 if(schema.type&&!(Array.isArray(schema.type)?schema.type:[schema.type]).some(type))return false;
 if(schema.enum&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))return false;
 if(Object.hasOwn(schema,'const')&&JSON.stringify(schema.const)!==JSON.stringify(value))return false;
 if(schema.anyOf&&!schema.anyOf.some(s=>matchesToolSchema(value,s)))return false;
 if(typeof value==='string'&&(value.includes('\0')||schema.minLength!==undefined&&value.length<schema.minLength||schema.maxLength!==undefined&&value.length>schema.maxLength))return false;
 if(typeof value==='number'&&(!Number.isFinite(value)||schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum))return false;
 if(Array.isArray(value)&&(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems||schema.items&&!value.every(v=>matchesToolSchema(v,schema.items))))return false;
 if(plain(value)){
  if(schema.required?.some(k=>!Object.hasOwn(value,k)))return false;
  for(const [k,v]of Object.entries(value)){if(schema.properties&&Object.hasOwn(schema.properties,k)){if(!matchesToolSchema(v,schema.properties[k]))return false;}else if(schema.additionalProperties===false)return false;}
 }
 return true;
}
export function validateToolPackage(manifest,files){
 if(!plain(manifest)||Buffer.byteLength(JSON.stringify(manifest))>65536||manifest.kind!=='tool'||manifest.apiVersion!==1||manifest.runtime!=='node'||!/^suna-[a-z0-9-]{1,58}$/.test(manifest.id??'')||!/^\d+\.\d+\.\d+$/.test(manifest.version??'')||typeof manifest.name!=='string'||!manifest.name.trim()||manifest.name.length>100||manifest.entry!=='index.mjs')fail('PLUGIN_MANIFEST_INVALID');
 if(!Array.isArray(manifest.capabilities)||manifest.capabilities.length>8||new Set(manifest.capabilities).size!==manifest.capabilities.length||manifest.capabilities.some(c=>c!=='image.generate'))fail('PLUGIN_CAPABILITIES_INVALID');
 if(!Array.isArray(manifest.tools)||!manifest.tools.length||manifest.tools.length>16||new Set(manifest.tools.map(t=>t.name)).size!==manifest.tools.length)fail('PLUGIN_TOOLS_INVALID');
 for(const tool of manifest.tools){
  if(!plain(tool)||!/^suna_[a-z][a-z0-9_]{0,57}$/.test(tool.name??'')||['suna_webserach','suna_webfetch'].includes(tool.name)||typeof tool.description!=='string'||!tool.description.trim()||tool.description.length>8000||tool.terminate!==false||!Number.isSafeInteger(tool.timeoutMs)||tool.timeoutMs<100||tool.timeoutMs>600000||tool.parameters?.type!=='object'||tool.parameters.additionalProperties!==false)fail('PLUGIN_TOOLS_INVALID');
  validateToolSchema(tool.parameters);
 }
 if(!plain(manifest.configSchema)||Object.keys(manifest.configSchema).length>32)fail('PLUGIN_CONFIG_SCHEMA_INVALID');
 for(const [key,field]of Object.entries(manifest.configSchema))if(!safeKey(key)||!plain(field)||!['text','number','boolean','select'].includes(field.type)||typeof field.label!=='string'||field.label.length>100||field.required!==undefined&&typeof field.required!=='boolean'||/token|secret|password|credential|api.?key/i.test(key)||field.type==='select'&&(!Array.isArray(field.options)||!field.options.length||field.options.length>100||field.options.some(o=>!['string','number','boolean'].includes(typeof o.value))))fail('PLUGIN_CONFIG_SCHEMA_INVALID');
 if(!plain(manifest.files)||!manifest.files[manifest.entry]||!files?.has('manifest.json')||files.size!==Object.keys(manifest.files).length+1)fail('PLUGIN_FILES_INVALID');
 let total=0;
 for(const [name,digest]of Object.entries(manifest.files)){
  if(!/^[A-Za-z0-9._/-]+\.(mjs|json|md|txt)$/.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..')||!(/^[a-f0-9]{64}$/.test(digest))||!files.has(name)||sha256(files.get(name))!==digest)fail('PLUGIN_FILE_INTEGRITY');
  total+=files.get(name).length;
 }
 if(total>8*1024*1024)fail('PLUGIN_ARCHIVE_SIZE');
 return manifest;
}
export function readToolPackage(bytes){const files=readZip(bytes);let manifest;try{manifest=JSON.parse(files.get('manifest.json')?.toString('utf8'))}catch{fail('PLUGIN_MANIFEST_INVALID')}validateToolPackage(manifest,files);return {manifest,files};}
export function validateToolConfig(manifest,patch,previous={},required=false){
 if(!plain(patch)||Object.keys(patch).some(k=>!Object.hasOwn(manifest.configSchema,k)))fail('PLUGIN_CONFIG_INVALID');
 const result=Object.create(null);
 for(const [key,field]of Object.entries(manifest.configSchema)){
  const value=Object.hasOwn(patch,key)?patch[key]:previous[key]??field.default;
  if(value===undefined||value===''){if(required&&field.required)fail('PLUGIN_CONFIG_REQUIRED');if(value!==undefined)result[key]=value;continue;}
  if(field.type==='number'?typeof value!=='number'||!Number.isFinite(value):field.type==='boolean'?typeof value!=='boolean':field.type==='select'?!field.options.some(o=>Object.is(o.value,value)):typeof value!=='string'||value.length>2000||/[\0\r\n]/.test(value))fail('PLUGIN_CONFIG_INVALID');
  result[key]=value;
 }
 return result;
}
