// Vue still owns the host; the same visual text entity survives local/ACK updates.
const renderedHTML=new WeakMap();
const escaped=value=>String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
export function adoptMessageText(host,{node,active,html,text}={}){
 if(!node||!active)return;
 if(host.firstChild!==node||host.childNodes.length!==1)host.replaceChildren(node);
 if(renderedHTML.get(node)!==html){
  // Plain single-paragraph messages retain the original glyph Text node as well.
  const plain=typeof text==='string'&&node.textContent===text&&html===`<p>${escaped(text).replace(/\n/g,'<br>\n')}</p>\n`;
  if(plain)node.style.whiteSpace='pre-wrap';else{node.innerHTML=html;node.style.whiteSpace='normal'}
  renderedHTML.set(node,html)
 }
}
