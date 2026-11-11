/** Main-only, applicationFrame checked by caller. No cookie/token/path is returned to renderer. */
export function createControlledAttachmentDownload({api,getApiUrl}){
 const valid=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x);
 return async function download(webContents,input){
  if(!input||Object.keys(input).some(k=>!['conversationId','characterId','attachmentId','requestId'].includes(k))||!['conversationId','characterId','attachmentId','requestId'].every(k=>valid(input[k]))||!/^url_[a-f0-9]{48}$/.test(input.attachmentId)||webContents.isDestroyed())throw Error('附件下载请求无效');
  const grant=await api('/controlled-attachments/native-download',input),base=new URL(getApiUrl()),expected=`/api/conversations/${encodeURIComponent(input.conversationId)}/controlled-attachments/${input.attachmentId}/download`;
  if(grant.url!==expected||grant.cookie?.name!=='suna_attachment_download'||!/^[a-f0-9]{64}$/.test(grant.cookie.value)||grant.cookie.path!==expected||grant.cookie.httpOnly!==true||grant.cookie.sameSite!=='strict'||!Number.isFinite(grant.cookie.expirationDate)||grant.cookie.expirationDate*1000<=Date.now()||grant.cookie.expirationDate*1000>Date.now()+61000)throw Error('附件下载授权无效');
  const url=new URL(expected,base).href;
  await webContents.session.cookies.set({url,...grant.cookie,secure:base.protocol==='https:'});
  if(webContents.isDestroyed())throw Error('窗口已关闭');webContents.downloadURL(url);return {started:true};
 };
}
