export const pricingFields = [
  {key:'inputPer1M',label:'输入 · 未命中缓存'},
  {key:'cacheReadPer1M',label:'输入 · 缓存读取'},
  {key:'write30m',label:'缓存写入 · 30 分钟'},
  {key:'write12h',label:'缓存写入 · 12 小时'},
  {key:'outputPer1M',label:'输出'},
];
export function pricingDraft(value) {
  return Object.fromEntries(pricingFields.map(({key}) => [key, String((key==='write30m'?value?.cacheWritePer1M?.['30m']:key==='write12h'?value?.cacheWritePer1M?.['12h']:value?.[key])??'')]));
}
export function updatePricing(value, draft, currency) {
  const rates={};
  for(const {key} of pricingFields){
    const text=String(draft[key]??'').trim();
    if(text && (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text)||!Number.isFinite(Number(text))||Number(text)>1e9)) throw new Error('费率须为 0–1,000,000,000 的数字，空白表示未配置。');
    rates[key]=text===''?null:Number(text);
  }
  const code=String(currency??'').trim();
  if(code && !/^[A-Z]{3}$/u.test(code)) throw new Error('币种须为三位大写代码，如 USD；空白表示未配置。');
  return {...JSON.parse(JSON.stringify(value??{})),schemaVersion:1,basis:'custom',basisLabel:'API 参考估算',origin:'custom',userOverride:true,unitTokens:1000000,currency:code||null,inputPer1M:rates.inputPer1M,cacheReadPer1M:rates.cacheReadPer1M,cacheWritePer1M:{...(value?.cacheWritePer1M??{}),'30m':rates.write30m,'12h':rates.write12h},outputPer1M:rates.outputPer1M};
}
