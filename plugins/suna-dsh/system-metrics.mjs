import os from 'node:os';
import {statfs} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

// Only aggregate counters and the fixed role-workspace volume are inspected.
// No process list, command execution, caller-selected path or environment data.
const ticks=cpus=>cpus.reduce((sum,cpu)=>{for(const [key,value] of Object.entries(cpu.times)){sum.total+=value;if(key==='idle')sum.idle+=value;}return sum;},{total:0,idle:0});
export async function readSystemMetrics(workspaceRoot,{signal}={}){
 signal?.throwIfAborted();
 let modelIdentifier=null;
 if(os.platform()==='darwin')try{const {stdout}=await exec('/usr/sbin/sysctl',['-n','hw.model'],{env:{LANG:'C',PATH:'/usr/bin:/bin'},timeout:1000,maxBuffer:256,signal});const model=stdout.trim();if(/^[A-Za-z][A-Za-z0-9,._-]{0,79}$/.test(model))modelIdentifier=model;}catch{signal?.throwIfAborted();}
 const started=performance.now(),before= ticks(os.cpus());
 await delay(100,undefined,{signal});
 const afterCpus=os.cpus(),after=ticks(afterCpus),sampleIntervalMs=Math.round((performance.now()-started)*1000)/1000;
 const disk=await statfs(workspaceRoot),totalBytes=os.totalmem(),freeBytes=os.freemem(),delta=after.total-before.total,idle=after.idle-before.idle;
 signal?.throwIfAborted();
 if(!afterCpus.length||delta<=0||idle<0||idle>delta||!Number.isSafeInteger(totalBytes)||!Number.isSafeInteger(freeBytes)||freeBytes<0||freeBytes>totalBytes)throw new Error('系统指标暂不可用。');
 const diskTotal=disk.bsize*disk.blocks,diskFree=disk.bsize*disk.bfree,diskAvailable=disk.bsize*disk.bavail;
 if(![diskTotal,diskFree,diskAvailable].every(n=>Number.isSafeInteger(n)&&n>=0)||diskTotal<=0||diskFree>diskTotal||diskAvailable>diskFree)throw new Error('工作区所在卷的容量指标暂不可用。');
 return {schemaVersion:1,capturedAt:new Date().toISOString(),machine:{platform:os.platform(),architecture:os.arch(),machine:os.machine(),modelIdentifier},cpu:{logicalCores:afterCpus.length,sampleIntervalMs,utilizationPercent:Math.round((delta-idle)/delta*10000)/100},memory:{totalBytes,freeBytes,usedBytes:totalBytes-freeBytes,usedIncludesCaches:true},disk:{scope:'workspace-volume',totalBytes:diskTotal,freeBytes:diskFree,availableBytes:diskAvailable,usedBytes:diskTotal-diskFree}};
}

const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export function systemMetricsShellFunction(metrics){
 const result=metrics?`printf '%s\\n' ${quote(JSON.stringify(metrics))}`:"printf '%s\\n' '系统指标暂不可用。' >&2; return 69";
 return `suna_system_metrics() { if [ "$#" -ne 0 ]; then printf '%s\\n' 'suna_system_metrics 不接受参数。' >&2; return 64; fi; ${result}; }; readonly -f suna_system_metrics; `;
}

export const systemMetricsInstructions='受限 Bash 提供无参只读命令 suna_system_metrics，返回真实宿主机型标识、平台架构、聚合 CPU、内存及固定角色工作区所在卷的磁盘 JSON 快照。machine.modelIdentifier 是安全的硬件型号标识（读取失败为 null），不含主机名或序列号。CPU utilizationPercent 为本次 Bash 调用开始时约 100ms 采样区间内所有逻辑核的平均忙碌百分比（0–100），实际区间见 sampleIntervalMs，不是累计 CPU ticks；memory.usedBytes=totalBytes-freeBytes，包含缓存，不等同于应用内存占用；disk 仅表示工作区所在卷，不能指定其他路径。快照时间见 capturedAt，需新数值时重新调用 Bash；不接受任何参数。系统命令不在执行白名单时，换绝对路径不会放行。本运行不支持申请更宽沙箱权限，也不存在用户待批准的临时提权流程，不要建议以 sandbox_permissions 提权重试。';
