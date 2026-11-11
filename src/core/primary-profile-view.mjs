import {createHash} from 'node:crypto';
import {normalizeProfileSubject} from './person-profile-store.mjs';

export const PRIMARY_PROFILE_SUBJECT=Object.freeze({kind:'human',platform:'desktop',id:'local-owner',name:'主用户'});
const key=subject=>JSON.stringify([subject.kind,subject.platform,subject.id]);
const primaryKey=key(PRIMARY_PROFILE_SUBJECT);
const clone=value=>structuredClone(value);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const supplied=(input,field)=>Object.hasOwn(input,field)&&input[field]!=null;
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=512&&value===value.trim()&&!/[\x00-\x1f]/.test(value);

/** Non-destructive, observer-scoped aliases supplied exclusively by trusted routing configuration. */
export function createPrimaryProfileView({store,getAliases}={}){
  for(const name of ['get','idFor','entries','update','hasDecision','completeDecision','detail','recall'])if(typeof store?.[name]!=='function')throw new TypeError(`Primary profile view requires store.${name}`);
  if(typeof getAliases!=='function')throw new TypeError('Primary profile view requires trusted aliases');

  function state(characterId){
    // entries also runs the store's observer validator; bindings never create observers.
    const entries=store.entries({characterId}),bindings=getAliases(characterId);
    if(!Array.isArray(bindings))fail('PROFILE_INVALID','主用户身份绑定无效');
    const unique=new Map();
    for(const binding of bindings){
      if(!binding||typeof binding!=='object'||Array.isArray(binding)||!identifier(binding.accountId))fail('PROFILE_INVALID','主用户身份绑定无效');
      const subject=normalizeProfileSubject({kind:'human',platform:binding.platform,id:binding.id});
      if(['desktop','suna'].includes(subject.platform))fail('PROFILE_INVALID','主用户渠道绑定平台无效');
      const value={accountId:binding.accountId,platform:subject.platform,id:subject.id};
      unique.set(JSON.stringify([value.accountId,value.platform,value.id]),value);
    }
    const active=[...unique.values()].sort((a,b)=>JSON.stringify([a.accountId,a.platform,a.id]).localeCompare(JSON.stringify([b.accountId,b.platform,b.id])));
    const aliasKeys=new Set(active.map(binding=>key({kind:'human',...binding})));
    const aliases=entries.filter(item=>aliasKeys.has(key(item.subject)));
    const native=entries.find(item=>key(item.subject)===primaryKey)??null;
    return {characterId,entries,bindings:active,aliasKeys,aliases,native};
  }
  function bound(subject,snapshot){
    const normalized=normalizeProfileSubject(subject);
    return key(normalized)===primaryKey||snapshot.aliasKeys.has(key(normalized))?{...PRIMARY_PROFILE_SUBJECT}:normalized;
  }
  function origins(snapshot){return snapshot.aliases.map(item=>({...clone(item.subject),profileId:item.id,version:item.version}));}
  function primary(snapshot){
    const aliases=origins(snapshot);
    if(snapshot.native)return {...clone(snapshot.native),aliases};
    if(!snapshot.aliases.length)return null;
    const lines=[],seenLines=new Set(),addressNames=[],seenNames=new Set();
    for(const item of snapshot.aliases){
      for(const line of item.profile.split(/\r?\n/)){
        const identity=line.trim();
        if(!identity||seenLines.has(identity))continue;
        seenLines.add(identity);lines.push(line);
      }
      for(const name of item.addressNames)if(!seenNames.has(name)){seenNames.add(name);addressNames.push(name);}
    }
    const times=field=>snapshot.aliases.map(item=>item[field]).filter(value=>typeof value==='string'&&value).sort();
    const created=times('createdAt'),updated=times('updatedAt');
    return {id:store.idFor({characterId:snapshot.characterId,subject:PRIMARY_PROFILE_SUBJECT}),characterId:snapshot.characterId,subject:{...PRIMARY_PROFILE_SUBJECT},profile:lines.join('\n'),addressNames,version:0,createdAt:created[0]??'',updatedAt:updated.at(-1)??'',source:null,aliases};
  }
  function get({characterId,subject}){
    const snapshot=state(characterId),target=bound(subject,snapshot);
    return key(target)===primaryKey?primary(snapshot):store.get({characterId,subject:target});
  }
  function resolveSubject({characterId,subject}){return bound(subject,state(characterId));}
  function identityStamp({characterId}){
    const snapshot=state(characterId);
    const rows=snapshot.aliases.map(item=>[item.id,item.version]).sort((a,b)=>a[0].localeCompare(b[0]));
    return createHash('sha256').update(JSON.stringify([snapshot.bindings,rows])).digest('hex');
  }
  function decision(input,method){
    const snapshot=state(input.characterId);
    return store[method]({...input,subject:bound(input.subject,snapshot)});
  }
  function update(input){
    if(!input||typeof input!=='object'||Array.isArray(input))fail('PROFILE_INVALID','画像更新必须为对象');
    const snapshot=state(input.characterId),subject=bound(input.subject,snapshot);
    if(key(subject)!==primaryKey)return store.update({...input,subject});
    const fields=supplied(input,'profile')||supplied(input,'addressNames');
    const patch={...input,subject:snapshot.native?.subject??subject};
    // Tool supplies this private snapshot from its host-bound read. It is never a model argument.
    // Preserve omitted/null fields from that exact read, rather than aggregating new alias data.
    if(!snapshot.native&&fields){
      const base=Object.hasOwn(input,'baseSnapshot')?input.baseSnapshot:primary(snapshot);
      if(base!=null){
        if(base.characterId!==input.characterId||base.id!==store.idFor({characterId:input.characterId,subject})||key(normalizeProfileSubject(base.subject))!==primaryKey||base.version!==0)fail('PROFILE_INVALID','主用户画像基准快照无效');
        if(!supplied(input,'profile'))patch.profile=base.profile;
        if(!supplied(input,'addressNames'))patch.addressNames=clone(base.addressNames);
      }
    }
    delete patch.baseSnapshot;
    const result=store.update(patch);
    return {...result,item:result.item?{...clone(result.item),aliases:origins(snapshot)}:primary(snapshot)};
  }
  function list({characterId,query='',offset=0,limit=50,kind}={}){
    if(typeof query!=='string'||query.length>500||query.includes('\0')||!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>100||kind!==undefined&&!['human','character'].includes(kind))fail('PROFILE_INVALID','画像筛选或分页无效');
    const snapshot=state(characterId),unified=primary(snapshot),items=[];
    let placed=false;
    for(const item of snapshot.entries){
      if(snapshot.aliasKeys.has(key(item.subject))||key(item.subject)===primaryKey){
        if(!placed&&unified){items.push(unified);placed=true;}
      }else items.push(clone(item));
    }
    const needle=query.trim().toLocaleLowerCase();
    const filtered=items.filter(item=>(!kind||item.subject.kind===kind)&&(!needle||[item.subject.name,item.subject.platform,item.subject.id,...item.addressNames,item.profile,...(item.aliases??[]).flatMap(alias=>[alias.name,alias.platform,alias.id])].some(value=>value.toLocaleLowerCase().includes(needle))));
    return {items:filtered.slice(offset,offset+limit),total:filtered.length,offset,limit};
  }
  function detail({characterId,id}){
    const snapshot=state(characterId);
    if(id===store.idFor({characterId,subject:PRIMARY_PROFILE_SUBJECT})){
      const item=primary(snapshot);if(!item)fail('PROFILE_NOT_FOUND','画像不存在');return item;
    }
    // Historical alias IDs remain honest source records even while hidden in the main list.
    return store.detail({characterId,id});
  }
  function recall({characterId,subject,query='',limit=6}={}){
    const snapshot=state(characterId),target=bound(subject,snapshot),unified=primary(snapshot);
    // Rank the genuine stored corpus; virtual version 0 must never enter strict BM25 validation.
    const raw=store.recall({characterId,subject:target,query,limit});
    const exact=key(target)===primaryKey?unified:snapshot.entries.find(item=>key(item.subject)===key(target));
    const seen=new Set(),items=[];
    for(const item of [...(exact?[{...clone(exact),score:raw.find(value=>value.id===exact.id)?.score??0}]:[]),...raw]){
      const mapped=snapshot.aliasKeys.has(key(item.subject))||key(item.subject)===primaryKey?unified:item;
      if(!mapped||seen.has(mapped.id))continue;
      seen.add(mapped.id);items.push({...clone(mapped),score:item.score??0});
    }
    return items;
  }
  return {get,update,hasDecision:input=>decision(input,'hasDecision'),completeDecision:input=>decision(input,'completeDecision'),list,detail,recall,identityStamp,resolveSubject};
}
