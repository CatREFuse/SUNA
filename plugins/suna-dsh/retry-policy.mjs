// Custom adapter profiles bypass DSH's configuration resolver, so they must
// supply its complete resolved policy. Keep this aligned with dsh-llm defaults.
export function createClientRetryPolicy(){
  return Object.freeze({mode:'normal',maxRetries:1,
    retryableCodes:Object.freeze(['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']),
    initialDelayMs:500,maxDelayMs:10000,jitterRatio:0.1});
}
