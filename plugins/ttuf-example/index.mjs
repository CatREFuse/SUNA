// This plugin chooses to send once when activated. Other TTUF plugins can own
// their timers, subscriptions and conditions using ordinary Node.js code.
export async function activate({config,sendTTM,sendChannel,signal}){
  if(signal.aborted)return;
  const message={characterId:config.characterId,conversationId:config.conversationId,content:config.content,deliveryId:config.deliveryId};
  const result=config.destination==='channel'?await sendChannel(message):await sendTTM({...message,mode:config.mode});
  if(['failed','cancelled','unknown'].includes(result.status))throw new Error('PLUGIN_SEND_FAILED');
}
