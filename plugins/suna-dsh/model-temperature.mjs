// Shared, credential-free policy. Unknown native adapters must not promise a
// setting which their transport may silently discard.
export function temperatureCapability(provider,model,selection={}) {
  const unavailable=reason=>({supported:false,min:0,max:2,reason});
  if(provider?.kind==='openai-auth')return unavailable('OpenAI 授权接口不支持自定义温度');
  if(provider?.kind!=='api-key')return unavailable('尚未确认此 DSH 模型适配器支持自定义温度');
  const api=provider.api||'openai-completions';
  if(!['openai-completions','openai-responses','anthropic-messages','google-generative-ai'].includes(api))return unavailable('此模型协议不支持自定义温度');
  const max=api==='anthropic-messages'?1:2;
  if(model?.temperatureSupported===false||model?.compat?.supportsTemperature===false)return {supported:false,min:0,max,reason:'此模型适配器不支持自定义温度'};
  if(api==='anthropic-messages'&&(model?.compat?.supportsMidConvoEffort===true||(selection.reasoningEffort&&selection.reasoningEffort!=='off')))return {supported:false,min:0,max,reason:'此模型的推理模式不支持自定义温度'};
  return {supported:true,min:0,max};
}

export function assertTemperatureSupported(provider,model,selection={}) {
  if(selection.temperature===undefined||selection.temperature===null)return;
  const value=selection.temperature,capability=temperatureCapability(provider,model,selection);
  if(typeof value!=='number'||!Number.isFinite(value)||value<capability.min||value>capability.max)throw Object.assign(new Error(`温度必须为 ${capability.min} 到 ${capability.max} 的有限数值`),{code:'MODEL_TEMPERATURE_INVALID'});
  if(!capability.supported)throw Object.assign(new Error(capability.reason),{code:'MODEL_TEMPERATURE_UNSUPPORTED'});
}
