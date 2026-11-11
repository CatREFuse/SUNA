import {mkdir,readdir,readFile,writeFile,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
/** Plugin-owned metadata only. Each runtime generation is the sole writer of its file. */
export async function createA2aState(directory){
 await mkdir(directory,{recursive:true,mode:0o700});const runtimeId=randomUUID(),restoredContexts=[],restoredChains=[];
 for(const file of await readdir(directory)){if(!/^[a-f0-9-]{36}\.json$/.test(file))continue;const filename=path.join(directory,file);const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024)throw Error('Invalid A2A state file');const state=JSON.parse(await readFile(filename,'utf8'));if(state.protocol!==1||!Array.isArray(state.contexts)||!Array.isArray(state.closedChains))throw Error('Invalid A2A state');for(const scope of state.contexts){if(typeof scope.contextId!=='string'||!/^suna-a2a-[a-f0-9-]{36}$/.test(scope.contextId)||typeof scope.chainId!=='string')throw Error('Invalid A2A ownership');restoredContexts.push(scope.contextId);restoredChains.push(scope.chainId);}restoredChains.push(...state.closedChains);}
 const filename=path.join(directory,runtimeId+'.json');return {runtimeId,restoredContexts,restoredChains,persist:async value=>{const temporary=filename+'.tmp';await writeFile(temporary,JSON.stringify({protocol:1,runtimeId,pid:process.pid,...value}),{mode:0o600});await rename(temporary,filename);}};
}
