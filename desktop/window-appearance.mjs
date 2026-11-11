export const DEFAULT_WINDOW_APPEARANCE=Object.freeze({transparency:50,blur:'system'});
export function validateWindowAppearance(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['transparency','blur'].includes(key))||!Number.isInteger(value.transparency)||value.transparency<0||value.transparency>100||!['off','system'].includes(value.blur))throw new Error('外观设置无效');
  return {transparency:value.transparency,blur:value.blur};
}
export function createWindowAppearance({nativeTheme,platform=process.platform,windows=()=>[]}={}){
  let appearance={...DEFAULT_WINDOW_APPEARANCE};
  function status(){const reducedTransparency=nativeTheme?.prefersReducedTransparency===true,nativeBlurSupported=platform==='darwin';return {...appearance,effectiveBlur:nativeBlurSupported&&!reducedTransparency?appearance.blur:'off',reducedTransparency,nativeBlurSupported};}
  function apply(window){if(!window||window.isDestroyed())return;const state=status();if(platform==='darwin')window.setVibrancy(state.effectiveBlur==='system'?'sidebar':null);window.webContents.send('sandbook:window-appearance',state);}
  function refresh(){for(const window of windows())apply(window);return status();}
  nativeTheme?.on('updated',refresh);
  return {status,apply,refresh,set(value){appearance=validateWindowAppearance(value);return refresh();},windowOptions(){return status().effectiveBlur==='system'?{vibrancy:'sidebar',visualEffectState:'active'}:{};},close(){nativeTheme?.removeListener('updated',refresh);}};
}
