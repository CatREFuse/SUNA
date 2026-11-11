// Native capability reports never replace the user's persisted preferences.
export function createWindowAppearanceBinding({bridge,readPreference,style,onError=error=>{void error;}}){
  let disposed=false,started=false,stop,capability,capabilityRevision=0,requestRevision=0;
  const preference=()=>{const value=readPreference();return {transparency:Number.isInteger(value?.transparency)&&value.transparency>=0&&value.transparency<=100?value.transparency:50,blur:value?.blur==='off'?'off':'system'};};
  function render(){
    if(disposed)return;
    const saved=preference(),reduced=capability?.reducedTransparency===true;
    style.setProperty('--window-glass-opacity',String(reduced?1:1-saved.transparency/100));
    // On unsupported platforms this is only the Web backdrop, not native window blur.
    style.setProperty('--window-blur',reduced||saved.blur==='off'?'0px':'24px');
  }
  function receive(value){if(disposed)return;capabilityRevision++;capability=value;render();}
  function start(){
    if(started||disposed)return;started=true;
    stop=bridge?.onWindowAppearance?.(receive);render();
    const revision=capabilityRevision;
    void bridge?.getWindowAppearance?.().then(value=>{if(!disposed&&revision===capabilityRevision)receive(value);}).catch(error=>{if(!disposed)onError(error);});
  }
  async function applyPreferences(){
    if(disposed)return;render();const request=++requestRevision,revision=capabilityRevision;
    try{const value=await bridge?.setWindowAppearance?.(preference());if(value&&!disposed&&request===requestRevision&&revision===capabilityRevision)receive(value);}
    catch(error){if(!disposed&&request===requestRevision)onError(error);}
  }
  function close(){if(disposed)return;disposed=true;requestRevision++;stop?.();}
  return {start,applyPreferences,close};
}
