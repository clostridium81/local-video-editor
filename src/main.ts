import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/global.css'
import { cleanupLegacyStorage } from './persistence/legacyCleanup'
import { toast } from './composables/useToast'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

app.mount('#app')

let cleanupNotice: string | undefined
cleanupLegacyStorage(status => {
  if (cleanupNotice) toast.dismiss(cleanupNotice)
  cleanupNotice = undefined
  if (status === 'blocked') {
    cleanupNotice = toast.warn('旧版で保存した素材の削除が保留されています。このアプリの古いタブを閉じてください。', 0)
  } else if (status === 'failed' || status === 'unavailable') {
    cleanupNotice = toast.warn('旧版で保存した素材を削除できませんでした。旧版を使ったことがある場合は、ブラウザのサイトデータ設定で削除してください。', 0)
  }
})
