import {readFile,writeFile,readdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {parseProductVersion,platformProductVersion} from '../src/shared/product-version.mjs';
const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function normalizeMacVersionPlist(text,machineVersion){
 const v=parseProductVersion(machineVersion);platformProductVersion(machineVersion,'darwin');
 for(const key of ['CFBundleShortVersionString','CFBundleVersion']){const expression=new RegExp('(<key>'+key+'</key>\\s*<string>)[^<]*(</string>)','g'),matches=[...text.matchAll(expression)];if(matches.length!==1)throw Error('PRODUCT_PLIST_VERSION_INVALID');text=text.replace(expression,(_all,before,after)=>before+v.numericVersion+after);}
 // A custom product identity preserves alpha while Apple's numeric keys remain valid.
 for(const [key,value]of Object.entries({SUNAProductVersion:v.machineVersion,SUNAProductVersionDisplay:v.displayVersion})){const expression=new RegExp('(<key>'+key+'</key>\\s*<string>)[^<]*(</string>)','g'),matches=[...text.matchAll(expression)];if(matches.length>1)throw Error('PRODUCT_PLIST_VERSION_INVALID');if(matches.length)text=text.replace(expression,(_all,before,after)=>before+xml(value)+after);else{const at=text.lastIndexOf('</dict>');if(at<0)throw Error('PRODUCT_PLIST_VERSION_INVALID');text=text.slice(0,at)+`<key>${key}</key><string>${xml(value)}</string>\n`+text.slice(at);}}
 return text;
}
export async function normalizeOwnedMacBundleVersions(appPath,machineVersion,{productName='沙之书'}={}){
 if(!(await lstat(appPath)).isDirectory()||(await lstat(appPath)).isSymbolicLink())throw Error('PRODUCT_APP_LINK_REJECTED');appPath=await realpath(appPath);
 const contents=path.join(appPath,'Contents'),files=[path.join(contents,'Info.plist')],frameworks=path.join(contents,'Frameworks');
 for(const [directory,prefix]of [[frameworks,productName+' Helper'],[path.join(contents,'Library/LoginItems'),productName+' Login Helper']]){let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}for(const entry of entries){if(!entry.name.startsWith(prefix)||!entry.name.endsWith('.app'))continue;if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('PRODUCT_HELPER_LINK_REJECTED');files.push(path.join(directory,entry.name,'Contents/Info.plist'));}}
 const pending=[];for(const file of files){if(!(await lstat(file)).isFile()||await realpath(file)!==path.resolve(file))throw Error('PRODUCT_PLIST_LINK_REJECTED');pending.push([file,normalizeMacVersionPlist(await readFile(file,'utf8'),machineVersion)]);}for(const [file,text]of pending)await writeFile(file,text);return files;
}
export function packageProductIdentity(pkg,platform){const v=platformProductVersion(pkg.version,platform);return {version:v.machineVersion,versionDisplay:v.displayVersion,releaseStage:v.releaseStage,platformNumericVersion:v.platformNumericVersion,appVersion:v.appVersion,buildVersion:v.buildVersion};}
