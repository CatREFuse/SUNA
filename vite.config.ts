import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {productVersionBuildPlugin} from './scripts/product-version-build.mjs'
const packageMetadata=JSON.parse(readFileSync(fileURLToPath(new URL('./package.json',import.meta.url)),'utf8'))

export default defineConfig({
  plugins: [vue(),productVersionBuildPlugin(packageMetadata)],
  base: './',
  optimizeDeps: { entries: ['index.html'] },
  server: {
    host: '127.0.0.1', port: 4260, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4261', '/assets-local': 'http://127.0.0.1:4261', '/media-local': 'http://127.0.0.1:4261' },
  },
  build: { outDir: 'dist', sourcemap: true },
})
