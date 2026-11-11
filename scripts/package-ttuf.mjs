import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createZip,sha256} from '../src/channels/archive.mjs';
import {readTtufPackage} from '../src/plugins/ttuf-package.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function packageTtuf(outputDirectory=path.join(root,'release/plugins')){
  const source=path.join(root,'plugins/ttuf-example'),entry=await fs.readFile(path.join(source,'index.mjs')),manifest=JSON.parse(await fs.readFile(path.join(source,'manifest.json')));
  manifest.files={'index.mjs':sha256(entry)};
  const bytes=createZip(new Map([['manifest.json',Buffer.from(JSON.stringify(manifest,null,2))],['index.mjs',entry]]));readTtufPackage(bytes);
  await fs.mkdir(outputDirectory,{recursive:true});const destination=path.join(outputDirectory,`${manifest.id}-${manifest.version}.zip`);
  const checkExisting=async()=>{
    try{
      if(!(await fs.readFile(destination)).equals(bytes))throw new Error(`PACKAGE_VERSION_CONFLICT: ${path.basename(destination)} already exists with different bytes; bump the plugin version`);
      return true;
    }catch(error){if(error.code==='ENOENT')return false;throw error;}
  };
  await checkExisting();
  try{await fs.writeFile(destination,bytes,{flag:'wx'});}
  catch(error){if(error.code!=='EEXIST')throw error;await checkExisting();}
  return [{id:manifest.id,version:manifest.version,path:destination,bytes:bytes.length,sha256:sha256(bytes)}];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)console.log(JSON.stringify(await packageTtuf(process.argv[2]),null,2));
