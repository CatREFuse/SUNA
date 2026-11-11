// Only server-confirmed primary users can supply native review instructions.
// Display labels, legacy owner flags, quoted context and tool availability are
// deliberately not identity proofs.
export function runtimeReviewInstructionFor({character,conversation,trigger,restricted=false,testMode=false,isAdministrator}={}){
 // Host interaction answers include model-authored questions/options. Keep
 // the entire derived answer as facts even when a primary user submits it.
 const sender=trigger?.sender;
 if(testMode||restricted||!character||!conversation?.participantIds?.includes(character.id)||trigger?.conversationId!==conversation.id||sender?.type!=='human'||sender.automatic===true||trigger.internal||trigger.kind==='ttm'||trigger.source?.internal||trigger.source?.pluginId||['plugin','ttm','system','internal','interaction-answer'].includes(trigger.source?.type))return;
 let primary=false;
 if(conversation.channel==='desktop')primary=sender.id==='local-owner'&&sender.source==='desktop';
 else if(sender.source!=='desktop'&&typeof isAdministrator==='function')try{primary=isAdministrator({character,conversation,sender:{...sender}})===true;}catch{}
 if(primary)return {id:trigger.id,text:trigger.text??''};
}
