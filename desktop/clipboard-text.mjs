// Main-only write capability. Never expose clipboard reads or permission grants.
export const MAX_CLIPBOARD_TEXT_BYTES=16*1024*1024;
const failure=(code,message)=>Object.assign(new Error(message),{code});
export function createClipboardTextHandler({applicationFrame,clipboard}){
 return async(event,text)=>{
  try{applicationFrame(event);}catch{throw failure('CLIPBOARD_WINDOW_DENIED','当前窗口无法复制');}
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>MAX_CLIPBOARD_TEXT_BYTES)throw failure('CLIPBOARD_TEXT_INVALID','复制内容无效');
  try{await clipboard.writeText(text);}catch{throw failure('CLIPBOARD_WRITE_FAILED','复制失败，请重试');}
 };
}
