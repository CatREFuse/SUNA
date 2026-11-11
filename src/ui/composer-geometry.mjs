const rtlCharacter=/[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const letter=/\p{Letter}/u;
export function composerDirection(text=''){for(const character of Array.from(String(text).slice(0,4096))){if(rtlCharacter.test(character))return 'rtl';if(letter.test(character))return 'ltr';}return 'ltr';}
export function composerContentHeight(raw,content,field){const preferred=Math.max(20,Math.min(120,Number(raw)||20));const measured=Math.max(0,Number(content)||0);const fieldHeight=Math.max(0,Number(field)||0);return measured>fieldHeight?preferred+measured-fieldHeight:preferred;}
export function composerAutoExpanded(previous,{text='',raw=0,source='edit'}={}){const hasContent=String(text).length>0;const needsExpansion=String(text).includes('\n')||Number(raw)>=40||(Boolean(previous)&&hasContent);return source==='layout'&&Boolean(previous)&&!needsExpansion?true:needsExpansion;}
