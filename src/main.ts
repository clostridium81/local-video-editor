import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/global.css'
import { clearAllData } from './persistence/assetStore'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

// 自動保存・自動復元は廃止。データの保存/復元は手動バックアップ (ZIP) のみ。
// 起動時は常に空プロジェクトから始め、前セッションの IndexedDB 残骸を掃除する。
// (掃除に失敗してもマウントは続行する)
;(async () => {
  try {
    await clearAllData()
  } catch (err) {
    console.warn('storage cleanup failed', err)
  }
  app.mount('#app')
})()
