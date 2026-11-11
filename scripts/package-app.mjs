import {assertProductVersionBuildStamp} from './product-version-build.mjs';
import {assertProductVersionConsistency} from '../src/shared/product-version.mjs';
import {packageProductIdentity,normalizeOwnedMacBundleVersions} from './package-product-version.mjs';
import {packager} from '@electron/packager';
import {mkdir,readFile,writeFile,cp,rm,lstat,readdir,readlink,stat,rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageChannels} from './package-channels.mjs';
import {stageImageDependencies} from './stage-image-dependencies.mjs';
import {packageTtuf} from './package-ttuf.mjs';
import {validateNapcatRuntime} from '../src/plugins/napcat-managed.mjs';
import {packageDshPlugin} from './dsh-package-plugin.mjs';
import {buildNativeWindowControls} from './build-native-window-controls.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
assertProductVersionConsistency(pkg,JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8')));
const platform=process.env.SAND_TARGET_PLATFORM || process.platform,arch=process.env.SAND_TARGET_ARCH || process.arch;
const productVersion=packageProductIdentity(pkg,platform);
assertProductVersionBuildStamp(JSON.parse(await readFile(path.join(root,'dist/product-version.json'),'utf8')),pkg);
const bridgeArchives=await packageDshPlugin(path.join(root,'release/plugins'));
const channelArchives=[...await packageChannels(path.join(root,'release/plugins')),...await packageTtuf(path.join(root,'release/plugins'))];
const runtime=path.join(root,'runtime/dsh');const manifest=JSON.parse(await readFile(path.join(runtime,'manifest.json'),'utf8'));
const napcatRuntime=path.join(root,'runtime/napcat');
if(platform==='darwin'){const napcat=await validateNapcatRuntime(napcatRuntime);if(napcat.platform!==platform||!['universal',arch].includes(napcat.arch))throw new Error('NapCat runtime does not match target platform/architecture');}
if(manifest.platform!==platform||manifest.arch!==arch)throw new Error(`Need an official DSH+Node bundle for ${platform}/${arch}; existing bundle is ${manifest.platform}/${manifest.arch}`);
if(platform==='darwin'){const nativeBuild=await buildNativeWindowControls({arch});if(nativeBuild.skipped)throw new Error('The macOS native controls require a macOS build host');}
await stat(path.join(root,'dist/index.html'));await stat(path.join(root,'src/server.mjs'));
const stage=path.join(root,'.package-stage');await rm(stage,{recursive:true,force:true});
const appStage=path.join(stage,'app'),backendStage=path.join(stage,'backend');await mkdir(appStage,{recursive:true});await mkdir(backendStage,{recursive:true});
await writeFile(path.join(appStage,'package.json'),JSON.stringify({name:pkg.name,productName:pkg.productName,version:pkg.version,description:pkg.description,main:'desktop/main.mjs',type:'module'},null,2));
await mkdir(path.join(appStage,'src/shared'),{recursive:true});await cp(path.join(root,'src/shared/product-version.mjs'),path.join(appStage,'src/shared/product-version.mjs'));
// Main imports credentialKey through the dedicated submission handler.
await mkdir(path.join(appStage,'src/core'),{recursive:true});await cp(path.join(root,'src/core/role-credential-store.mjs'),path.join(appStage,'src/core/role-credential-store.mjs'));
await writeFile(path.join(appStage,'product-version.json'),JSON.stringify(productVersion,null,2));
await writeFile(path.join(backendStage,'product-version.json'),JSON.stringify(productVersion,null,2));
await cp(path.join(root,'desktop'),path.join(appStage,'desktop'),{recursive:true,filter:src=>!path.basename(src).startsWith('._')});
await cp(path.join(root,'src'),path.join(backendStage,'src'),{recursive:true,filter:src=>!src.startsWith(path.join(root,'src/ui'))&&!path.basename(src).startsWith('._')});
// Backend modules import reviewed bridge contracts relative to their own files.
// Keep those imports self-contained; the runtime's installed plugin copy below
// has a separate location and lifecycle.
await cp(path.join(root,'plugins'),path.join(backendStage,'plugins'),{recursive:true,verbatimSymlinks:true,filter:src=>!path.basename(src).startsWith('._')});
await cp(path.join(root,'dist'),path.join(backendStage,'dist'),{recursive:true});
const stagedPlugins=path.join(backendStage,'release/plugins');await mkdir(stagedPlugins,{recursive:true});
for(const archive of [...bridgeArchives.files,bridgeArchives.files[0].replace(/\.zip$/,'.sha256'),...channelArchives.map(item=>item.path),path.join(root,'release/plugins/channels-manifest.json')])await cp(archive,path.join(stagedPlugins,path.basename(archive)));
await writeFile(path.join(backendStage,'package.json'),JSON.stringify({name:pkg.name,version:pkg.version,private:true,type:'module',dependencies:{sharp:pkg.dependencies.sharp}}));
if(platform!==process.platform||arch!==process.arch)throw new Error('Image dependencies require a build host matching the target platform/architecture');
await stageImageDependencies({projectRoot:root,backendStage});
const result=await packager({dir:appStage,out:path.join(root,'release'),name:'沙之书',executableName:'Sandbook',icon:path.join(root,'desktop/assets/icon'),appBundleId:'app.sandbook.desktop',appVersion:productVersion.appVersion,buildVersion:productVersion.buildVersion,platform,arch,electronVersion:pkg.devDependencies.electron,asar:{unpack:'**/*.node'},prune:false,overwrite:true,junk:true,extraResource:[backendStage],afterCopyExtraResources:[async({buildPath})=>{
  const resources=platform==='darwin'?path.join(buildPath,'沙之书.app/Contents/Resources'):path.join(buildPath,'resources');
  // Node's cp default rewrites pnpm links to absolute source paths. Preserve
  // their exact relative text so the distribution survives moving computers.
  await cp(runtime,path.join(resources,'dsh'),{recursive:true,verbatimSymlinks:true,filter:src=>!path.basename(src).startsWith('._')});
  if(platform==='darwin'){await cp(napcatRuntime,path.join(resources,'napcat'),{recursive:true,verbatimSymlinks:true});await validateNapcatRuntime(path.join(resources,'napcat'));}
  await cp(path.join(root,'plugins'),path.join(resources,'plugins'),{recursive:true,verbatimSymlinks:true});
}],extendInfo:{NSHighResolutionCapable:true,LSApplicationCategoryType:'public.app-category.lifestyle',NSHumanReadableCopyright:'沙之书 · SUNA'}});
const output=result[0];const appPath=platform==='darwin'?path.join(output,'沙之书.app'):output;
if(platform==='darwin')await normalizeOwnedMacBundleVersions(appPath,pkg.version);
const resources=platform==='darwin'?path.join(appPath,'Contents/Resources'):path.join(appPath,'resources');
let linkCount=0;async function verifyLinks(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink()){linkCount++;const target=await readlink(file);if(path.isAbsolute(target)||!path.resolve(path.dirname(file),target).startsWith(path.join(resources,'dsh')+path.sep))throw new Error('Nonportable runtime symlink: '+file);await stat(file);}else if(entry.isDirectory())await verifyLinks(file);}}
await verifyLinks(path.join(resources,'dsh'));
const exec=(cmd,args)=>new Promise((resolve,reject)=>{const child=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error(output)));});
if(platform==='darwin'){
  // Preserve the prepared QQ signatures/entitlements and its integrity manifest.
  // Signing the surrounding Electron tree with --deep must not rewrite QQ.
  const nativeAddon=path.join(resources,'app.asar.unpacked/desktop',`native-window-controls-darwin-${arch}.node`);await stat(nativeAddon);await exec('/usr/bin/codesign',['--force','--sign','-',nativeAddon]);await exec('/usr/bin/codesign',['--verify','--strict',nativeAddon]);
  const napcat=path.join(resources,'napcat'),held=path.join(stage,'napcat-signing');
  await rename(napcat,held);
  try{await exec('/usr/bin/codesign',['--force','--deep','--sign','-',appPath]);}
  finally{await rename(held,napcat);}
  await exec('/usr/bin/codesign',['--force','--sign','-',appPath]);
  await validateNapcatRuntime(napcat);
}
let archive;if(platform==='darwin'){archive=path.join(root,'release',`sandbook-${pkg.version}-mac-${arch}.zip`);await rm(archive,{force:true});await exec('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc','--noextattr','--noqtn','--noacl',appPath,archive]);}
const report={createdAt:new Date().toISOString(),appPath,platform,arch,version:pkg.version,versionDisplay:productVersion.versionDisplay,releaseStage:productVersion.releaseStage,platformNumericVersion:productVersion.platformNumericVersion,electronAppVersion:productVersion.appVersion,electronBuildVersion:productVersion.buildVersion,electron:pkg.devDependencies.electron,dsh:manifest.version,relativeRuntimeSymlinksVerified:linkCount,signing:platform==='darwin'?'local ad-hoc signature; not notarized':'unsigned',defaultWorkspace:'dataDir/workspace',archive,...(archive?{archiveBytes:(await stat(archive)).size,archiveMetadata:'ditto --norsrc --noextattr --noqtn --noacl',sha256:createHash('sha256').update(await readFile(archive)).digest('hex')}:{})};await writeFile(path.join(root,'release/package-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
