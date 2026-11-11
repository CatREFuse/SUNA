/** Durable role/source consumption in the application's existing SQLite DB. */
export function createGroupDispatchStore({db,clock=()=>new Date().toISOString()}={}) {
  if(!db?.prepare)throw new TypeError('The application database is required');
  db.exec(`CREATE TABLE IF NOT EXISTS group_dispatch (
    conversation_id TEXT NOT NULL,character_id TEXT NOT NULL,source_id TEXT NOT NULL,
    state TEXT NOT NULL,route TEXT NOT NULL,automatic INTEGER NOT NULL,
    run_id TEXT,root_id TEXT,reason TEXT,reply_lease TEXT,admission_id TEXT,admitted_at TEXT,runtime_started_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id,character_id,source_id));
    CREATE INDEX IF NOT EXISTS group_dispatch_run ON group_dispatch(run_id);
    CREATE TABLE IF NOT EXISTS group_auto_turns (
    run_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,root_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS group_auto_turns_root ON group_auto_turns(conversation_id,root_id);`);
  let serial=0;
  function atomic(fn){
    // A deferred read transaction cannot upgrade after another connection writes.
    // Take the writer lock before reading counters; retain a caller's transaction.
    const nested=db.isTransaction,name=`group_dispatch_${++serial}`;
    db.exec(nested?`SAVEPOINT ${name}`:'BEGIN IMMEDIATE');
    try{const result=fn();db.exec(nested?`RELEASE ${name}`:'COMMIT');return result;}
    catch(error){if(nested){db.exec(`ROLLBACK TO ${name}`);db.exec(`RELEASE ${name}`);}else db.exec('ROLLBACK');throw error;}
  }
  // Additive upgrade for an earlier development DB; no saved policies are changed.
  atomic(()=>{
    const columns=new Set(db.prepare('PRAGMA table_info(group_dispatch)').all().map(row=>row.name));
    for(const name of ['reply_lease','admission_id','admitted_at','runtime_started_at'])if(!columns.has(name))db.exec(`ALTER TABLE group_dispatch ADD COLUMN ${name} TEXT`);
  });
  const get=(conversationId,characterId,sourceId)=>db.prepare('SELECT * FROM group_dispatch WHERE conversation_id=? AND character_id=? AND source_id=?').get(conversationId,characterId,sourceId)??null;
  const terminal=new Set(['completed','silent','failed','cancelled','interrupted','skipped']);
  function admit({conversationId,characterId,sourceId,eligible=true,route='ambient',automatic=true,rootId=null,reason=null,replyLease}) {
    const time=clock();
    const result=db.prepare(`INSERT OR IGNORE INTO group_dispatch(conversation_id,character_id,source_id,state,route,automatic,root_id,reason,reply_lease,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(conversationId,characterId,sourceId,eligible?'pending':'skipped',route,automatic?1:0,rootId,reason,replyLease===undefined?null:JSON.stringify(replyLease),time,time);
    return {admitted:result.changes===1&&eligible,created:result.changes===1,entry:get(conversationId,characterId,sourceId)};
  }
  /** Only unclaimed sources can join a run; a source already in any run stays consumed. */
  function claim({conversationId,characterId,sourceIds,runId,route}) {
    return atomic(()=>{
      const claimed=[];
      for(const sourceId of new Set(sourceIds)) {
        const result=db.prepare(`UPDATE group_dispatch SET state='queued',run_id=?,route=COALESCE(?,route),updated_at=? WHERE conversation_id=? AND character_id=? AND source_id=? AND state='pending' AND run_id IS NULL`).run(runId,route??null,clock(),conversationId,characterId,sourceId);
        if(result.changes===1)claimed.push(sourceId);
      }
      return claimed;
    });
  }
  function transition(runId,state,reason=null) {
    if(!['running',...terminal].includes(state))throw new TypeError('Invalid dispatch state');
    return db.prepare(`UPDATE group_dispatch SET state=?,reason=COALESCE(?,reason),updated_at=? WHERE run_id=? AND state IN ('queued','running')`).run(state,reason,clock(),runId).changes;
  }
  function markRuntimeStarted(runId){return db.prepare(`UPDATE group_dispatch SET runtime_started_at=COALESCE(runtime_started_at,?),updated_at=? WHERE run_id=? AND state IN ('queued','running')`).run(clock(),clock(),runId).changes;}
  function markAdmitted(runId,{admissionId,sourceIds}={}){
    if(typeof admissionId!=='string'||!admissionId||!Array.isArray(sourceIds))throw new TypeError('Admission identity and actual source IDs are required');
    return atomic(()=>{
      let changes=0;
      for(const sourceId of new Set(sourceIds))changes+=db.prepare(`UPDATE group_dispatch SET admission_id=?,admitted_at=COALESCE(admitted_at,?),updated_at=? WHERE run_id=? AND source_id=? AND state IN ('queued','running') AND (admission_id IS NULL OR admission_id=?)`).run(admissionId,clock(),clock(),runId,sourceId,admissionId).changes;
      return changes;
    });
  }
  function cancel({conversationId,characterId,sourceIds,ambientOnly=false,automaticOnly=false,reason='cancelled'}={}) {
    const clauses=["state IN ('pending','queued','running')"],values=[];
    if(conversationId!==undefined){clauses.push('conversation_id=?');values.push(conversationId);}
    if(characterId!==undefined){clauses.push('character_id=?');values.push(characterId);}
    if(sourceIds!==undefined){if(!sourceIds.length)return 0;clauses.push(`source_id IN (${sourceIds.map(()=>'?').join(',')})`);values.push(...sourceIds);}
    if(ambientOnly)clauses.push("route='ambient'");
    if(automaticOnly)clauses.push('automatic=1');
    return db.prepare(`UPDATE group_dispatch SET state='cancelled',reason=?,updated_at=? WHERE ${clauses.join(' AND ')}`).run(reason,clock(),...values).changes;
  }
  function recover() {return db.prepare(`UPDATE group_dispatch SET state='interrupted',reason='process_interrupted',updated_at=? WHERE state IN ('pending','queued','running')`).run(clock()).changes;}
  /** Each admitted role-to-role run spends once, even when it sends many bubbles. */
  function reserveAutoTurn({conversationId,rootId,runId,limit}) {
    if(!Number.isSafeInteger(limit)||limit<0)throw new TypeError('Invalid automatic turn limit');
    return atomic(()=>{
      const existing=db.prepare('SELECT conversation_id,root_id FROM group_auto_turns WHERE run_id=?').get(runId);
      if(existing)return existing.conversation_id===conversationId&&existing.root_id===rootId;
      const count=db.prepare('SELECT COUNT(*) AS count FROM group_auto_turns WHERE conversation_id=? AND root_id=?').get(conversationId,rootId).count;
      if(count>=limit)return false;
      db.prepare('INSERT INTO group_auto_turns(run_id,conversation_id,root_id,created_at) VALUES(?,?,?,?)').run(runId,conversationId,rootId,clock());return true;
    });
  }
  function releaseUnstartedAutoTurn(runId){
    return atomic(()=>{
      const unsafe=db.prepare('SELECT 1 FROM group_dispatch WHERE run_id=? AND (runtime_started_at IS NOT NULL OR admission_id IS NOT NULL) LIMIT 1').get(runId);
      if(unsafe)return false;
      return db.prepare('DELETE FROM group_auto_turns WHERE run_id=?').run(runId).changes===1;
    });
  }
  return {admit,get,claim,transition,cancel,recover,reserveAutoTurn,markRuntimeStarted,markAdmitted,releaseUnstartedAutoTurn};
}
