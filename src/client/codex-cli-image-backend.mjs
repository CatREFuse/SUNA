import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createCodexCliImageRunner} from './codex-cli-image-runner.mjs';
const failure=code=>Object.assign(new Error(code),{code});
export async function findCodexImageExecutable({explicit,environment=process.env}={}){
 const candidates=explicit?[explicit]:[...String(environment.PATH??'').split(path.delimiter).filter(Boolean).map(directory=>path.join(directory,'codex')),'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','/opt/homebrew/bin/codex','/usr/local/bin/codex'];
 for(const filename of candidates){if(typeof filename!=='string'||!path.isAbsolute(filename))continue;try{const real=await fs.realpath(filename),stat=await fs.stat(real);if(!stat.isFile())continue;await fs.access(real,constants.X_OK);return real;}catch{}}
 throw failure('IMAGE_CLI_UNAVAILABLE');
}
/** Client owns the command and model selection. No Client OAuth or API key is
 * read or copied: the installed CLI uses its normal local sign-in. */
export function createCodexCliImageBackend({jobRoot,executable,runner:injectedRunner,onDiagnostic}={}){
 let pending,closed=false;
 async function runner(){if(closed)throw failure('IMAGE_CLI_CLOSED');if(injectedRunner)return injectedRunner;if(!pending){pending=findCodexImageExecutable({explicit:executable}).then(value=>createCodexCliImageRunner({executable:value,jobRoot,onDiagnostic}));void pending.catch(()=>{pending=undefined;});}return pending;}
 const model=scope=>{const value=scope.config?.textModelId||'gpt-6.1-sol';if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value))throw failure('IMAGE_MODEL_UNAVAILABLE');return value;};
 return {
  async generate(input,scope){const modelId=model(scope);return(await runner()).generate(input,{...scope,modelId});},
  async available(config={},scope={}){model({config});const value=await(await runner()).available({...scope,deadline:Date.now()+15000});return value.available===true;},
  async close(){closed=true;const value=injectedRunner??await pending?.catch(()=>null);await value?.close();},
 };
}
