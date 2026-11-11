/** Presentation geometry only. The input and saved scroll offsets retain ownership. */
export function composerOcclusionOffset(area,shell){
 if(!area||!shell||![area.top,area.height,shell.top,shell.height].every(Number.isFinite)||area.height<=0||shell.height<=0)return 0;
 return Math.max(0,Math.min(area.height,shell.top-area.top+shell.height/2));
}
export function bindComposerOcclusion(root,{ResizeObserver:Resize=globalThis.ResizeObserver,MutationObserver:Mutation=globalThis.MutationObserver}={}){
 let area,shell,closed=false,last=-1;
 const measure=()=>{if(closed)return;const offset=composerOcclusionOffset(area?.getBoundingClientRect(),shell?.getBoundingClientRect());if(offset===last)return;last=offset;root.style.setProperty('--composer-mask-overlap',`${offset}px`);root.classList.toggle('composer-mask-enabled',offset>0)};
 const resize=new Resize(measure);
 const connect=()=>{if(closed)return;const nextArea=root.querySelector('.composer-area'),nextShell=nextArea?.querySelector('.chat-composer');if(nextArea===area&&nextShell===shell)return;if(area)resize.unobserve(area);if(shell)resize.unobserve(shell);area=nextArea;shell=nextShell;if(area)resize.observe(area);if(shell)resize.observe(shell);measure()};
 const mutation=new Mutation(connect);mutation.observe(root,{childList:true,subtree:true});resize.observe(root);connect();
 return()=>{if(closed)return;closed=true;resize.disconnect();mutation.disconnect();root.style.removeProperty('--composer-mask-overlap');root.classList.remove('composer-mask-enabled')};
}
