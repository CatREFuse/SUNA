import {displayProductVersion} from '../shared/product-version.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';

const cleanVersion=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,99}$/.test(value)?value:'development';
const id=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x20\x7f]/.test(value);
const validMessageId=value=>typeof value==='string'&&id(value)||typeof value==='number'&&Number.isSafeInteger(value);
const unsafe=/\b(?:https?:\/\/|file:\/\/|Bearer\s|sk-[A-Za-z0-9])|(?:\/(?:Users|private|var|tmp|home)\/)|\b(?:api.?key|token|password|credential)\s*[:=]/i;

// Reviewed release data only; never derive public changelogs from logs, prompts or chats.
export function reviewedStartupNotes(value,version){
  if(!value||value.schemaVersion!==1||value.version!==cleanVersion(version)||!id(value.revision)||!Array.isArray(value.changes)||value.changes.length>12||value.changes.some(line=>typeof line!=='string'||!line.trim()||line.length>160||/[\x00-\x1f\x7f]/.test(line)||unsafe.test(line)))return {revision:'unregistered',changes:[]};
  return {revision:value.revision,changes:[...value.changes]};
}
export async function loadStartupNotes(file,version){try{const bytes=await readFile(file);if(bytes.length>16384)return reviewedStartupNotes(null,version);return reviewedStartupNotes(JSON.parse(bytes),version);}catch{return reviewedStartupNotes(null,version);}}
function textFor({version,notes,previous}){
  const changed=previous?.version!==version||previous?.revision!==notes.revision;
  return ['沙之书已启动',`当前版本：${displayProductVersion(version)}`,changed&&notes.changes.length?(previous?'本次更新：\n':'当前版本已登记更新：\n')+notes.changes.map(line=>'• '+line).join('\n'):'本次启动没有新增已登记的功能变更。'].join('\n');
}
function bounded(promise,signal){return new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(new Error('STARTUP_NOTICE_CANCELLED'),{code:'STARTUP_NOTICE_CANCELLED'}));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}

// One instance per successful server listen. Own durable outbox; no Agent, Tone or Worker.
export function createStartupNotifier({file,version,notes,channel,startupId=randomUUID(),now=Date.now,pollIntervalMs=5000,maxWaitMs=600000,operationTimeoutMs=15000,delay=(ms,signal)=>sleep(ms,undefined,{signal,ref:false}),log=()=>{}}){
  if(!id(startupId)||!Number.isInteger(pollIntervalMs)||pollIntervalMs<1||!Number.isInteger(maxWaitMs)||maxWaitMs<1||maxWaitMs>600000||!Number.isInteger(operationTimeoutMs)||operationTimeoutMs<1||operationTimeoutMs>30000)throw Error('STARTUP_NOTICE_CONFIG_INVALID');
  version=cleanVersion(version);notes=reviewedStartupNotes({schemaVersion:1,version,...notes},version);
  notes={...notes,revision:notes.revision+':'+createHash('sha256').update(JSON.stringify(notes.changes)).digest('hex')};
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});try{if(lstatSync(file).isSymbolicLink())throw Error('STARTUP_NOTICE_STORE_INVALID');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=new DatabaseSync(file);chmodSync(file,0o600);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS boots(id TEXT PRIMARY KEY,started INTEGER NOT NULL,version TEXT NOT NULL,revision TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notices(boot TEXT NOT NULL,account TEXT NOT NULL,administrator TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,text TEXT,message_id TEXT,acknowledgement TEXT,updated INTEGER NOT NULL,PRIMARY KEY(boot,account,administrator));');
  let boot=db.prepare('SELECT * FROM boots WHERE id=?').get(startupId);
  if(boot&&(boot.version!==version||boot.revision!==notes.revision)){db.close();throw Error('STARTUP_NOTICE_BOOT_CONFLICT');}
  if(!boot){
    const targets=channel.targets();if(!Array.isArray(targets)||targets.length>64){db.close();throw Error('STARTUP_NOTICE_TARGET_LIMIT');}
    db.exec('BEGIN IMMEDIATE');try{
      db.prepare('INSERT INTO boots VALUES(?,?,?,?)').run(startupId,now(),version,notes.revision);
      for(const t of targets){if(![t.accountId,t.characterId,t.pluginId].every(id)||!/^\d{5,20}$/.test(t.administratorUid))throw Error('STARTUP_NOTICE_TARGET_INVALID');const target={accountId:t.accountId,characterId:t.characterId,pluginId:t.pluginId,administratorUid:t.administratorUid,expectedSelfId:typeof t.expectedSelfId==='string'?t.expectedSelfId:''};db.prepare("INSERT OR IGNORE INTO notices(boot,account,administrator,target,status,updated) VALUES(?,?,?,?,'waiting',?)").run(startupId,t.accountId,t.administratorUid,JSON.stringify(target),now());}
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');db.close();throw e;}
    boot=db.prepare('SELECT * FROM boots WHERE id=?').get(startupId);
  }
  const controller=new AbortController();let task,closed=false,closeTask;
  const deadline=performance.now()+Math.min(maxWaitMs,Math.max(0,maxWaitMs-(now()-boot.started)));
  const remaining=()=>Math.min(maxWaitMs-(now()-boot.started),deadline-performance.now());
  const mark=(row,status,receipt)=>{db.prepare('UPDATE notices SET status=?,message_id=?,acknowledgement=?,updated=? WHERE boot=? AND account=? AND administrator=?').run(status,receipt?.messageId??null,receipt?.acknowledgement??null,now(),startupId,row.account,row.administrator);try{log('channel.startup-notice',{startupId,accountId:row.account,status});}catch{}};
  async function run(){
    try{
      while(!controller.signal.aborted&&remaining()>0){
        const pending=db.prepare("SELECT * FROM notices WHERE boot=? AND status='waiting'").all(startupId);if(!pending.length)return;
        for(const row of pending){
          if(controller.signal.aborted||remaining()<=0)break;
          const target=JSON.parse(row.target),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,Math.floor(Math.min(operationTimeoutMs,remaining()))))]);let lease;
          try{lease=await bounded(channel.prepare(target,{signal}),signal);}catch{continue;}if(!lease||signal.aborted)continue;
          const previous=db.prepare("SELECT b.version,b.revision FROM notices n JOIN boots b ON b.id=n.boot WHERE n.account=? AND n.administrator=? AND n.status='confirmed' AND n.boot<>? ORDER BY b.started DESC LIMIT 1").get(row.account,row.administrator,startupId),text=textFor({version,notes,previous});
          // Durable claim BEFORE dispatch. A crash or lost receipt can never reopen this slot.
          if(db.prepare("UPDATE notices SET status='claimed',text=?,updated=? WHERE boot=? AND account=? AND administrator=? AND status='waiting'").run(text,now(),startupId,row.account,row.administrator).changes!==1)continue;
          try{
            const receipt=await bounded(channel.send(target,lease,text,{signal}),signal);
            if(receipt?.status==='ok'&&Number(receipt.retcode)===0&&validMessageId(receipt.data?.message_id))mark(row,'confirmed',{messageId:String(receipt.data.message_id),acknowledgement:receipt.data.accepted?'accepted':'completed'});
            else if(receipt?.status==='failed'&&Number.isFinite(Number(receipt.retcode))&&Number(receipt.retcode)!==0)mark(row,'failed');
            else mark(row,'unknown');
          }catch(error){mark(row,error?.preDispatch===true?'cancelled':'unknown');}
        }
        if(db.prepare("SELECT 1 FROM notices WHERE boot=? AND status='waiting' LIMIT 1").get(startupId))await delay(Math.min(pollIntervalMs,Math.max(1,remaining())),controller.signal);else return;
      }
    }catch{ /* Cancellation leaves no send retry; raw errors never enter public content. */ }
    finally{db.prepare("UPDATE notices SET status=?,updated=? WHERE boot=? AND status='waiting'").run(controller.signal.aborted?'cancelled':'expired',now(),startupId);}
  }
  return {startupId,start(){if(closed||closeTask)throw Error('STARTUP_NOTICE_CLOSED');return task??=run();},status(){if(closed)throw Error('STARTUP_NOTICE_CLOSED');return db.prepare('SELECT account,status,message_id AS messageId,acknowledgement FROM notices WHERE boot=?').all(startupId).map(row=>({...row}));},close(){return closeTask??=(async()=>{controller.abort();await task;if(!task)db.prepare("UPDATE notices SET status='cancelled',updated=? WHERE boot=? AND status='waiting'").run(now(),startupId);closed=true;db.close();})();}};
}
