import {assertTemperatureSupported} from './model-temperature.mjs';

export function validateRunTemperature(request,config={}) {
  if(request.temperature===undefined)return;
  if(request.temperature===null)throw Object.assign(new Error('本轮温度必须为有限数值'),{code:'MODEL_TEMPERATURE_INVALID'});
  const spec=config.registryProviders?.providers?.[request.provider];
  const ephemeral=(config.ephemeralProviders??[]).find(item=>item.provider===request.provider);
  const model=(spec??ephemeral)?.models?.find(item=>item.id===request.model);
  // Only Client-owned adapters have a verified forwarding path. Native and
  // OAuth adapters keep their own defaults, even if a caller forges the body.
  const provider=spec||ephemeral?{kind:'api-key',api:spec?.api||'openai-completions'}:{kind:'dsh'};
  if(!model)assertTemperatureSupported({kind:'dsh'},undefined,request);
  assertTemperatureSupported(provider,model,request);
}

export function installRunTemperature(ctx,request) {
  if(request.temperature===undefined)return;
  // AgentOptions does not forward temperature in the bundled AgentLoop. This
  // public waterfall runs before prepareCall and durable header construction.
  const {temperature,provider,model}=request;
  return ctx.on('agent/request',async(_event,next)=>{
    const proposal=await next();
    if(proposal.provider!==provider||proposal.model!==model)throw Object.assign(new Error('本轮温度与模型路由不匹配'),{code:'MODEL_TEMPERATURE_ROUTE_CHANGED'});
    return {...proposal,temperature};
  });
}
