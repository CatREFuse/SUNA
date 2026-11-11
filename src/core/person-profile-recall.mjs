import {normalizeProfileSubject} from './person-profile-store.mjs';

const invalid=message=>{throw Object.assign(new Error(message),{code:'PROFILE_INVALID'});};
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value===value.trim()&&!/[\x00-\x1f]/.test(value);
const text=(value,maximum)=>typeof value==='string'&&value.length<=maximum&&!value.includes('\0');
const subjectKey=subject=>JSON.stringify([subject.kind,subject.platform,subject.id]);

// Match Sunabot's NFKC tokenization, including Chinese bigrams across separators.
function tokenize(input){
  const normalized=input.toLowerCase().normalize('NFKC');
  const tokens=Array.from(normalized.matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]/g),match=>match[0]);
  let previous;
  for(const character of normalized)if(character>='\u4e00'&&character<='\u9fff'){
    if(previous!==undefined)tokens.push(previous+character);
    previous=character;
  }
  return tokens;
}

function time(entry){return Date.parse(entry.updatedAt||entry.createdAt||'');}
function compare(left,right){
  const a=time(left.entry),b=time(right.entry);
  return right.score-left.score||(Number.isFinite(a)&&Number.isFinite(b)&&a!==b?b-a:left.entry.id.localeCompare(right.entry.id));
}

/** Pure read-only recall over one observer's current profiles, never historical revisions. */
export function recallPersonProfiles({entries,subject,query='',limit=6}={}){
  if(!Array.isArray(entries)||!text(query,262144)||!Number.isInteger(limit)||limit<0||limit>6)invalid('画像召回输入无效');
  const target=subjectKey(normalizeProfileSubject(subject));
  const ids=new Set();let observer;
  const corpus=entries.map(entry=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||!identifier(entry.id)||!identifier(entry.characterId)||!text(entry.profile,262144)||!Array.isArray(entry.addressNames)||entry.addressNames.length>256||entry.addressNames.some(name=>!text(name,512))||!Number.isSafeInteger(entry.version)||entry.version<1)invalid('画像召回记录无效');
    const identity=normalizeProfileSubject(entry.subject);
    if(ids.has(entry.id))invalid('画像召回记录标识重复');
    if(observer!==undefined&&observer!==entry.characterId)invalid('画像召回不能跨观察角色');
    for(const field of ['updatedAt','createdAt'])if(entry[field]!=null&&typeof entry[field]!=='string')invalid('画像时间无效');
    observer=entry.characterId;ids.add(entry.id);
    return {entry,identity};
  });
  if(!corpus.length)return [];
  const queryTokens=tokenize(query),queryCounts=new Map();
  for(const token of queryTokens)queryCounts.set(token,(queryCounts.get(token)??0)+1);
  const documentFrequency=new Map();let totalLength=0;
  const documents=corpus.map(({entry,identity})=>{
    const frequencies=new Map();
    const tokens=tokenize([entry.profile,identity.id,identity.name,...entry.addressNames].filter(Boolean).join(' '));
    for(const token of tokens)frequencies.set(token,(frequencies.get(token)??0)+1);
    for(const token of frequencies.keys())if(queryCounts.has(token))documentFrequency.set(token,(documentFrequency.get(token)??0)+1);
    totalLength+=tokens.length;
    return {entry,identity,frequencies,length:tokens.length};
  });
  const averageLength=totalLength/documents.length||1,k1=1.5,b=0.75;
  const scored=documents.map(document=>{
    let score=0;
    for(const [token,count] of queryCounts){
      const frequency=document.frequencies.get(token)??0;
      if(!frequency)continue;
      const df=documentFrequency.get(token)??0;
      const idf=Math.log(1+(documents.length-df+0.5)/(df+0.5));
      score+=count*idf*(frequency*(k1+1))/(frequency+k1*(1-b+b*document.length/averageLength));
    }
    return {entry:document.entry,identity:document.identity,score:Number(score.toFixed(4))};
  });
  const exact=scored.find(document=>subjectKey(document.identity)===target);
  const related=scored.filter(document=>document.score>0).sort(compare).slice(0,limit);
  // Like Sunabot, take the BM25 top limit first, then prepend exact and dedupe.
  const seen=new Set(),result=[];
  for(const document of [...(exact?[exact]:[]),...related]){
    if(seen.has(document.entry.id))continue;
    seen.add(document.entry.id);
    try{result.push({...structuredClone(document.entry),score:document.score});}catch{invalid('画像召回记录不可复制');}
  }
  return result;
}
