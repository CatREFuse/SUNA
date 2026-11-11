import {prefersReducedMotion,sanitizeSnapshotIds} from './ui-motion.mjs';
import {sendMotion,sendProgress,sendGeometry,mix,smooth,clamp} from './send-motion-tokens.mjs';
const paintProperties=['color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','white-space','word-break','overflow-wrap','padding','border-radius','background-color','background-image','box-shadow','display','gap','margin','max-width','min-width','box-sizing','object-fit'];
function paintedCopy(node){const copy=node.cloneNode(true),originals=[node,...node.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];originals.forEach((original,i)=>{const clone=copies[i],css=getComputedStyle(original);for(const name of paintProperties)clone.style.setProperty(name,css.getPropertyValue(name));if(original.tagName==='TEXTAREA'){clone.value=original.value;clone.scrollTop=original.scrollTop;clone.style.height=original.getBoundingClientRect().height+'px';clone.style.caretColor='transparent';clone.placeholder=''}});copy.querySelectorAll('button,.composer-placeholder').forEach(n=>n.remove());sanitizeSnapshotIds(copy);copy.inert=true;copy.setAttribute('aria-hidden','true');return copy}
const color=value=>{const parts=String(value??'transparent').match(/[\d.]+/g)?.map(Number)??[0,0,0,0];return [parts[0],parts[1],parts[2],parts[3]??1]};
/** Capture before Vue clears the old DOM. Transport must never await play(). */
export function createSendAnimation(source,{reduced=prefersReducedMotion}={}){
 if(!source?.isConnected||document.hidden||reduced())return null;
 const from=source.getBoundingClientRect();if(!from.width||!from.height)return null;
 const style=getComputedStyle(source),sourceColor=color(style.backgroundColor),sourceRadius=parseFloat(style.borderRadius)||0,copy=paintedCopy(source);
 const field=source.querySelector('textarea'),fieldRect=field?.getBoundingClientRect()??from,editHost=source.querySelector('.chat-composer-field-host'),editBox=editHost?.getBoundingClientRect()??fieldRect,fieldCSS=getComputedStyle(field??source),sourceFont=parseFloat(fieldCSS.fontSize)||14,sourceLine=parseFloat(fieldCSS.lineHeight)||20,sourceTextColor=color(fieldCSS.color),sourceScroll=(field?.scrollTop??0)+(editHost?.scrollTop??0),pad=name=>parseFloat(fieldCSS[name])||0,sourceBox={x:fieldRect.x-from.x+pad('paddingLeft'),y:editBox.y-from.y+pad('paddingTop'),width:fieldRect.width-pad('paddingLeft')-pad('paddingRight'),height:Math.min(fieldRect.height,editBox.height)};
 copy.querySelectorAll('textarea,.chat-composer-reply').forEach(node=>node.remove());
 const text=document.createElement('div');text.className='send-morph-text';text.textContent=field?.value??'';Object.assign(text.style,{position:'relative',fontFamily:fieldCSS.fontFamily,fontWeight:fieldCSS.fontWeight,fontSize:sourceFont+'px',lineHeight:sourceLine+'px',whiteSpace:'pre-wrap',overflowWrap:'anywhere',margin:'0',padding:'0',color:fieldCSS.color,top:-sourceScroll+'px'});
 const textHost=document.createElement('div');Object.assign(textHost.style,{position:'absolute',overflow:'hidden',left:sourceBox.x+'px',top:sourceBox.y+'px',width:sourceBox.width+'px',height:sourceBox.height+'px'});textHost.append(text);
 const visual=document.createElement('div');visual.className='send-morph-visual';visual.inert=true;visual.setAttribute('aria-hidden','true');
 Object.assign(visual.style,{position:'fixed',left:'0',top:'0',zIndex:'100',pointerEvents:'none',overflow:'hidden',boxSizing:'border-box',contain:'layout paint',width:from.width+'px',height:from.height+'px',borderRadius:sourceRadius+'px',backgroundColor:style.backgroundColor,transform:`translate(${from.x}px,${from.y}px)`});
 Object.assign(copy.style,{position:'absolute',inset:'0 auto auto 0',width:from.width+'px',height:from.height+'px',margin:'0',transition:'none',background:'transparent',boxShadow:'none',border:'none'});visual.append(copy);visual.append(textHost);document.body.append(visual);
 let closed=false,played=false,frame=0,lease,composer,targetCopy,targetNode;
 const media=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):null;
 function cleanup(completed=false){if(closed)return;closed=true;cancelAnimationFrame(frame);text.removeAttribute('style');visual.remove();composer?.finish();lease?.release(completed);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',interrupt);media?.removeEventListener?.('change',preference);lease?.viewport.removeEventListener('wheel',interrupt);lease?.viewport.removeEventListener('touchstart',interrupt);lease?.viewport.removeEventListener('keydown',interrupt);lease?.viewport.removeEventListener('pointerdown',interrupt)}
 function interrupt(event){if(event?.type==='keydown'&&!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))return;cleanup()}
 function visibility(){if(document.hidden)cleanup()}
 function preference(){if(media?.matches)cleanup()}
 document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',interrupt);media?.addEventListener?.('change',preference);
 return {cancel:interrupt,play(nextLease,nextComposer){
  if(closed||played||!nextLease||!nextComposer){nextLease?.release(false);nextComposer?.finish();cleanup();return}
  played=true;lease=nextLease;composer=nextComposer;lease.adoptEntity?.(text);
  const viewport=lease.viewport,scrollBefore=viewport.scrollTop,distance=Math.max(0,viewport.scrollHeight-viewport.clientHeight-scrollBefore);
  viewport.addEventListener('wheel',interrupt,{passive:true});viewport.addEventListener('touchstart',interrupt,{passive:true});viewport.addEventListener('keydown',interrupt);viewport.addEventListener('pointerdown',interrupt);
  let start;
  const tick=now=>{
   if(closed)return;
   const row=lease.row(),target=row?.querySelector('[data-morph-target]');if(!row?.isConnected||!target||!source.isConnected||document.hidden||reduced()){cleanup();return}
   if(start===undefined)start=now;
   try{
    const p=clamp((now-start)/sendMotion.durationMs),py=sendProgress(p).y,natural=composer.naturalHeight(),held=mix(from.height,natural,py);
    composer.setHeight(held);
    if(targetNode!==target){targetCopy?.remove();targetCopy=paintedCopy(target);targetCopy.querySelectorAll('.message-text').forEach(node=>node.remove());targetNode=target;Object.assign(targetCopy.style,{position:'absolute',inset:'0 auto auto 0',margin:'0',maxWidth:'none',background:'transparent',boxShadow:'none',border:'none'});visual.append(targetCopy)}
    const top=row.getBoundingClientRect().top,naturalRow=Math.max(0,...[...row.children].map(child=>child.getBoundingClientRect().bottom-top));
    row.style.height=naturalRow*py+'px';row.style.marginTop=lease.gap()*py+'px';
    const bottom=Math.max(0,viewport.scrollHeight-viewport.clientHeight);viewport.scrollTop=Math.max(0,bottom-distance*(1-py));
    const landing=target.getBoundingClientRect(),remaining=Math.max(0,viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop),to={x:landing.x,y:landing.y-remaining+held-natural,width:landing.width,height:landing.height},g=sendGeometry(from,to,p),css=getComputedStyle(target),targetColor=color(css.backgroundColor),radius=parseFloat(css.borderRadius)||0;
    Object.assign(visual.style,{transform:`translate(${g.x}px,${g.y}px)`,width:g.width+'px',height:g.height+'px',borderRadius:mix(sourceRadius,radius,g.shape)+'px',backgroundColor:`rgba(${sourceColor.map((v,i)=>mix(v,targetColor[i],g.shape)).join(',')})`});
    Object.assign(targetCopy.style,{width:to.width+'px',height:to.height+'px',opacity:String(smooth((p-.18)/.7))});copy.style.opacity=String(1-smooth((p-.08)/.64));
    const body=target.querySelector('.message-text'),bodyRect=body?.getBoundingClientRect(),textCSS=getComputedStyle(body??target),targetBox=bodyRect?{x:bodyRect.x-landing.x,y:bodyRect.y-landing.y,width:bodyRect.width,height:bodyRect.height}:{x:parseFloat(css.paddingLeft)||0,y:parseFloat(css.paddingTop)||0,width:to.width-(parseFloat(css.paddingLeft)||0)-(parseFloat(css.paddingRight)||0),height:to.height-(parseFloat(css.paddingTop)||0)-(parseFloat(css.paddingBottom)||0)},targetTextColor=color(textCSS.color);
    Object.assign(textHost.style,{left:mix(sourceBox.x,targetBox.x,g.shape)+'px',top:mix(sourceBox.y,targetBox.y,g.shape)+'px',width:mix(sourceBox.width,targetBox.width,g.shape)+'px',height:mix(sourceBox.height,targetBox.height,g.shape)+'px'});
    Object.assign(text.style,{fontSize:mix(sourceFont,parseFloat(textCSS.fontSize)||15,g.shape)+'px',lineHeight:mix(sourceLine,parseFloat(textCSS.lineHeight)||22,g.shape)+'px',top:-sourceScroll*(1-g.shape)+'px',color:`rgba(${sourceTextColor.map((v,i)=>mix(v,targetTextColor[i],g.shape)).join(',')})`});
    if(p<1)frame=requestAnimationFrame(tick);else cleanup(true);
   }catch{cleanup()}
  };frame=requestAnimationFrame(tick);
 }};
}
