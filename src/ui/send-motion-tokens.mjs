/** User-approved Vue motion console export, 2026-11-07. Direct mode has no phase split. */
export const sendMotion=Object.freeze({mode:'direct',path:'arc',bend:1,textMode:'single-entity',durationMs:600,incomingMs:480,shape:Object.freeze([0,1,0,1]),x:Object.freeze([.263,.998,.448,1]),y:Object.freeze([.222,1,.54,1]),placeholderMs:140,keepComposerVisible:true});
export const mix=(a,b,t)=>a+(b-a)*t;
export const clamp=t=>Math.max(0,Math.min(1,t));
export const smooth=t=>{t=clamp(t);return t*t*(3-2*t)};
/** @param {number} progress @param {readonly number[]} curve */
export function bezier(progress,curve){const [x1,y1,x2,y2]=curve;const p=clamp(progress),sample=(t,a,b)=>3*(1-t)*(1-t)*t*a+3*(1-t)*t*t*b+t*t*t;let lo=0,hi=1;for(let i=0;i<30;i++){const t=(lo+hi)/2;if(sample(t,x1,x2)<p)lo=t;else hi=t}return p===0?0:p===1?1:sample((lo+hi)/2,y1,y2)}
export function sendProgress(p){return {shape:bezier(p,sendMotion.shape),x:bezier(p,sendMotion.x),y:bezier(p,sendMotion.y)}}
export function pathPoint(start,end,px,py,bend=sendMotion.bend){const cx=(start.x+end.x)/2+(end.x-start.x)/2*bend,cy=(start.y+end.y)/2+(start.y-end.y)/2*bend;return {x:(1-px)**2*start.x+2*(1-px)*px*cx+px**2*end.x,y:(1-py)**2*start.y+2*(1-py)*py*cy+py**2*end.y}}
export function sendGeometry(from,to,p){const s=sendProgress(p),width=mix(from.width,to.width,s.shape),height=mix(from.height,to.height,s.shape),center=pathPoint({x:from.x+from.width/2,y:from.y+from.height/2},{x:to.x+to.width/2,y:to.y+to.height/2},s.x,s.y);return {...s,width,height,x:center.x-width/2,y:center.y-height/2}}
