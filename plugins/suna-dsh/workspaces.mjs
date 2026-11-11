import {realpath} from 'node:fs/promises';

// Register existing directories without moving files or rewriting immutable session headers.
export function createWorkspaceMapping(ctx, contexts) {
  async function register({cwd,title}) {
    if(typeof cwd!=='string'||typeof title!=='string'||!title.trim())throw new TypeError('Workspace requires cwd and title');
    const workspace=await ctx.workspaceRegistry.create(cwd,title);
    if(workspace.title!==title)await workspace.setTitle(title);
    return workspace;
  }
  return {
    async attach(spec,sessionId) {const workspace=await register(spec);await workspace.attachSession(sessionId);return workspace;},
    async sync(specs) {
      if(!Array.isArray(specs)||specs.length>1000)throw new TypeError('Invalid workspace list');
      const workspaces=[];
      for(const spec of specs)workspaces.push(await register(spec));
      const byPath=new Map(workspaces.map(workspace=>[workspace.path,workspace]));
      const managed=new Set(Object.values(contexts));
      // Persistence reads do not acquire an Agent writer or resume a conversation.
      const snapshots=await ctx.sessionPersistence.list();
      for(const {header} of snapshots) {
        if(!managed.has(header.id)||!header.cwd)continue;
        let cwd;try{cwd=await realpath(header.cwd);}catch(error){if(error.code==='ENOENT')continue;throw error;}
        const workspace=byPath.get(cwd);
        if(workspace)await workspace.attachSession(header.id);
      }
      return {workspaces:workspaces.map(workspace=>({id:workspace.id,title:workspace.title,path:workspace.path,sessionIds:[...workspace.sessionIds]}))};
    },
  };
}
