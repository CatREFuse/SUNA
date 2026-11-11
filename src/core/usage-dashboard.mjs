const dayMs=86400000;
const ordinal=key=>Date.parse(key+'T00:00:00Z')/dayMs;
const dayKey=number=>new Date(number*dayMs).toISOString().slice(0,10);
/** Pure projection over the protected, normalized ledger; no raw prompts or tool payloads. */
export function usageDashboard(records,{range='all',timeZone='Asia/Shanghai',now=new Date().toISOString(),aggregate}={}){
 if(!['today','7d','30d','all'].includes(range))throw new TypeError('Invalid usage range');
 const fmt=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
 const local=value=>{const p=Object.fromEntries(fmt.formatToParts(new Date(value)).map(x=>[x.type,x.value]));return {day:`${p.year}-${p.month}-${p.day}`,hour:p.hour};};
 const end=Date.parse(now);if(!Number.isFinite(end))throw new TypeError('Invalid clock');
 const today=local(now).day;
 const eligible=records.filter(row=>Number.isFinite(Date.parse(row.time))&&Date.parse(row.time)<=end);
 const start=range==='all'?eligible.reduce((a,row)=>local(row.time).day<a?local(row.time).day:a,today):dayKey(ordinal(today)-(range==='7d'?6:range==='30d'?29:0));
 const rows=eligible.filter(row=>local(row.time).day>=start);
 const models=list=>list.filter(row=>row.category!=='client-function');
 const grouped=list=>({worker:aggregate(list.filter(row=>row.category==='client-worker')),runtime:aggregate(list.filter(row=>row.category==='runtime-loop'))});
 const describe=list=>({requests:models(list).length,failed:models(list).filter(row=>['failed','timeout','interrupted','rejected'].includes(row.status)).length,cancelled:models(list).filter(row=>['cancelled','canceled'].includes(row.status)).length,total:aggregate(models(list)),...grouped(list)});
 const days=Math.max(1,ordinal(today)-ordinal(start)+1),step=Math.max(1,Math.ceil(days/30));
 const bins=Array.from({length:range==='today'?24:Math.ceil(days/step)},(_,i)=>({key:range==='today'?String(i).padStart(2,'0'):dayKey(ordinal(start)+i*step),rows:[]}));
 for(const row of rows){const at=local(row.time),index=range==='today'?Number(at.hour):Math.floor((ordinal(at.day)-ordinal(start))/step);bins[index]?.rows.push(row);}
 const rounds=new Map();for(const row of rows){const key=row.roundId??row.triggerId??null;const list=rounds.get(key)??[];list.push(row);rounds.set(key,list);}
 return {schemaVersion:1,range,timeZone,startDay:start,endDay:today,asOf:now,tokenBasis:'input+cacheRead+cacheWrite+output; reasoning included in output',...describe(rows),buckets:bins.map(bin=>({key:bin.key,label:range==='today'?bin.key+':00':bin.key.slice(5),...describe(bin.rows)})),rounds:[...rounds].map(([roundId,list])=>({roundId,startedAt:list.reduce((a,row)=>row.time<a?row.time:a,list[0].time),firstSequence:list.reduce((min,row)=>Math.min(min,row.sequence),Infinity),records:list.length,...describe(list)})).sort((a,b)=>b.firstSequence-a.firstSequence)};
}
