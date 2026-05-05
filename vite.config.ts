import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// package.json のバージョンを定数として注入する。
// アプリ内で `__APP_VERSION__` として参照できる (型は src/types/global.d.ts)。
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')
) as { version: string }

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  server: {
    // 完全ローカル動作。開発サーバーだけ。
    port: 5173
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
})
