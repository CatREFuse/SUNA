import {createHash,randomUUID} from 'node:crypto';
import {recallPersonProfiles} from './person-profile-recall.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const clone=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const own=(value,key)=>Object.hasOwn(value,key);
function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value))fail('PROFILE_INVALID',`${label}必须为对象`);return value;}
function identifier(value,label){if(typeof value!=='string'||!value||value!==value.trim()||value.length>512||/[\x00-\x1f]/.test(value))fail('PROFILE_INVALID',`${label}无效`);return value;}
function text(value,label,maximum=262144){if(typeof value!=='string'||value.length>maximum||value.includes('\0'))fail('PROFILE_INVALID',`${label}无效或超出范围`);return value;}
export function normalizeProfileSubject(input){
  object(input,'画像对象');
  if(!['human','character'].includes(input.kind))fail('PROFILE_INVALID','画像对象类型无效');
  const platform=identifier(input.platform,'平台');
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(platform))fail('PROFILE_INVALID','平台无效');
  return {kind:input.kind,platform,id:identifier(input.id,'对象标识'),name:input.name==null?'':text(input.name,'显示名',512)};
}
function names(input){
  if(!Array.isArray(input)||input.length>256)fail('PROFILE_INVALID','称呼必须为有序文本列表');
  return [...new Set(input.map(value=>text(value,'称呼',512).trim()).filter(Boolean))];
}
function source(input){
  if(input==null)return null;object(input,'画像来源');
  if(!['tool','manual','sunabot'].includes(input.kind))fail('PROFILE_INVALID','画像来源类型无效');
  const result={kind:input.kind};
  for(const key of ['messageId','conversationId','recordId','sourceProfileId','time'])if(input[key]!=null)result[key]=text(input[key],'来源标识',1024);
  return result;
}
const subjectKey=subject=>JSON.stringify([subject.kind,subject.platform,subject.id]);
const profileId=(characterId,subject)=>`profile_${hash(JSON.stringify([characterId,...JSON.parse(subjectKey(subject))]))}`;
const rawData=record=>{const raw=object(record.data??record,'导入记录');return raw.data&&typeof raw.data==='object'&&!Array.isArray(raw.data)?{...raw.data,...raw}:raw;};
const legacyText=data=>[data.fact,data.value,data.profile,data.text].find(value=>typeof value==='string')??'';
function legacyUserId(value){
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?String(value):null;
  return typeof value==='string'&&value.trim()?identifier(value.trim(),'原用户标识'):null;
}
function legacyAddressNames(data){
  // An explicit empty canonical value stays empty; aliases only recover older shapes.
  const value=data.addressNames??data.addressName??data.address_name??data.salutation;
  return Array.isArray(value)?value:typeof value==='string'?[value]:[];
}
function mergeLines(left,right){const result=[],seen=new Set();for(const line of [left,right].flatMap(value=>value.split(/\r?\n/))){const key=line.trim();if(!key||seen.has(key))continue;seen.add(key);result.push(line);}return result.join('\n');}

/** Subject identity is host-bound; model text, nicknames and aliases never merge people. */
export function createPersonProfileStore({db,clock=()=>new Date().toISOString(),requireCharacter}={}){
  if(!db?.prepare||!db?.exec||typeof requireCharacter!=='function')throw new TypeError('Profile store requires SQLite and a character validator');
  db.exec(`CREATE TABLE IF NOT EXISTS person_profiles(id TEXT PRIMARY KEY,character_id TEXT NOT NULL,subject_key TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(character_id,subject_key));
    CREATE TABLE IF NOT EXISTS person_profile_revisions(profile_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(profile_id,version));
    CREATE TABLE IF NOT EXISTS person_profile_decisions(profile_id TEXT NOT NULL,decision_key TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(profile_id,decision_key));
    CREATE TABLE IF NOT EXISTS person_profile_imports(character_id TEXT NOT NULL,record_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(character_id,record_id,digest));`);
  let transactionIndex=0;
  function transaction(fn){const name=`person_profile_${++transactionIndex}`;db.exec(`SAVEPOINT ${name}`);try{const value=fn();db.exec(`RELEASE ${name}`);return value;}catch(error){db.exec(`ROLLBACK TO ${name}`);db.exec(`RELEASE ${name}`);throw error;}}
  function character(value){identifier(value,'观察角色');requireCharacter(value);return value;}
  function read(id){const row=db.prepare('SELECT payload FROM person_profiles WHERE id=?').get(id);return row?JSON.parse(row.payload):null;}
  function get({characterId,subject}){character(characterId);return read(profileId(characterId,normalizeProfileSubject(subject)));}
  function idFor({characterId,subject}){character(characterId);return profileId(characterId,normalizeProfileSubject(subject));}
  function entries({characterId}){character(characterId);return db.prepare('SELECT payload FROM person_profiles WHERE character_id=? ORDER BY rowid').all(characterId).map(row=>JSON.parse(row.payload));}
  function recall({characterId,subject,query='',limit=6}){
    character(characterId);const bound=normalizeProfileSubject(subject);text(query,'画像召回内容',65536);
    const entries=db.prepare('SELECT payload FROM person_profiles WHERE character_id=? ORDER BY rowid').all(characterId).map(row=>JSON.parse(row.payload));
    return recallPersonProfiles({entries,subject:bound,query,limit});
  }
  function decisionTarget({characterId,subject,sourceDecisionKey}){
    character(characterId);
    return {id:profileId(characterId,normalizeProfileSubject(subject)),key:identifier(sourceDecisionKey,'画像决定标识')};
  }
  function hasDecision(input){const {id,key}=decisionTarget(input);return !!db.prepare('SELECT 1 FROM person_profile_decisions WHERE profile_id=? AND decision_key=?').get(id,key);}
  function completeDecision(input){
    const {id,key}=decisionTarget(input);
    return transaction(()=>{
      if(db.prepare('SELECT 1 FROM person_profile_decisions WHERE profile_id=? AND decision_key=?').get(id,key))return {duplicate:true};
      db.prepare('INSERT INTO person_profile_decisions(profile_id,decision_key,version) VALUES(?,?,?)').run(id,key,read(id)?.version??0);
      return {duplicate:false};
    });
  }
  function detail({characterId,id}){character(characterId);identifier(id,'画像标识');const value=read(id);if(!value||value.characterId!==characterId)fail('PROFILE_NOT_FOUND','画像不存在');return value;}
  function list({characterId,query='',offset=0,limit=50,kind}={}){
    character(characterId);text(query,'搜索内容',500);
    if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>100||kind!==undefined&&!['human','character'].includes(kind))fail('PROFILE_INVALID','画像筛选或分页无效');
    const needle=query.trim().toLocaleLowerCase();
    const items=db.prepare('SELECT payload FROM person_profiles WHERE character_id=? ORDER BY rowid').all(characterId).map(row=>JSON.parse(row.payload)).filter(item=>(!kind||item.subject.kind===kind)&&(!needle||[item.subject.name,item.subject.platform,item.subject.id,...item.addressNames,item.profile].some(value=>value.toLocaleLowerCase().includes(needle))));
    return {items:items.slice(offset,offset+limit),total:items.length,offset,limit};
  }
  function update(input){
    object(input,'画像更新');const characterId=character(input.characterId),subject=normalizeProfileSubject(input.subject),id=profileId(characterId,subject);
    if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)fail('PROFILE_INVALID','画像更新需要有效版本');
    const decision=input.sourceDecisionKey===undefined?null:identifier(input.sourceDecisionKey,'画像决定标识');
    const profileProvided=own(input,'profile')&&input.profile!=null,namesProvided=own(input,'addressNames')&&input.addressNames!=null;
    const profile=profileProvided?text(input.profile,'画像正文'):undefined,addressNames=namesProvided?names(input.addressNames):undefined,origin=source(input.source);
    return transaction(()=>{
      const before=read(id);
      if(decision&&db.prepare('SELECT version FROM person_profile_decisions WHERE profile_id=? AND decision_key=?').get(id,decision))return {item:before,changed:false,duplicate:true};
      if((before?.version??0)!==input.expectedVersion)fail('VERSION_CONFLICT','人物画像已有新版本，请重新读取');
      if(!before&&!profileProvided&&!namesProvided){
        if(decision)db.prepare('INSERT INTO person_profile_decisions(profile_id,decision_key,version) VALUES(?,?,0)').run(id,decision);
        return {item:null,changed:false,duplicate:false};
      }
      const now=clock(),value={id,characterId,subject:{...subject,name:subject.name||before?.subject.name||''},profile:profile??before?.profile??'',addressNames:addressNames??before?.addressNames??[],version:(before?.version??0)+1,createdAt:before?.createdAt??now,updatedAt:now,source:((profileProvided||namesProvided)?origin:null)??before?.source??null};
      const changed=!before||value.profile!==before.profile||JSON.stringify(value.addressNames)!==JSON.stringify(before.addressNames)||value.subject.name!==before.subject.name||JSON.stringify(value.source)!==JSON.stringify(before.source);
      if(changed){
        db.prepare('INSERT INTO person_profiles(id,character_id,subject_key,version,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,payload=excluded.payload').run(id,characterId,subjectKey(subject),value.version,JSON.stringify(value));
        db.prepare('INSERT INTO person_profile_revisions(profile_id,version,payload) VALUES(?,?,?)').run(id,value.version,JSON.stringify(value));
      }
      const saved=changed?value:before;
      if(decision)db.prepare('INSERT INTO person_profile_decisions(profile_id,decision_key,version) VALUES(?,?,?)').run(id,decision,saved.version);
      return {item:saved,changed,duplicate:false};
    });
  }
  function history({characterId,id}){detail({characterId,id});return db.prepare('SELECT payload FROM person_profile_revisions WHERE profile_id=? ORDER BY version DESC').all(id).map(row=>JSON.parse(row.payload));}
  function migrateLegacy(records){
    if(!Array.isArray(records))fail('PROFILE_INVALID','导入记录必须为列表');
    return transaction(()=>{
      const report={created:0,merged:0,unchanged:0,skippedNative:0,unresolved:0,duplicates:0,sourceRecords:records.length};
      for(const record of records){
        object(record,'导入记录');const characterId=character(record.characterId),recordId=identifier(record.id,'原记录标识'),data=rawData(record),digest=hash(JSON.stringify(data));
        if(db.prepare('SELECT 1 FROM person_profile_imports WHERE character_id=? AND record_id=? AND digest=?').get(characterId,recordId,digest)){report.duplicates++;continue;}
        const ids=[...new Set([data.userId,...(Array.isArray(data.userIds)?data.userIds:[])].map(legacyUserId).filter(value=>value!==null))];
        const migrated=[];let disposition='imported';
        if(!ids.length){report.unresolved++;disposition='unresolved-identity';}
        for(const userId of ids){
          const subject={kind:'human',platform:'qq',id:userId,name:typeof data.userName==='string'?data.userName:''},before=get({characterId,subject});
          if(before&&before.source?.kind!=='sunabot'){report.skippedNative++;migrated.push(before.id);continue;}
          const result=update({characterId,subject,expectedVersion:before?.version??0,profile:mergeLines(before?.profile??'',legacyText(data)),addressNames:[...new Set([...(before?.addressNames??[]),...legacyAddressNames(data)])],source:{kind:'sunabot',recordId,sourceProfileId:typeof data.id==='string'?data.id:recordId,time:typeof data.updatedAt==='string'?data.updatedAt:typeof data.createdAt==='string'?data.createdAt:''}});
          migrated.push(result.item.id);if(!before)report.created++;else if(result.changed)report.merged++;else report.unchanged++;
        }
        db.prepare('INSERT INTO person_profile_imports(character_id,record_id,digest,payload) VALUES(?,?,?,?)').run(characterId,recordId,digest,JSON.stringify({id:`profile_import_${randomUUID()}`,characterId,recordId,digest,profileIds:migrated,disposition,importedAt:clock()}));
      }
      return report;
    });
  }
  return {get,idFor,entries,detail,list,update,history,migrateLegacy,hasDecision,completeDecision,recall};
}
