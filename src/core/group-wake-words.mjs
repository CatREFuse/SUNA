// Wake words are literal text, never regular expressions or authority claims.
const fold = value => value.replace(/[A-Z]/g, char => char.toLowerCase());
function invalid(){throw Object.assign(new Error('群聊唤醒词格式无效'),{code:'INVALID_GROUP_WAKE_WORDS'});}
export function normalizeGroupWakeWords(value){
  if(typeof value!=='string'&&!Array.isArray(value))invalid();
  const inputs=typeof value==='string'?[value]:value;
  if(inputs.some(item=>typeof item!=='string')||inputs.reduce((n,item)=>n+item.length,0)>4096)invalid();
  const seen=new Set(),words=[];
  for(const input of inputs){
    if(/[\u0000-\u001f\u007f-\u009f]/u.test(input))invalid();
    for(const part of input.split(/[,，]/u)){
      const word=part.trim();if(!word)continue;
      if([...word].length>64)invalid();
      const key=fold(word);if(seen.has(key))continue;seen.add(key);words.push(word);
      if(words.length>32)invalid();
    }
  }
  return words;
}
export function matchingWakeCharacterIds({conversation,characters,textSegments,senderType='human',sourceType}={}){
  if(conversation?.kind!=='group'||senderType!=='human'||['plugin','ttm','system','internal'].includes(sourceType)||!Array.isArray(textSegments))return [];
  // Remove CQ metadata even when a transport incorrectly wraps it in a text segment.
  const texts=textSegments.filter(value=>typeof value==='string').flatMap(value=>value.split(/\[CQ:[^\]]*\]/g).map(fold));
  return (characters??[]).filter(person=>conversation.participantIds?.includes(person.id)&&(person.groupWakeWords??[]).some(word=>typeof word==='string'&&word&&texts.some(text=>text.includes(fold(word))))).map(person=>person.id);
}
