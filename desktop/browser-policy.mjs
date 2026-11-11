// Pure input policy shared by the native host and its boundary tests.
export function conversationKey(value){
  if(typeof value!=='string'||!value.trim()||value.length>200||/[\x00-\x1f]/.test(value))throw new Error('请选择一个有效会话。');
  return value;
}
export function browserUrl(value,{input=false,deniedOrigins=[]}={}){
  if(typeof value!=='string'||value.length>8192||/[\x00-\x1f\x7f]/.test(value))throw new Error('请输入有效的网页地址。');
  let text=value.trim();
  if(input&&!/^[a-z][a-z\d+.-]*:/i.test(text))text='https://'+text;
  let url;try{url=new URL(text);}catch{throw new Error('请输入有效的网页地址。');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('浏览器仅支持不含账号密码的 HTTP 或 HTTPS 地址。');
  const loopback=host=>host==='localhost'||host.endsWith('.localhost')||host==='0.0.0.0'||/^127\./.test(host)||['[::]','[::1]'].includes(host)||/^\[::ffff:7f[\da-f]{2}:[\da-f]+\]$/i.test(host);
  if(deniedOrigins.some(origin=>{const denied=new URL(origin);return url.origin===denied.origin||loopback(url.hostname)&&loopback(denied.hostname)&&url.port===denied.port;}))throw new Error('应用内部地址不能在网页视图中打开。');
  return url.href;
}
export function browserBounds(value,size,zoom=1){
  if(!value||!['x','y','width','height'].every(k=>Number.isFinite(value[k]))||value.width<1||value.height<1)return null;
  const x=Math.max(0,Math.ceil(value.x*zoom)),y=Math.max(0,Math.ceil(value.y*zoom));
  const right=Math.min(size[0],Math.floor((value.x+value.width)*zoom)),bottom=Math.min(size[1],Math.floor((value.y+value.height)*zoom));
  return right-x>=40&&bottom-y>=40?{x,y,width:right-x,height:bottom-y}:null;
}
