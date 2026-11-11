import {createHash} from 'node:crypto';
const hash=text=>createHash('sha256').update(text).digest('hex');
// Reviewed generated Client guidance only. Unknown/custom prose never qualifies.
const generated=new Set(['041a29f1286fb3757d789ecb57949f3c28b805700df90eb2edacda7346879b5a','2dbb08691751523d0e9905b2361fba63c36f2eb352935d727021dece14785788']);
/** Read-only, reviewable CAS plan. Caller checkpoints before applying any publication. */
export function planOriginalDeveloperMigration(records,captures={}){
 const changes=[],blocked=[];
 for(const row of records.filter(r=>r.scope==='runtime'&&r.name==='dev')){
  const role=row.characterId??'global',capture=captures[role];
  if(row.metadata?.developerSource==='dsh-original')continue;
  if(row.metadata?.developerSource==='custom'){blocked.push({characterId:row.characterId??null,reason:'custom-developer-preserved'});continue;}
  if(!generated.has(hash(row.content??''))){blocked.push({characterId:row.characterId??null,reason:'custom-developer-preserved'});continue;}
  if((row.draft??row.content)!==row.content||JSON.stringify(row.draftMetadata??row.metadata)!==JSON.stringify(row.metadata)||(row.draftLabel??row.label)!==row.label){blocked.push({characterId:row.characterId??null,reason:'dirty-draft-preserved'});continue;}
  if(!capture||capture.source?.kind!=='dsh-system-prompt'||typeof capture.text!=='string'||capture.text.length>250000||capture.sha256!==hash(capture.text)){blocked.push({characterId:row.characterId??null,reason:'native-capture-required'});continue;}
  changes.push({scope:'runtime',name:'dev',...(row.characterId?{characterId:row.characterId}:{}),expectedVersion:row.version,expectedRevision:row.revision,content:capture.text,label:row.label,metadata:{...row.metadata,developerSource:'dsh-original',developerSourceSha256:capture.sha256,developerSourceVersion:capture.source.runtimeVersion},checkpoint:{label:'DSH 原版迁移前的开发提示词',content:row.content,metadata:structuredClone(row.metadata),draft:row.draft??row.content,draftMetadata:structuredClone(row.draftMetadata??row.metadata)}});
 }
 return {changes,blocked};
}

export const isGeneratedDeveloperContent=content=>generated.has(hash(content??''));
