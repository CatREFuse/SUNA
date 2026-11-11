// Keep the original presentation while masking secrets in decoded ASCII views.
// API keys are printable ASCII. Percent-decoding is bounded to prevent hostile
// provider text from forcing unbounded normalization work.
export function redactWebText(value,secrets){
 const original=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
 const keys=secrets.filter(Boolean);if(!keys.length)return original;
 if(!original.includes('%')&&!/[\u0000-\u001f\u007f]/.test(original)){let out=original;for(const key of keys)out=out.split(key).join('[已隐藏]');return out;}
 let text=original,starts=Int32Array.from({length:text.length},(_,i)=>i),ends=Int32Array.from({length:text.length},(_,i)=>i+1);const ranges=[];
 for(let pass=0;pass<=4;pass++){
  for(const key of keys){let offset=0,index;while((index=text.indexOf(key,offset))!==-1){ranges.push([starts[index],ends[index+key.length-1]]);offset=index+key.length;}}
  // A still-encoded view cannot establish absence of credentials. Withhold
  // the field rather than spending unbounded time decoding hostile nesting.
  if(pass===4){if(/%[a-f0-9]{2}/i.test(text))return '[多层编码内容已隐藏]';break;}
  if(!text.includes('%')&&!/[\u0000-\u001f\u007f]/.test(text))break;
  const nextStarts=new Int32Array(text.length),nextEnds=new Int32Array(text.length),parts=[];let count=0,changed=false;
  for(let i=0;i<text.length;i++){
   let char=text[i],end=i;
   if(char==='%'&&/^[a-f0-9]{2}$/i.test(text.slice(i+1,i+3))){const byte=parseInt(text.slice(i+1,i+3),16);char=String.fromCharCode(byte);end=i+2;changed=true;}
   if(char.charCodeAt(0)>=32&&char.charCodeAt(0)!==127){parts.push(char);nextStarts[count]=starts[i];nextEnds[count]=ends[end];count++;}else changed=true;
   i=end;
  }
  if(!changed)break;text=parts.join('');starts=nextStarts.subarray(0,count);ends=nextEnds.subarray(0,count);
 }
 if(!ranges.length)return original;
 ranges.sort((a,b)=>a[0]-b[0]||b[1]-a[1]);const chunks=[];let cursor=0;
 for(let i=0;i<ranges.length;){const start=ranges[i][0];let end=ranges[i++][1];while(i<ranges.length&&ranges[i][0]<=end)end=Math.max(end,ranges[i++][1]);if(start>=cursor){chunks.push(original.slice(cursor,start),'[已隐藏]');cursor=end;}}
 chunks.push(original.slice(cursor));return chunks.join('');
}
