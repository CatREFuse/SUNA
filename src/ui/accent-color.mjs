/** Accent values and palette generation are shared by UI and server validation. */
export const DEFAULT_ACCENT = '#38BDF8';
/** @type {ReadonlyArray<Readonly<{value:string,label:string}>>} */
export const ACCENT_PRESETS = Object.freeze([
  {value:'#38bdf8',label:'天蓝'},
  {value:'#6366f1',label:'蓝'},
  {value:'#a855f7',label:'紫'},
  {value:'#ec4899',label:'粉'},
  {value:'#ef4444',label:'红'},
  {value:'#f59e0b',label:'橙'},
  {value:'#22c55e',label:'绿'},
].map(preset=>Object.freeze(preset)));
export function isAccentColor(value) { return typeof value === 'string' && /^#[\da-f]{6}$/iu.test(value); }
export function normalizeAccent(value) { return (isAccentColor(value) ? value : DEFAULT_ACCENT).toLowerCase(); }
export function isAccentTextMode(value) { return value === 'auto' || value === 'dark' || value === 'light'; }
export function normalizeAccentTextMode(value) { return isAccentTextMode(value) ? value : 'auto'; }
const rgb = hex => [1,3,5].map(index => parseInt(hex.slice(index,index+2),16));
const hex = channels => '#' + channels.map(value=>Math.max(0,Math.min(255,Math.round(value))).toString(16).padStart(2,'0')).join('');
function luminance(color) {
  const channels=rgb(color).map(value=>{const srgb=value/255;return srgb<=0.04045?srgb/12.92:((srgb+0.055)/1.055)**2.4;});
  return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
}
function contrast(a,b) { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05); }
function mix(from,to,amount) { const start=rgb(from),end=rgb(to);return hex(start.map((value,index)=>value+(end[index]-value)*amount)); }
/** Keep the selected base exact; derive readable text and subdued selection separately. */
export function createAccentPalette(value,dark=false,textMode='auto') {
  const base=normalizeAccent(value),surface=dark?'#2b2b2b':'#fafafa';
  const soft=mix(surface,base,dark?0.18:0.12);
  const autoOn=contrast(base,'#000000')>=contrast(base,'#ffffff')?'#000000':'#ffffff';
  const on=textMode==='dark'?'#000000':textMode==='light'?'#ffffff':autoOn;
  const hover=mix(base,autoOn==='#000000'?'#ffffff':'#000000',autoOn==='#000000'?0.10:0.12);
  const backgrounds=dark?[surface,'#222222','#333333','#383838','#3a3a3a',soft]:[surface,'#e9e9e9','#f6f6f6',soft];
  const readable=color=>backgrounds.every(background=>contrast(color,background)>=4.6);
  let ink=base;
  if(!readable(ink)){
    const target=dark?'#ffffff':'#000000';
    let low=0,high=1;
    // Search quantized display colors, leaving contrast headroom above WCAG 4.5.
    for(let i=0;i<24;i++){const middle=(low+high)/2;if(readable(mix(base,target,middle)))high=middle;else low=middle;}
    ink=mix(base,target,high);
  }
  return {'--accent':base,'--on-accent':on,'--accent-hover':hover,'--accent-soft':soft,'--accent-ink':ink,'--selected':soft,'--focus':ink};
}
export function applyAccent(style,value,dark=false,textMode='auto') {
  const palette=createAccentPalette(value,dark,textMode);
  if(typeof style?.setProperty==='function')for(const [key,color] of Object.entries(palette))style.setProperty(key,color);
  return palette;
}
const clamp=(value,min,max)=>Math.max(min,Math.min(max,typeof value==='number'&&Number.isFinite(value)?value:min));
export function hexToHsv(value) {
  const [r,g,b]=rgb(normalizeAccent(value)).map(channel=>channel/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  let h=0;
  if(delta){if(max===r)h=((g-b)/delta)%6;else if(max===g)h=(b-r)/delta+2;else h=(r-g)/delta+4;h=(h*60+360)%360;}
  return {h,s:max===0?0:delta/max,v:max};
}
export function hsvToHex(options={}) {
  const {h=0,s=0,v=0}=options&&typeof options==='object'?options:{};
  const hue=clamp(h,0,360)%360,saturation=clamp(s,0,1),value=clamp(v,0,1),chroma=value*saturation;
  const x=chroma*(1-Math.abs((hue/60)%2-1)),m=value-chroma;
  const channels=hue<60?[chroma,x,0]:hue<120?[x,chroma,0]:hue<180?[0,chroma,x]:hue<240?[0,x,chroma]:hue<300?[x,0,chroma]:[chroma,0,x];
  return hex(channels.map(channel=>(channel+m)*255));
}
