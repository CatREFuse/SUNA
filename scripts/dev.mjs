import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildNativeWindowControls} from './build-native-window-controls.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),electron=require('electron');
if(process.platform==='darwin')await buildNativeWindowControls({arch:process.arch});
const children=[];let closing=false;
const launch=(cmd,args,env={})=>{const child=spawn(cmd,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});children.push(child);child.once('error',error=>{console.error(error.message);stop(1);});return child;};
function stop(code=0){if(closing)return;closing=true;for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');setTimeout(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');process.exit(code);},15000).unref();}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
const vite=launch(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','4260','--strictPort']);vite.once('exit',code=>{if(!closing)stop(code || 0);});
let ready=false;for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:4260')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
if(!ready){console.error('Vite did not become ready');stop(1);}else{const desktop=launch(electron,['.'],{SAND_RENDERER_URL:'http://127.0.0.1:4260',SAND_PORT:'4261',SAND_DATA_DIR:path.join(root,'.suna-dev'),ELECTRON_RUN_AS_NODE:''});desktop.once('exit',code=>stop(code || 0));}
