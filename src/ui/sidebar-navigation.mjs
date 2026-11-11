/** Channel is a navigation entry, never a fabricated conversation or pin. */
export function channelEntryIndex(conversationCount) {
  return Math.min(4,Math.max(0,Number.isFinite(conversationCount)?Math.floor(conversationCount):0));
}
export function sidebarRoutePose(route,activeRoute) {
  return route===activeRoute?{transform:'translateX(0%)',opacity:'1'}:route==='channels'?{transform:'translateX(100%)',opacity:'1'}:{transform:'translateX(-30%)',opacity:'0'};
}
/** Keeps only the newest navigation request authoritative when animations are interrupted. */
export function createSidebarTransition({getPanes,onVisible,afterRender=()=>Promise.resolve(),readStyle=node=>getComputedStyle(node),reduced=()=>false,onSettled=()=>{},initialRoute='conversations'}) {
  let revision=0,closed=false,activeRoute=initialRoute;
  const animations=new Set(),scrolls=new Map();
  function cancel(){for(const animation of animations)animation.cancel();animations.clear();}
  async function go(route) {
    if(closed||!['conversations','channels'].includes(route))return false;
    const current=++revision,panes=getPanes(),from={};
    // Sample the rendered frame before cancelling WAAPI; reversal resumes there.
    for(const key of ['conversations','channels']){
      const node=panes[key];
      if(node&&!node.hidden){const style=readStyle(node);from[key]={transform:style.transform,opacity:style.opacity};scrolls.set(key,[node,...(node.querySelectorAll?.('*')??[])].filter(child=>child.scrollHeight>child.clientHeight||child.scrollWidth>child.clientWidth||child.scrollTop||child.scrollLeft).map(child=>({node:child,top:child.scrollTop,left:child.scrollLeft})));}
    }
    cancel();const previous=activeRoute;activeRoute=route;onVisible(['conversations','channels']);await afterRender();
    if(closed||current!==revision)return false;
    const running=[];
    for(const key of ['conversations','channels']){
      const node=panes[key];if(!node)continue;
      for(const saved of scrolls.get(key)??[]){saved.node.scrollTop=saved.top;saved.node.scrollLeft=saved.left;}
      const target=sidebarRoutePose(key,route),start=from[key]??sidebarRoutePose(key,previous);
      if(!reduced()&&typeof node.animate==='function'){
        const animation=node.animate([start,target],{duration:200,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
        animations.add(animation);running.push(animation);
      }
      Object.assign(node.style,target);
    }
    await Promise.allSettled(running.map(animation=>animation.finished));
    if(closed||current!==revision)return false;
    cancel();onVisible([route]);onSettled(route);return true;
  }
  function finishNow(){if(closed)return;revision++;cancel();for(const [key,node] of Object.entries(getPanes()))if(node)Object.assign(node.style,sidebarRoutePose(key,activeRoute));onVisible([activeRoute]);onSettled(activeRoute);}
  return {go,finishNow,close(){closed=true;revision++;cancel();}};
}
