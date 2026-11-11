import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {projectToneDialogs,sampleDialogs} from './worker-engine.mjs';
const defaultConfigPath=fileURLToPath(new URL('./config/default-prompts.json',import.meta.url));
const copy=value=>structuredClone(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'INVALID_PROMPT_CONFIG'});};
export function loadDefaultPromptConfig(){const document=JSON.parse(readFileSync(defaultConfigPath,'utf8'));if(document.schema!=='suna.default-prompts'||document.version!==1||!Array.isArray(document.entries))fail('Default prompt configuration is invalid');return document;}
export function editablePromptMetadata(entry){const value=entry?.metadata??entry??{},result={};for(const name of ['description','trigger','input','output','writeTarget','mode','terminate','provider','model','enabled']){const item=value[name];if(item!=null)result[name]=copy(item);}return result;}
export function toPromptConfig(configuration=loadDefaultPromptConfig()){return {schema:'book.prompt-config',version:1,source:copy(configuration.source),prompts:configuration.entries.map(entry=>({scope:entry.scope,name:entry.name,label:entry.label,content:entry.content,metadata:editablePromptMetadata(entry)}))};}
function object(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return copy(value);
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch {} }
  return null;
}
function canonicalPersona(character) {
  const supplied = object(character.personality) ?? object(character.persona);
  const body = supplied?.persona ?? supplied ?? {};
  const mutable = object(character.mutablePersona) ?? body.mutable ?? {};
  return { ...(supplied?.persona ? supplied : {}), profile: { ...(supplied?.profile ?? {}), name: character.name ?? supplied?.profile?.name ?? '' },
    persona: { immutable: { ...body.immutable, backgrounds: body.immutable?.backgrounds ?? (typeof character.persona === 'string' ? character.persona : ''), temper: body.immutable?.temper ?? character.temper ?? '' },
      mutable: { ...mutable, trait: mutable.trait ?? (typeof character.mutablePersona === 'string' && !object(character.mutablePersona) ? character.mutablePersona : ''), habit: mutable.habit ?? '', dialogue: mutable.dialogue ?? '' } },
    ...(supplied?.config || character.config ? { config: supplied?.config ?? copy(character.config) } : {}) };
}
function canonicalState(value = {}) {
  const current = object(value.emotion) ?? { desc: typeof value.emotion === 'string' ? value.emotion : '' };
  const pad = current.pad ?? value.pad ?? {};
  return { environment: value.environment ?? '', emotion: { desc: current.desc ?? current.description ?? '',
    pad: Object.fromEntries([['p', 'pleasure'], ['a', 'arousal'], ['d', 'dominance']].flatMap(([axis, old]) => Number.isFinite(pad[axis] ?? pad[old]) ? [[axis, pad[axis] ?? pad[old]]] : [])),
    timestamp: current.timestamp ?? value.emotionTimestamp ?? null } };
}
function canonicalMemory(memories, workMemory, character) {
  const supplied = workMemory ?? (!Array.isArray(memories) ? memories : null);
  const entries = supplied?.in_time ?? (Array.isArray(memories) ? memories : []);
  return { convolution: supplied?.convolution ?? character.workSummary ?? '', in_time: entries.map(entry => ({
    ...(entry.id != null || entry.Id != null ? { id: entry.id ?? entry.Id } : {}), time: entry.time ?? entry.createdAt ?? null,
    desc: entry.desc ?? entry.text ?? '', ...(entry.impression_score !== undefined || entry.score !== undefined ? { impression_score: entry.impression_score ?? entry.score } : {}),
  })) };
}
function explicitMessages(history, conversationId) {
  return history.filter(message => !message.internal && !message.source?.internal && message.sender?.type !== 'system' && !['failed', 'pending', 'sending', 'cancelled'].includes(message.status))
    .filter(message => { const id = message.conversationId ?? message.conversation_id; return !conversationId || !id || id === conversationId; })
    .map(message => {
      const role = message.sender?.type === 'human' ? 'user' : message.sender?.type === 'character' ? 'assistant' : message.role;
      return { ...message, role };
    }).filter(message => ['user', 'assistant'].includes(message.role));
}
function publicMessage(message, includeId = false, projectSender) {
  const sender = typeof projectSender === 'function' ? projectSender(message) : message.sender;
  const blocks = (message.blocks ?? []).filter(block => block.type !== 'text').map(block => Object.fromEntries(['type', 'text', 'alt', 'url', 'name', 'userId', 'platform', 'content', 'language'].filter(key => block[key] !== undefined).map(key => [key, copy(block[key])])));
  return { ...(includeId ? { id: message.id, ...(message.conversationId ?? message.conversation_id ? { conversationId: message.conversationId ?? message.conversation_id } : {}) } : {}),
    role: message.role, time: message.time ?? message.createdAt ?? null, text: String(message.text ?? message.content ?? ''),
    ...(message.sender ? { speaker: { id: message.sender.id, name: message.sender.name, type: message.sender.type, ...(typeof projectSender === 'function' && sender?.label === '[主用户]' ? {label: '[主用户]'} : {}) } } : {}), ...(blocks.length ? { blocks } : {}) };
}

/** Returns the canonical Worker snapshot and all 33 template variables; no persistence or model calls. */
export function snapshotProjection({ character = {}, conversation, state = character.state ?? {}, memories = [], workMemory, history = [], sourceMessages, versions = {}, baseline, input = '', at = new Date().toISOString(), systemLanguage = '简体中文', recalledMemories = '', associateMemory = recalledMemories, recentDiaries = [], dreamHistory = history, diaryHistory = history, messageContext, projectSender, expressions = character.pet?.expressions ?? [], emotionRecovery = character.emotionRecovery } = {}) {
  const persona = canonicalPersona(character), canonical = canonicalState(state), work = canonicalMemory(memories, workMemory, character);
  const recent = explicitMessages(history, conversation?.id), rawSources = explicitMessages(sourceMessages ?? history).filter(message => message.id != null);
  const immutable = persona.persona.immutable, mutable = persona.persona.mutable;
  const currentVersions = { state: versions.state ?? character.stateVersion ?? character.version ?? null, memory: versions.memory ?? character.memoryVersion ?? null, persona: versions.persona ?? character.personaVersion ?? character.version ?? null, ...versions };
  const timestamp = canonical.emotion.timestamp;
  const elapsed = timestamp != null && Number.isFinite(new Date(timestamp).getTime()) ? Math.max(0, (new Date(at).getTime() - new Date(timestamp).getTime()) / 60000) : 0;
  const variables = {
    character_name: persona.profile.name, persona_immutable: { backgrounds: immutable.backgrounds, temper: immutable.temper }, persona_mutable: { trait: mutable.trait, habit: mutable.habit, dialogue: mutable.dialogue },
    backgrounds: immutable.backgrounds, temper: immutable.temper, trait: mutable.trait, habit: mutable.habit, dialogue: mutable.dialogue,
    emotion: canonical.emotion, environment: canonical.environment, work_conv: work.convolution, work_entries: work.in_time,
    state: canonical, state_updated: !baseline || (baseline.state ?? baseline.stateVersion) !== currentVersions.state ? canonical : '',
    work_memory: work, work_memory_updated: !baseline || (baseline.memory ?? baseline.memoryVersion) !== currentVersions.memory ? work : '',
    recalled_memories: recalledMemories, recent_messages: recent.map(message => publicMessage(message, false, projectSender)), user_input: input, system_time: at,
    language: persona.config?.lang && persona.config.lang !== 'system' ? persona.config.lang : systemLanguage, expressions: copy(expressions), persona, recent_diaries: recentDiaries.slice(-5).map(copy), system_language: systemLanguage,
    elapsed_minutes: elapsed, associate_memory: associateMemory,
    dream_sampled_messages: sampleDialogs(explicitMessages(dreamHistory), { mode: 'random', projectSender }), worker_input: input,
    diary_sampled_messages: sampleDialogs(explicitMessages(diaryHistory), { mode: 'uniform', projectSender }),
    source_messages: rawSources.map(message => publicMessage(message, true, projectSender)), tone_recent_dialogs: projectToneDialogs(recent, { conversationId: conversation?.id, projectSender }),
    message_context: messageContext ?? { channel: conversation?.channel ?? 'desktop', conversation_id: conversation?.id ?? '', participants: copy(conversation?.participantIds ?? []) },
  };
  return { variables, versions: currentVersions, sourceMessages: rawSources.map(message => publicMessage(message, true, projectSender)), workMemory: work, persona, state: canonical, ...(emotionRecovery ? { emotionRecovery: copy(emotionRecovery) } : {}) };
}

export function variablesProjection(options) { return snapshotProjection(options).variables; }
