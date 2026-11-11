export const categories=[{id:'all',label:'全部'},{id:'client-function',label:'Client 功能'},{id:'client-worker',label:'Client Worker'},{id:'runtime-loop',label:'Runtime Loop'}];
export function numberText(value){return typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:2}):'—'}
export function rateText(value){return typeof value==='number'&&Number.isFinite(value)?`${(value*100).toLocaleString('zh-CN',{maximumFractionDigits:1})}%`:'—'}
export function moneyText(value,currency){return typeof value==='number'&&Number.isFinite(value)&&currency?`${currency} ${value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6})}`:'—'}
export function costLines(group){
 if(!group)return ['—'];
 const cost=group.cost;
 if(!cost)return ['未配置'];
 const rows=(cost.byCurrency??[]).map(row=>typeof row.amount==='number'?moneyText(row.amount,row.currency):`${moneyText(row.knownSubtotal,row.currency)} · 部分估算`);
 if(cost.unpricedCalls>0)rows.push(`${cost.unpricedCalls} 次未配置`);
 return rows.length?rows:[group.calls===0?'—':'未配置'];
}
export function estimateText(estimate){if(!estimate)return '未配置';if(estimate.status==='complete')return moneyText(estimate.amount,estimate.currency);if(estimate.status==='partial')return `${moneyText(estimate.knownSubtotal,estimate.currency)} · 部分估算`;return '未配置'}
export function coverageText(group){if(!group)return '未采集';if(group.calls>0&&group.usageCoverage?.unknown===group.calls)return '未采集';if(group.usageCoverage?.partial>0||group.usageCoverage?.unknown>0)return '部分记录';return group.calls===0?'暂无调用':''}
export function statusText(value){return ({unknown:'结果未知',completed:'已完成',success:'成功',succeeded:'成功',failed:'失败',error:'失败',cancelled:'已取消',canceled:'已取消',running:'运行中',started:'已开始',queued:'等待中',pending:'等待中',interrupted:'已中断',sending:'发送中',accepted:'已受理',delivered:'已送达',passed:'通过',rejected:'已拒绝',skipped:'已跳过',timeout:'超时'})[value]??value??'未知'}
export function timeText(value){const date=new Date(value);return Number.isNaN(date.getTime())?'—':date.toLocaleTimeString('zh-CN',{hour12:false})}

// Mirror the ledger input denominator; unknown counters cannot become zero.
export function callCacheRate(usage){
 if(typeof usage?.cacheRate==='number'&&Number.isFinite(usage.cacheRate)&&usage.cacheRate>=0&&usage.cacheRate<=1)return usage.cacheRate;
 const counters=[usage?.input,usage?.cacheRead,usage?.cacheWrite];
 if(!counters.every(value=>Number.isSafeInteger(value)&&value>=0))return null;
 const denominator=counters.reduce((sum,value)=>sum+value,0);
 return Number.isSafeInteger(denominator)&&denominator>0?usage.cacheRead/denominator:null;
}
