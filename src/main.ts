import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/global.css'
import { useProjectStore } from './stores/projectStore'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// 起動時に IndexedDB から最新プロジェクト復元を試行 → マウント
;(async () => {
  const store = useProjectStore(pinia)
  store.suspendAutosave()
  try {
    await store.bootstrap()
  } catch (err) {
    console.warn('bootstrap error', err)
  } finally {
    store.resumeAutosave()
  }
  app.mount('#app')
})()
