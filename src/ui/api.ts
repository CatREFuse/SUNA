let csrf = ''
export async function request<T=any>(path:string,body?:unknown,method?:string,retried=false,signal?:AbortSignal):Promise<T> {
  const response=await fetch(`/api${path}`,{method:method??(body===undefined?'GET':'POST'),headers:{'content-type':'application/json',...(csrf?{'x-sandbook-csrf':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{})})
  const result=await response.json()
  if(response.status===403&&result.code==='CSRF_REQUIRED'&&!retried){await request('/bootstrap',undefined,undefined,false,signal);return request<T>(path,body,method,true,signal)}
  if(!response.ok)throw Object.assign(new Error(result.error??`请求失败 (${response.status})`),{status:response.status,code:result.code,...(result.acceptance?{receipt:result}:result.receipt?{receipt:result.receipt}:{}),...(result.deliveryUncertain===true?{deliveryUncertain:true}:{})})
  if(result.csrfToken)csrf=result.csrfToken
  return result
}
export async function upload(path:string,file:File) {
  const bytes=new Uint8Array(await file.arrayBuffer());let binary=''
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192))
  return request(path,{name:file.name,data:btoa(binary)})
}
export function download(name:string,value:unknown){
  const blob=new Blob([typeof value==='string'?value:JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob)
  const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
