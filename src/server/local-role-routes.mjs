import {httpError} from './security.mjs';
/** Historical grant data remains stored, but no API can configure intrinsic abilities. */
export function createLocalRoleRoutes({book,writeJson,isClosing=()=>false}){
 return async(req,res,url,pathname)=>{
  const match=/^\/characters\/([^/]+)\/(local-role-grant|local-role-capabilities)$/.exec(pathname);if(!match)return false;
  if(isClosing())throw httpError(503,'SERVICE_CLOSING','服务正在关闭');
  if(match[2]==='local-role-grant')throw httpError(410,'LOCAL_ROLE_GRANT_RETIRED','本地角色能力无需权限设置');
  let characterId;try{characterId=decodeURIComponent(match[1]);}catch{throw httpError(400,'LOCAL_ROLE_INVALID','角色标识无效');}
  if(req.method!=='GET'){res.setHeader('allow','GET');throw httpError(405,'METHOD_NOT_ALLOWED','不支持此操作');}
  writeJson(res,200,book.getLocalRoleCapabilities(characterId));return true;
 };
}
