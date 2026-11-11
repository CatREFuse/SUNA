import {httpError} from './security.mjs';

const invalid=message=>{throw httpError(400,'PROFILE_INVALID',message);};
function decode(value){try{return decodeURIComponent(value);}catch{invalid('画像标识编码无效');}}
function one(params,key){const values=params.getAll(key);if(values.length>1)invalid('画像查询参数不能重复');return values[0];}
function validateQueryEncoding(url){
  // URLSearchParams repairs malformed percent encodings; reject them before parsing.
  try{decodeURIComponent(url.search.slice(1).replaceAll('+',' '));}catch{invalid('画像查询参数编码无效');}
}
function options(url,characterId){
  const result={characterId};
  for(const key of ['offset','limit']){const value=one(url.searchParams,key);if(value===undefined)continue;if(!/^(0|[1-9]\d*)$/.test(value))invalid('画像分页参数无效');const parsed=Number(value);if(!Number.isSafeInteger(parsed)||key==='offset'&&parsed>1000000||key==='limit'&&(parsed<1||parsed>100))invalid('画像分页参数超出范围');result[key]=parsed;}
  const query=one(url.searchParams,'query');if(query!==undefined){if(!query.trim()||query.length>500||query.includes('\0'))invalid('画像搜索内容无效');result.query=query;}
  const kind=one(url.searchParams,'kind');if(kind!==undefined){if(!['human','character'].includes(kind))invalid('画像对象类型无效');result.kind=kind;}
  return result;
}

/** Read-only API; the host must perform its ordinary origin/security checks first. */
export function createPersonProfileRoutes({profiles,writeJson,isClosing=()=>false}={}){
  if(typeof profiles?.list!=='function'||typeof profiles?.detail!=='function'||typeof writeJson!=='function')throw new TypeError('Profile routes require scoped list/detail and JSON writer');
  return async function handle(req,res,url,pathname){
    const match=/^\/characters\/([^/]+)\/profiles(?:\/([^/]+))?$/.exec(pathname);
    if(!match)return false;
    if(isClosing())throw httpError(503,'SERVICE_CLOSING','沙之书正在关闭');
    if(req.method!=='GET'){res.setHeader('allow','GET');throw httpError(405,'METHOD_NOT_ALLOWED','人物画像查看接口只支持 GET');}
    validateQueryEncoding(url);
    const characterId=decode(match[1]);
    try{
      const result=match[2]?await profiles.detail({characterId,id:decode(match[2])}):await profiles.list(options(url,characterId));
      if(isClosing())throw httpError(503,'SERVICE_CLOSING','沙之书正在关闭');
      writeJson(res,200,result);return true;
    }catch(error){
      if(['PROFILE_NOT_FOUND','CHARACTER_NOT_FOUND'].includes(error.code))throw httpError(404,error.code,error.message);
      if(error.code==='PROFILE_INVALID'&&!error.status)throw httpError(400,error.code,error.message);
      throw error;
    }
  };
}
