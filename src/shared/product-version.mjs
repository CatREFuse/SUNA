// Product version only. Never use this helper for DSH, Bridge or Channel plugin versions.
const pattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function parseProductVersion(value){
 if(typeof value!=='string')throw Error('PRODUCT_VERSION_INVALID');const match=pattern.exec(value);if(!match)throw Error('PRODUCT_VERSION_INVALID');
 const [major,minor,patch]=match.slice(1,4).map(Number);if(![major,minor,patch].every(Number.isSafeInteger)||match[4]?.split('.').some(x=>/^\d+$/.test(x)&&x.length>1&&x[0]==='0'))throw Error('PRODUCT_VERSION_INVALID');
 const numericVersion=`${major}.${minor}.${patch}`,alpha=major===0,prerelease=match[4]??'',metadata=match[5]??'';
 return Object.freeze({machineVersion:value,numericVersion,displayVersion:numericVersion+(alpha?' alpha':prerelease?' '+prerelease:'')+(metadata?' +'+metadata:''),major,minor,patch,prerelease,metadata,alpha,legacyUnlabelled:alpha&&prerelease!=='alpha',canonicalVersion:alpha?numericVersion+'-alpha':value});
}
export function displayProductVersion(value){try{return parseProductVersion(value).displayVersion;}catch{return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(value)?value:'development';}}
export function canonicalReleaseVersion(value){const v=parseProductVersion(value);if(v.metadata||v.major===0&&v.prerelease&&v.prerelease!=='alpha')throw Error('PRODUCT_RELEASE_VERSION_INVALID');return v.major===0?v.numericVersion+'-alpha':v.numericVersion;}
export function platformProductVersion(value,platform){const v=parseProductVersion(value);if(!['darwin','win32','linux'].includes(platform))throw Error('PRODUCT_PLATFORM_INVALID');if([v.major,v.minor,v.patch].some(n=>n>65535))throw Error('PRODUCT_PLATFORM_VERSION_OVERFLOW');return {machineVersion:v.machineVersion,displayVersion:v.displayVersion,appVersion:v.machineVersion,buildVersion:v.numericVersion,platformNumericVersion:platform==='win32'?v.numericVersion+'.0':v.numericVersion,releaseStage:v.alpha?'alpha':v.prerelease||'stable'};}
export function assertProductVersionConsistency(pkg,lock){if(!pkg||!lock||pkg.version!==lock.version||pkg.version!==lock.packages?.['']?.version||pkg.name!==lock.name||pkg.name!==lock.packages?.['']?.name)throw Error('PRODUCT_VERSION_LOCK_MISMATCH');return parseProductVersion(pkg.version);}
