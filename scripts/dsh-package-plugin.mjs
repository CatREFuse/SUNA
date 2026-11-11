import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function packageDshPlugin(out=path.join(root,'release/plugins')){
const source=path.join(root,'plugins/suna-dsh');await mkdir(out,{recursive:true});
const pkg=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
const exec=(cmd,args,options={})=>new Promise((resolve,reject)=>{const child=spawn(cmd,args,{...options,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(output)));});
const npm=path.join(root,'runtime/dsh/package-managers/npm/bin/npm-cli.js');
await exec(process.execPath,[npm,'pack','--pack-destination',out,'--ignore-scripts','--cache',path.join(root,'.qa/npm-pack-cache')],{cwd:source});
const zip=path.join(out,`suna-dsh-bridge-${pkg.version}.zip`);await rm(zip,{force:true});
await exec('python3',['-c',`from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root=Path(${JSON.stringify(source)})
with ZipFile(${JSON.stringify(zip)},'w',ZIP_DEFLATED) as z:
 for f in sorted(root.iterdir()):
  if f.is_file():z.write(f, 'suna-dsh-bridge/'+f.name)
`]);
const files=[zip,path.join(out,`suna-dsh-bridge-${pkg.version}.tgz`)];const hashes=[];for(const f of files)hashes.push(`${createHash('sha256').update(await readFile(f)).digest('hex')}  ${path.basename(f)}`);
await writeFile(path.join(out,`suna-dsh-bridge-${pkg.version}.sha256`),hashes.join('\n')+'\n');
return {files};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await packageDshPlugin()));
