// Only Host-owned image generation is available; no transport, credentials or send capability.
export function execute(name,args,{call}){
 if(!['suna_generate_image','suna_selfie'].includes(name))throw new Error('IMAGE_TOOL_INVALID');
 return call('image.generate',args);
}
