import {assembleRuntimePrompts} from './prompts.mjs';
import {wrapClientDeveloperPrompt} from '../../plugins/suna-dsh/client-prompt-xml.mjs';
const clone=value=>structuredClone(value);
export {wrapClientDeveloperPrompt};
export function splitClientRuntimePrompts({system,developer='',developerEnabled=true}={}) { return {system:String(system??''),developer:String(developer??''),developerPrompt:developerEnabled?String(developer??''):'',migratedDeveloper:'',moved:[],changed:false}; }
export function assembleClientRuntimePrompts({system,developer='',developerEnabled=true,...input},options={}) { const layers=splitClientRuntimePrompts({system,developer,developerEnabled}); const result=assembleRuntimePrompts({...input,system:layers.system,developer:layers.developerPrompt},{...options,separateDeveloper:true}); if(typeof result.developerPrompt!=='string') throw Object.assign(new Error('Client prompt layers are unavailable'),{code:'CLIENT_PROMPT_LAYERS_UNAVAILABLE'}); return result; }
export function projectClientPromptDefaults(entries) { return clone(entries); }
export function planClientPromptLayerMigration() { return {changes:[],blocked:[]}; }
