import {prepareModelImage} from '../core/model-image-preparation.mjs';
import {createHash} from 'node:crypto';
const failure=code=>Object.assign(new Error(code),{code});
/** Share the original-preserving decoder used by conversation images. */
export async function prepareSelfieReference(value,{signal,deadline,characterId,conversationId}={}){
 try{
  const result=await prepareModelImage(value,{signal,deadline,limits:{side:3840,pixels:8294400},scope:JSON.stringify(['native-image-reference',characterId,conversationId])});
  const data=value?.data??value?.bytes;
  if(Buffer.isBuffer(data)&&result.descriptor.sha256===createHash('sha256').update(data).digest('hex')){result.dispose();return value;}
  return result;
 }catch(error){
  if(signal?.aborted)throw failure(signal.reason?.code==='IMAGE_TIMEOUT'?'IMAGE_TIMEOUT':'IMAGE_CANCELLED');
  if(error?.code==='MESSAGE_IMAGE_PROCESSING_TIMEOUT')throw failure('IMAGE_TIMEOUT');
  if(error?.code==='MESSAGE_IMAGE_PROCESSING_UNAVAILABLE')throw failure('IMAGE_REFERENCE_PREPARATION_UNAVAILABLE');
  throw failure('IMAGE_REFERENCE_PREPARATION_FAILED');
 }
}
