// Interpret only documented structured failures or a narrowly recognised
// upstream parameter rejection. Never return the upstream text or metadata.
export function codexImageFailureCode(value,fallback='IMAGE_CLI_GENERATION_FAILED'){
 if(value?.type==='usageLimitExceeded')return 'IMAGE_CLI_USAGE_LIMIT';
 if(typeof value?.message==='string'&&value.message.length<=8192&&/\bComplexity '[a-z]{1,32}' is not supported for this image model\./i.test(value.message))return 'IMAGE_CLI_PARAMETER_UNSUPPORTED';
 return fallback;
}
