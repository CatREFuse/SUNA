export const CHAT_LAYOUT_KEY='sandbook.chat-layout.v1';
export function readChatLayout(storage){
 const fallback={layout:'tabs',collapsed:{appearance:false,groups:false,logs:false},perRound:false,open:false};
 try{const value=JSON.parse(storage?.getItem(CHAT_LAYOUT_KEY)||'null');if(!value||typeof value!=='object')return fallback;return {layout:['tabs','horizontal','vertical'].includes(value.layout)?value.layout:'tabs',collapsed:Object.fromEntries(Object.keys(fallback.collapsed).map(key=>[key,value.collapsed?.[key]===true])),perRound:value.perRound===true,open:typeof value.open==='boolean'?value.open:fallback.open};}catch{return fallback;}
}
export function writeChatLayout(storage,value){try{const normalized=readChatLayout({getItem:()=>JSON.stringify(value)});storage?.setItem(CHAT_LAYOUT_KEY,JSON.stringify(normalized));}catch{}}
