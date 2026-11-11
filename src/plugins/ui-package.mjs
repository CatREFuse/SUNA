import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function validatePluginUI(manifest,files){
  if(manifest.ui===undefined)return;
  if(!manifest.ui||Object.keys(manifest.ui).some(key=>key!=='entry')||manifest.ui.entry!=='ui.html'||!manifest.files?.['ui.html']||!files.has('ui.html')||files.get('ui.html').length>512*1024)throw new Error('PLUGIN_UI_INVALID');
}
export async function readPluginUI(record){
  if(!record?.manifest.ui)throw new Error('PLUGIN_UI_UNAVAILABLE');
  const file=path.join(record.directory,'ui.html'),info=await fs.lstat(file);
  if(!info.isFile()||info.size>512*1024||await fs.realpath(file)!==file)throw new Error('PLUGIN_FILE_INTEGRITY');
  const bytes=await fs.readFile(file);
  if(createHash('sha256').update(bytes).digest('hex')!==record.manifest.files['ui.html'])throw new Error('PLUGIN_FILE_INTEGRITY');
  return bytes.toString('utf8');
}
export const pluginUICsp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";
