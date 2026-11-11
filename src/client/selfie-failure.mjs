// Public selfie failure receipts contain only static text. This module neither
// retries nor resolves files, credentials, characters or external resources.
const failures=new Map([
 ['SELFIE_REFERENCES_MISSING','当前角色的自拍图库为空。','add-selfie-reference','请告知用户先为当前角色添加自拍参考图；添加完成后由用户重新发起自拍。'],
 ['SELFIE_CATALOG_UNAVAILABLE','当前角色的自拍图库记录无法读取。','repair-selfie-library','请告知用户检查并修复当前角色的自拍图库记录，再重新发起自拍。'],
 ['SELFIE_REFERENCE_UNAVAILABLE','当前角色所选自拍参考图已损坏、发生变化或无法安全读取。','replace-selfie-reference','请告知用户检查当前角色图库，重新上传该参考图；不要擅自跳过身份图、借用其他角色图片或重复读取同一失效文件。'],
 ['SELFIE_REFERENCE_FILE_MISSING','当前角色所选自拍参考图的原始文件已丢失。','replace-selfie-reference','请告知用户在当前角色的自拍图库中重新上传或替换缺失的参考图，再重新发起自拍。'],
 ['SELFIE_REFERENCE_NOT_FOUND','当前角色所选自拍参考图条目不可用。','reselect-selfie-reference','请告知用户在当前角色图库中重新选择可用参考图；不要借用其他角色图库。'],
 ['SELFIE_REFERENCES_CHANGED','当前角色的自拍图库或参考图已变更。','reselect-selfie-reference','请告知用户参考图已变化；确认当前角色的图库后，重新选择参考图并发起自拍。'],
 ['SELFIE_REFERENCE_CHANGED','当前角色所选自拍参考图已变更。','reselect-selfie-reference','请告知用户重新确认当前角色的参考图，再发起自拍。'],
 ['SELFIE_SELECTION_INVALID','自拍参考图选择无效。','reselect-selfie-reference','请告知用户检查当前角色的自拍图库，重新选择有效参考图后再发起自拍。'],
 ['SELFIE_REWRITE_FAILED','自拍提示词处理失败。','retry-selfie-request','请如实告知用户提示词处理失败；由用户确认或修改自拍要求后重新发起。'],
 ['SELFIE_REWRITE_UNAVAILABLE','自拍提示词处理服务当前不可用。','check-selfie-rewrite','请告知用户检查提示词处理服务的配置与可用状态，再重新发起自拍。'],
 ['IMAGE_CANCELLED','本次自拍的授权或执行已取消。','request-new-authorization','请告知用户本次自拍已取消；不要继续或自动重试，等待用户重新授权并发起。'],
 ['IMAGE_TIMEOUT','本次自拍生成超时。','check-before-retry','请告知用户生成超时；先检查是否已有结果，再由用户决定是否重新发起，避免重复生成。'],
 ['IMAGE_BUSY','自拍生成服务正忙。','wait-for-image-service','请告知用户等待当前生图任务结束，再重新发起自拍。'],
 ['IMAGE_CLI_CONFIGURATION_UNSAFE','本机生图权限配置未通过安全检查。','check-image-configuration','请告知用户检查本机生图服务配置；保持现有权限限制，不要绕过安全检查。'],
 ['IMAGE_CLI_OUTPUT_MISSING','本机生图未返回可验证的原生图片结果。','check-image-service','请告知用户本次没有可交付图片；检查本机原生生图能力与服务状态后，再决定是否重新发起。'],
 ['IMAGE_OUTPUT_MISSING','自拍生成服务未返回图片结果。','check-image-service','请告知用户本次没有可交付图片；检查生图服务状态后，再决定是否重新发起。'],
 ['IMAGE_CLI_UNAVAILABLE','本机生图服务当前不可用。','check-image-service','请告知用户检查本机 Codex 生图服务是否可用，再重新发起自拍。'],
 ['IMAGE_CLI_IMAGE_UNAVAILABLE','当前本机 Codex 会话不支持原生生图。','check-image-capability','请告知用户确认本机 Codex 账号与会话具有原生生图能力，再重新发起自拍。'],
 ['IMAGE_CLI_AUTH_REQUIRED','本机 Codex 尚未完成登录。','sign-in-codex','请告知用户在本机完成 Codex 登录，再重新发起自拍；不要索取或发送登录凭据。'],
 ['IMAGE_CLI_CLOSED','本机生图服务已关闭。','check-image-service','请告知用户确认本机生图服务状态，再重新发起自拍。'],
 ['IMAGE_CLI_GENERATION_FAILED','本机原生自拍生成失败。','check-image-service','请如实告知用户本次生成失败且没有可交付图片；检查服务状态后由用户决定是否重新发起。'],
 ['IMAGE_CLI_PARAMETER_UNSUPPORTED','本机生图服务拒绝了当前图片模型的请求参数。','check-image-compatibility','请告知用户检查本机 Codex 与图片模型的参数兼容性；不要自动改模型、重试或声称已生成图片。'],
 ['IMAGE_CLI_USAGE_LIMIT','本机 Codex 生图额度已达到限制。','check-image-usage-limit','请告知用户检查本机 Codex 的生图额度，等待额度恢复或由用户确认后重新发起；不要自动重试。'],
 ['IMAGE_CLI_REFERENCE_MISMATCH','原生生图使用的参考图未通过一致性校验。','verify-selfie-reference','请告知用户本次结果未采用；检查当前角色参考图后重新发起，不要使用其他角色的图库。'],
 ['IMAGE_REFERENCE_PREPARATION_UNAVAILABLE','本机参考图处理组件不可用。','check-reference-preparation','请告知用户检查本机图像处理组件是否完整；不要改用其他角色图片或跳过身份参考。'],
 ['IMAGE_REFERENCE_PREPARATION_FAILED','参考图无法安全解码或缩小到生图支持的范围。','replace-input-reference','请告知用户原件已保留；重新提供有效图片，或将图片等比缩小至最长边3840像素、总像素8294400以内再试。'],
 ['IMAGE_REFERENCE_UNAVAILABLE','本次自拍附带的输入参考图无法读取或已丢失。','replace-input-reference','请告知用户重新提供本次附带的输入参考图，再发起自拍；不要擅自改用其他图片。'],
 ['IMAGE_REFERENCE_INVALID','本次自拍的输入参考图格式或尺寸无效。','replace-input-reference','请告知用户提供符合要求的图片后重新发起自拍。'],
 ['IMAGE_REFERENCE_LIMIT','本次自拍的输入参考图数量超过限制。','reduce-input-references','请告知用户减少附带的输入参考图后重新发起自拍。'],
 ['IMAGE_PROVIDER_CHANGED','自拍生成服务配置已变更。','confirm-image-configuration','请告知用户确认当前生图配置后重新发起自拍。'],
 ['IMAGE_PROVIDER_UNAVAILABLE','自拍生成服务当前不可用。','check-image-service','请告知用户检查生图服务配置与可用状态，再重新发起自拍。'],
].map(([code,message,action,instructions])=>[code,{message,action,instructions}]));

/** stage is a trusted service phase, never an exception-provided path. Unknown
 * failures remain with the caller's existing safe exception handling. */
export function safeSelfieFailure(code,{stage}={}){
 if(stage==='catalog'&&['SELFIE_PATH_INVALID','SELFIE_CATALOG_INVALID','SELFIE_NOTE_INVALID'].includes(code))code='SELFIE_CATALOG_UNAVAILABLE';
 if(['MEDIA_PATH_INVALID','MEDIA_STORE_CORRUPT','MEDIA_FILE_CHANGED','MEDIA_INVALID_IMAGE'].includes(code)){if(stage==='identity-reference')code='SELFIE_REFERENCE_UNAVAILABLE';else if(stage==='chat-reference')code='IMAGE_REFERENCE_UNAVAILABLE';else return undefined;}
 if(code==='ENOENT'||code==='MEDIA_NOT_FOUND'){
  if(stage==='identity-reference')code='SELFIE_REFERENCE_FILE_MISSING';
  else if(stage==='chat-reference')code='IMAGE_REFERENCE_UNAVAILABLE';
  else if(stage==='catalog')code='SELFIE_CATALOG_UNAVAILABLE';
  else return undefined;
 }
 const entry=failures.get(code);if(!entry)return undefined;
 return {ok:false,status:'failed',imageAvailable:false,error:{code,message:entry.message,retryable:false,recovery:{action:entry.action,instructions:entry.instructions}},terminate:false};
}
