import { createApp } from 'vue'
import App from './App.vue'
import ManagementApp from './ManagementApp.vue'
import './styles.css'
import {installInputMode} from './input-mode.mjs'
const stopInputMode=installInputMode(document)
if(import.meta.hot)import.meta.hot.dispose(stopInputMode)
const management=['management','settings'].includes(new URLSearchParams(location.search).get('window')??'')
createApp(management?ManagementApp:App).mount('#app')
