// Private child of the server, using the bundled Node executable. No network/model/native APIs.
// A process cwd pins a directory inode even if its name is replaced concurrently.
import {constants,openSync,closeSync,readSync,writeSync,fstatSync,lstatSync,mkdirSync,linkSync,unlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=()=>{throw new Error('附件工作区或文件在复制期间发生变化');};
const same=(a,b)=>['dev','ino'].every(k=>String(a[k])===String(b[k]));
function enter(name){try{mkdirSync(name,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const before=lstatSync(name,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink())fail();process.chdir(name);if(!same(before,lstatSync('.',{bigint:true})))fail();}
function read(file,size,sha){let fd,bytes;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(size)||size>16*1024*1024)fail();bytes=Buffer.alloc(size+1);let used=0;while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,used);if(!n)break;used+=n;}const after=fstatSync(fd,{bigint:true});if(used!==size||hash(bytes.subarray(0,used))!==sha||['dev','ino','size','mtimeNs','ctimeNs','nlink'].some(k=>before[k]!==after[k]))fail();return bytes.subarray(0,used);}catch(e){bytes?.fill(0);throw e;}finally{if(fd!==undefined)closeSync(fd);}}
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>4*1024*1024)throw new Error('附件请求过大');}
try{const input=JSON.parse(raw);if(!same(input.workspaceIdentity,lstatSync('.',{bigint:true})))fail();const workspace=process.cwd();enter('.suna-attachments');const attachmentRoot=process.cwd(),rootIdentity=lstatSync('.',{bigint:true});
 for(const file of input.files){if(!/^att_[a-f0-9]{32}$/.test(file.id)||!/^attachment\.(?:[A-Za-z0-9]{1,12}|bin)$/.test(file.targetName))fail();process.chdir(attachmentRoot);if(!same(rootIdentity,lstatSync('.',{bigint:true})))fail();enter(file.id);const current=process.cwd(),identity=lstatSync('.',{bigint:true}),bytes=read(file.source,file.size,file.sha256);let temporary;
  try{try{const old=read(file.targetName,file.size,file.sha256);old.fill(0);}catch(e){if(e.code!=='ENOENT')throw e;temporary='.'+randomUUID()+'.tmp';let fd;try{fd=openSync(temporary,'wx',0o600);let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);}finally{if(fd!==undefined)closeSync(fd);} // link-like exclusive target creation avoids replacing any existing role file.
    linkSync(temporary,file.targetName);unlinkSync(temporary);temporary=undefined;
   }
   if(!same(identity,lstatSync(current,{bigint:true}))||!same(rootIdentity,lstatSync(attachmentRoot,{bigint:true}))||!same(input.workspaceIdentity,lstatSync(workspace,{bigint:true})))fail();
  }finally{bytes.fill(0);if(temporary)try{unlinkSync(temporary);}catch{}}
 }
 process.stdout.write('{"ok":true}');
}catch{process.stdout.write('{"ok":false}');process.exitCode=1;}
