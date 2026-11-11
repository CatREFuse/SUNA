/** Only recorded dispatch/end or recorded duration produce a span; other events are points. */
export function projectUsageTrack(items=[]){
 const events=items.map(item=>{const dispatch=Date.parse(item.dispatchedAt),recorded=Date.parse(item.time);const start=Number.isFinite(dispatch)?dispatch:recorded;const finished=Date.parse(item.finishedAt);const duration=item.timing?.totalMs;const end=item.status!=='running'&&Number.isFinite(dispatch)?Number.isFinite(finished)&&finished>=start?finished:typeof duration==='number'&&Number.isFinite(duration)&&duration>=0?start+duration:null:null;return {item,start,end};}).filter(event=>Number.isFinite(event.start));
 const first=Math.min(...events.map(event=>event.start)),last=Math.max(...events.map(event=>event.end??event.start)),span=Math.max(1,last-first);
 return {first:Number.isFinite(first)?first:null,last:Number.isFinite(last)?last:null,events:events.map(event=>({...event,left:100*(event.start-first)/span,width:event.end==null?null:100*(event.end-event.start)/span}))};
}
