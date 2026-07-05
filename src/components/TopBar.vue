<script setup lang="ts">
import { ref } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { exportBackup, importBackup } from '../persistence/backup'
import { toast } from '../composables/useToast'
import { hasWebCodecs } from '../engine/capabilities'
import ExportDialog from './ExportDialog.vue'
import AudioMixer from './AudioMixer.vue'
import RecorderDialog from './RecorderDialog.vue'
import ShortcutHelp from './ShortcutHelp.vue'
import { useTutorial } from '../composables/useTutorial'
import { useLocale } from '../composables/useLocale'

const tutorial = useTutorial()
const locale = useLocale()
const { t } = locale

const appVersion = __APP_VERSION__

function onToggleLocale() {
  locale.toggle()
  toast.info(
    locale.isEasy.value
      ? 'やさしい日本語に切り替えました'
      : 'ふつうの日本語に切替えました'
  )
}

const store = useProjectStore()
const fileInputRef = ref<HTMLInputElement>()
const saving = ref(false)
const showExport = ref(false)
const showMixer = ref(false)
const showRecorder = ref(false)
const showHelp = ref(false)

async function onSave() {
  saving.value = true
  try {
    // ダウンロードした内容と一致する署名を記録するため、同じスナップショットを使う
    const snapshot = store.serialize()
    await exportBackup(snapshot)
    store.markBackedUp(snapshot)
    toast.success(t('バックアップを保存しました', 'バックアップを保存しました'))
  } catch (e: any) {
    console.error(e)
    toast.error(t('バックアップの保存に失敗しました: ', 'バックアップの保存に失敗しました: ') + (e?.message ?? ''))
  } finally {
    saving.value = false
  }
}

function onRestoreClick() {
  fileInputRef.value?.click()
}

/** 現プロジェクトが実質空か (未編集で捨てても失うものがない状態) */
function isCurrentProjectEmpty(): boolean {
  const s = store.state
  return (
    s.clips.length === 0 &&
    Object.keys(s.assets).length === 0 &&
    (s.markers?.length ?? 0) === 0
  )
}

async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  try {
    // 現プロジェクトが空なら破棄しても失うものがないので確認を省く
    if (!isCurrentProjectEmpty() && !confirm(t(
      '今の作品を閉じて、バックアップから復元します。今の内容は消えます (バックアップしていない場合は戻せません)。よろしいですか?',
      '現在のプロジェクトを破棄してバックアップから復元します (未バックアップなら復元不可)。よろしいですか？'
    ))) return
    // importBackup が素材を IndexedDB に書き戻す (プレビュー/エクスポート用)。
    // プロジェクト状態はメモリ上の store に反映するだけで、自動保存はしない。
    const { project, assetCount } = await importBackup(file)
    store.replaceState(project)
    // 復元した内容 = 読み込んだバックアップファイルそのものなので「バックアップ済み」
    store.markBackedUp()
    toast.success(t(`復元しました (素材 ${assetCount} 件)`, `復元しました (素材 ${assetCount} 件)`))
  } catch (err: any) {
    console.error(err)
    toast.error(t('復元に失敗しました: ', '復元に失敗しました: ') + (err?.message ?? ''))
  }
}

async function onNew() {
  // 自動保存はないので、未バックアップの内容は失われる旨を明示して確認する
  if (!isCurrentProjectEmpty() && !confirm(t(
    '新しい作品を始めます。今の内容は消えます (バックアップしていない場合は戻せません)。よろしいですか?',
    '新規プロジェクトを作成します。現在の内容は破棄されます (未バックアップなら復元不可)。よろしいですか？'
  ))) return
  store.resetToEmpty()
  toast.info(t('新しい作品を作成しました', '新規プロジェクトを作成しました'))
}

function onExport() {
  if (!hasWebCodecs) {
    toast.warn(t(
      'このブラウザでは動画ファイルを作成できません',
      'このブラウザはエクスポート (WebCodecs) に対応していません'
    ))
    return
  }
  showExport.value = true
}
</script>

<template>
  <div class="topbar">
    <div class="brand">
      <span class="logo-mark">◐</span>
      <span class="logo-text serif">{{ t('動画メーカー', 'Local Video Editor') }}</span>
      <span class="version mono" :title="t('バージョン', 'Version')">v{{ appVersion }}</span>
    </div>

    <div class="project-name">
      <input
        class="name-input"
        :value="store.meta.name"
        @change="(e) => store.renameProject((e.target as HTMLInputElement).value)"
      />
    </div>

    <div class="actions" data-tour="topbar-actions">
      <button
        class="ghost icon-btn"
        :disabled="!store.canUndo"
        :title="t('元に戻す', '元に戻す (Cmd/Ctrl+Z)')"
        @click="store.undo()"
      >↶</button>
      <button
        class="ghost icon-btn"
        :disabled="!store.canRedo"
        :title="t('やり直し', 'やり直し (Cmd/Ctrl+Shift+Z)')"
        @click="store.redo()"
      >↷</button>
      <div class="sep" />
      <button class="ghost" @click="onNew">{{ t('新規', '新規') }}</button>
      <button class="ghost" @click="onRestoreClick">{{ t('復元', '復元') }}</button>
      <button
        class="ghost backup-btn"
        :class="{ dirty: store.isDirtySinceBackup }"
        :disabled="saving"
        :title="store.isDirtySinceBackup
          ? t('まだバックアップしていない変更があります', '未バックアップの変更があります')
          : t('プロジェクトをまるごと保存', 'プロジェクト全体をバックアップ')"
        @click="onSave"
      >
        <span v-if="store.isDirtySinceBackup" class="dirty-dot" />
        {{ saving ? t('保存中…', '保存中…') : t('バックアップ', 'バックアップ') }}
      </button>
      <button class="ghost icon-btn" :title="t('録音・録画', '録音・録画')" @click="showRecorder = true">🎙</button>
      <button class="ghost icon-btn" :title="t('音声ミキサー', 'オーディオミキサー')" @click="showMixer = !showMixer" :class="{ active: showMixer }">🎚</button>
      <button
        class="ghost icon-btn"
        :title="t('使い方を見る', '使い方ツアー')"
        @click="tutorial.open()"
      >🎓</button>
      <button
        class="ghost icon-btn"
        data-tour="help-btn"
        :title="t('キーボードショートカット', 'キーボードショートカット')"
        @click="showHelp = true"
      >?</button>
      <button
        class="ghost icon-btn"
        :class="{ active: locale.isEasy.value }"
        :title="locale.isEasy.value
          ? 'やさしい日本語 (押すと通常の日本語に切り替え)'
          : 'ふつうの日本語 (押すとやさしい日本語に切り替え)'"
        @click="onToggleLocale"
      >{{ locale.isEasy.value ? 'あ' : '漢' }}</button>
      <button
        class="primary"
        :disabled="!hasWebCodecs"
        :title="hasWebCodecs
          ? t('動画ファイルにする', '動画書き出し')
          : t('このブラウザでは使えません', 'このブラウザは WebCodecs 未対応')"
        @click="onExport"
      >▼ {{ t('動画を書き出す', '動画書き出し') }}</button>
      <input
        ref="fileInputRef"
        type="file"
        accept=".zip,application/zip"
        style="display: none"
        @change="onFileChosen"
      />
    </div>
  </div>

  <ExportDialog v-if="showExport" @close="showExport = false" />
  <AudioMixer v-if="showMixer" @close="showMixer = false" />
  <RecorderDialog v-if="showRecorder" @close="showRecorder = false" />
  <ShortcutHelp v-if="showHelp" @close="showHelp = false" />
</template>

<style scoped>
.topbar {
  height: 48px;
  border-bottom: 1px solid var(--line-region);
  background: var(--bg-1);
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 16px;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.logo-mark {
  color: var(--accent);
  font-size: 20px;
  line-height: 1;
}

.logo-text {
  font-size: 17px;
  font-style: italic;
  color: var(--fg-0);
  letter-spacing: 0.01em;
}

.version {
  font-size: 10px;
  color: var(--fg-3);
  letter-spacing: 0.04em;
  padding: 2px 5px;
  border: 1px solid var(--line-weak);
  border-radius: 3px;
  align-self: center;
  user-select: none;
}

.project-name {
  flex: 1;
  display: flex;
  justify-content: center;
}

.name-input {
  width: 320px;
  text-align: center;
  background: transparent;
  border-color: transparent;
  font-size: 13px;
}
.name-input:hover, .name-input:focus {
  border-color: var(--line);
  background: var(--bg-2);
}

.actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.icon-btn {
  font-size: 14px;
  min-width: 28px;
  padding: 4px 6px;
}
.icon-btn.active {
  color: var(--accent-hi);
  background: rgba(232, 168, 56, 0.12);
  border-color: var(--accent-dim);
}
.sep {
  width: 1px;
  height: 20px;
  background: var(--line);
  margin: 0 4px;
}

/* 未バックアップの変更があるときのバックアップボタン強調 */
.backup-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.backup-btn.dirty {
  color: var(--accent-hi);
  border-color: var(--accent);
  background: rgba(232, 168, 56, 0.12);
}
.backup-btn.dirty:hover {
  background: rgba(232, 168, 56, 0.2);
}
.dirty-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  box-shadow: 0 0 5px rgba(232, 168, 56, 0.7);
  animation: dirty-pulse 2s ease-in-out infinite;
}
@keyframes dirty-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
</style>
