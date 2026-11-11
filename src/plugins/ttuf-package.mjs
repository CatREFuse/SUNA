import {validatePluginUI} from './ui-package.mjs';
import {readZip,sha256} from '../channels/archive.mjs';
const types=new Set(['text','string','secret','number','boolean','textarea','select','conversation','character','channel-conversation']);
const name=value=>typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(value)&&!['constructor','prototype','__proto__'].includes(value);
export function validateTtufPackage(manifest,files){
  if(!manifest||manifest.kind!=='ttuf'||manifest.apiVersion!==1||manifest.runtime!=='node'||!/^suna-[a-z0-9-]{1,58}$/.test(manifest.id??'')||!/^\d+\.\d+\.\d+$/.test(manifest.version??'')||typeof manifest.name!=='string'||!manifest.name.trim()||manifest.name.length>100||manifest.entry!=='index.mjs')throw new Error('PLUGIN_MANIFEST_INVALID');
  if(!Array.isArray(manifest.capabilities)||manifest.capabilities.some(value=>!['runtime.ttm','channel.send'].includes(value)))throw new Error('PLUGIN_CAPABILITIES_INVALID');
  if(!manifest.configSchema||typeof manifest.configSchema!=='object'||Array.isArray(manifest.configSchema)||Object.keys(manifest.configSchema).length>32)throw new Error('PLUGIN_CONFIG_SCHEMA_INVALID');
  for(const [key,field] of Object.entries(manifest.configSchema)){
    if(!name(key)||!field||!types.has(field.type)||typeof field.label!=='string'||field.label.length>100||field.required!==undefined&&typeof field.required!=='boolean')throw new Error('PLUGIN_CONFIG_SCHEMA_INVALID');
    if(field.type==='select'&&(!Array.isArray(field.options)||!field.options.length||field.options.length>100||field.options.some(item=>{const value=item&&typeof item==='object'?item.value:item;return !['string','boolean','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)})))throw new Error('PLUGIN_CONFIG_SCHEMA_INVALID');
  }
  if(!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files)||!manifest.files[manifest.entry]||files.size!==Object.keys(manifest.files).length+1||!files.has('manifest.json'))throw new Error('PLUGIN_FILES_INVALID');
  for(const [file,digest] of Object.entries(manifest.files))if(!/^[a-zA-Z0-9._/-]+\.(mjs|json|md|txt|html)$/.test(file)||file.startsWith('/')||file.split('/').some(part=>!part||part==='.'||part==='..')||!/^([a-f0-9]{64})$/.test(digest)||!files.has(file)||sha256(files.get(file))!==digest)throw new Error('PLUGIN_FILE_INTEGRITY');
  validatePluginUI(manifest,files);
  return manifest;
}
export function readTtufPackage(bytes){const files=readZip(bytes);let manifest;try{manifest=JSON.parse(files.get('manifest.json')?.toString('utf8'))}catch{throw new Error('PLUGIN_MANIFEST_INVALID')}validateTtufPackage(manifest,files);return {manifest,files};}
export function validateTtufConfig(manifest,patch,prior={},required=false){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).length>32)throw new Error('PLUGIN_CONFIG_INVALID');
  for(const key of Object.keys(patch))if(!Object.hasOwn(manifest.configSchema,key))throw new Error('PLUGIN_CONFIG_UNKNOWN_FIELD');
  const config=Object.create(null);
  for(const [key,field] of Object.entries(manifest.configSchema)){
    const value=Object.hasOwn(patch,key)?patch[key]:prior[key]??field.default;
    if(value===undefined||value===''&&field.type!=='secret'){if(required&&field.required)throw new Error(`PLUGIN_CONFIG_REQUIRED:${key}`);if(value!==undefined)config[key]=value;continue;}
    if(field.type==='boolean'?typeof value!=='boolean':field.type==='number'?typeof value!=='number'||!Number.isFinite(value):field.type==='select'?!field.options.some(item=>Object.is(item&&typeof item==='object'?item.value:item,value)):typeof value!=='string'||value.length>50000)throw new Error(`PLUGIN_CONFIG_INVALID:${key}`);
    if(required&&field.required&&value==='')throw new Error(`PLUGIN_CONFIG_REQUIRED:${key}`);
    config[key]=value;
  }
  return config;
}
