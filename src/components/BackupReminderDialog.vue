<script setup lang="ts">
import { ref } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { exportBackup } from '../persistence/backup'
import { toast } from '../composables/useToast'
import { useLocale } from '../composables/useLocale'

const { t } = useLocale()
const store = useProjectStore()
const emit = defineEmits<{ close: [] }>()

const saving = ref(false)

async function onBackup() {
  if (saving.value) return
  saving.value = true
  try {
    // TopBar のバックアップと同じ: ダウンロードした内容の署名を記録する
    const snapshot = store.serialize()
    await exportBackup(snapshot)
    // markBackedUp が shouldPromptBackup を false にするのでダイアログは自動で閉じる
    store.markBackedUp(snapshot)
    toast.success(t('バックアップを保存しました', 'バックアップを保存しました'))
    emit('close')
  } catch (e: any) {
    console.error(e)
    toast.error(
      t('バックアップの保存に失敗しました: ', 'バックアップの保存に失敗しました: ') +
        (e?.message ?? '')
    )
  } finally {
    saving.value = false
  }
}

function onLater() {
  emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="onLater">
    <div class="modal">
      <div class="modal-head">
        <div class="title">💾 {{ t('バックアップの おすすめ', 'バックアップのおすすめ') }}</div>
      </div>
      <div class="modal-body">
        <p class="lead">
          {{ t(
            `${store.editsSinceBackup} かい へんしゅうしました。まだ バックアップしていない ぶんが あります。`,
            `前回のバックアップから ${store.editsSinceBackup} 回編集しました。`
          ) }}
        </p>
        <p class="desc">
          {{ t(
            'このアプリは じどうで ほぞんしません。だいじな さくひんは、こまめに バックアップしてね。',
            'このアプリは自動保存を行いません。大切な作品はこまめにバックアップしてください。'
          ) }}
        </p>

        <div class="note">
          <div class="note-title">{{ t('ふるい バックアップの おかたづけ', '不要なバックアップの整理') }}</div>
          <p>
            {{ t(
              'バックアップは パソコンの「ダウンロード」フォルダに .zip ファイルとして たまっていきます。いらなく なった ふるい ファイルは、そこから てで けしてください。',
              'バックアップは PC の「ダウンロード」フォルダに .lvebackup.zip として保存され、溜まっていきます。不要になった古いファイルは、そこから手動で削除してください。'
            ) }}
          </p>
          <p class="note-sub muted">
            {{ t(
              '(あんぜんの ため、このアプリから パソコンの ファイルを けすことは できません)',
              '(安全のため、このアプリから PC 上のファイルを削除することはできません)'
            ) }}
          </p>
        </div>

        <div class="actions">
          <button class="ghost" :disabled="saving" @click="onLater">
            {{ t('あとで', '後で') }}
          </button>
          <button class="primary" :disabled="saving" @click="onBackup">
            {{ saving ? t('ほぞん ちゅう…', '保存中…') : t('いま バックアップする', '今すぐバックアップ') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  z-index: 9550;
}
.modal {
  width: 440px;
  max-width: 92vw;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}
.modal-head {
  padding: 14px 18px;
  border-bottom: 1px solid var(--line-weak);
}
.title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.03em;
}
.modal-body {
  padding: 16px 18px 18px;
}
.lead {
  font-size: 13px;
  color: var(--fg-0);
  margin-bottom: 6px;
  line-height: 1.6;
}
.desc {
  font-size: 12px;
  color: var(--fg-1);
  line-height: 1.7;
  margin-bottom: 14px;
}
.note {
  background: var(--bg-2);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 16px;
}
.note-title {
  font-size: 11px;
  color: var(--fg-1);
  font-weight: 600;
  margin-bottom: 5px;
}
.note p {
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.7;
}
.note-sub {
  margin-top: 5px;
  font-size: 10px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
