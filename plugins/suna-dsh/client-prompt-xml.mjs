/** Plain Client-authored text becomes XML data after template rendering. */
export function wrapClientDeveloperPrompt(content){
  if(typeof content!=='string')throw new TypeError('开发提示词正文必须为文本');
  if(!content)return '';
  const escaped=content.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  return `<dev-prompt>\n${escaped}\n</dev-prompt>`;
}

export function joinClientPromptLayers(system,wrappedDeveloper=''){
  if(typeof system!=='string'||typeof wrappedDeveloper!=='string')throw new TypeError('Client 提示词必须为文本');
  return system+(wrappedDeveloper?'\n\n'+wrappedDeveloper:'');
}
