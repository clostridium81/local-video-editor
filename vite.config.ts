import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    // 完全ローカル動作。開発サーバーだけ。
    port: 5173
  },
  build: {
    target: 'es2022',
    sourcemap: true
  }
})
