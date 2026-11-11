const finiteSize=value=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,value):0;
// Clamp presentation only. The caller retains the preferred width so expanding
// the window restores it without rewriting local preferences.
export function fitConversationAside({workspaceWidth,listWidth,preferredWidth,narrow=false,overlay=false,minimumConversationWidth=420}){
 const available=finiteSize(workspaceWidth),preferred=finiteSize(preferredWidth);
 if(narrow)return available;
 if(overlay)return Math.min(preferred,available);
 return Math.min(preferred,Math.max(0,available-finiteSize(listWidth)-finiteSize(minimumConversationWidth)));
}
