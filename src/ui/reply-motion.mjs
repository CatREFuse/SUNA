/** Approved receiver motion. Presentation only: never changes messages or transport. */
export const replyMotion=Object.freeze({mode:'gradient',durationMs:480,curve:Object.freeze([.222,1,.54,1]),intervalMinMs:500,intervalMaxMs:2000,reservePx:56,softEdgePx:40});
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh',{granularity:'grapheme'}):null;
export function replyDelay(text,random=Math.random){const parts=segmenter?[...segmenter.segment(String(text??''))].map(item=>item.segment):Array.from(String(text??''));const chars=parts.filter(char=>char.trim()).length;return Math.round(500+1100*Math.min(1,chars/100)+400*Math.max(0,Math.min(1,random())));}
export function replyRoundKey(message){if(message?.sender?.type!=='character'||!message.runId&&!message.taskId)return null;return JSON.stringify([message.conversationId,message.sender.id,message.runId??message.taskId]);}
export function paceReply(message){return !!replyRoundKey(message)&&!['failed','unknown','cancelled','canceled'].includes(message.status)&&message.source?.type!=='system-error'&&!message.localPending;}
export function firstReplyBubble(message,messages){const key=replyRoundKey(message);if(!key){const index=messages.findIndex(item=>item.id===message.id),previous=messages[index-1];return !previous||previous.sender?.id!==message.sender?.id||previous.sender?.type!==message.sender?.type;}return messages.find(item=>replyRoundKey(item)===key)?.id===message.id;}
export function replyMask(height,progress,offset=0){const edge=(height+replyMotion.softEdgePx)*progress-replyMotion.softEdgePx/2-offset;return `linear-gradient(to bottom,#000 ${Math.max(0,edge-20)}px,transparent ${edge+20}px)`;}
/** One timer owns pending visibility. Clock and timers are injected for deterministic tests. */
export function createReplyQueue({onReady,now=()=>performance.now(),random=Math.random,schedule=setTimeout,cancel=clearTimeout}){
 const waiting=new Map(),rounds=new Map();let timer,closed=false;
 function arm(){if(timer!==undefined)cancel(timer);timer=undefined;if(closed||!waiting.size)return;const due=Math.min(...[...waiting.values()].map(item=>item.due));timer=schedule(()=>{timer=undefined;const time=now(),ready=[...waiting.values()].filter(item=>item.due<=time).sort((a,b)=>a.due-b.due);for(const item of ready){waiting.delete(item.key);onReady(item.key);}arm();},Math.max(0,due-now()));}
 function add(key,message){if(closed||waiting.has(key))return;const round=replyRoundKey(message);if(!round)return;const time=now(),due=Math.max(time,(rounds.get(round)??time)+replyDelay(message.text,random));rounds.set(round,due);waiting.set(key,{key,due,round});arm();}
 function remove(key){waiting.delete(key);arm();}
 function reset(){if(timer!==undefined)cancel(timer);timer=undefined;waiting.clear();rounds.clear();}
 function close(){closed=true;reset();}
 return {add,remove,reset,close,keys:()=>[...waiting.keys()]};
}
