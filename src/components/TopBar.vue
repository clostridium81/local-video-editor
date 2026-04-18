<script setup lang="ts">
import { ref } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { exportBackup, importBackup } from '../persistence/backup'
import { clearProject, deleteProjectState } from '../persistence/assetStore'
import { toast } from '../composables/useToast'
import { hasWebCodecs } from '../engine/capabilities'
import ExportDialog from './ExportDialog.vue'
import AudioMixer from './AudioMixer.vue'
import RecorderDialog from './RecorderDialog.vue'
import ProjectsDialog from './ProjectsDialog.vue'
import ShortcutHelp from './ShortcutHelp.vue'

const store = useProjectStore()
const fileInputRef = ref<HTMLInputElement>()
const saving = ref(false)
const showExport = ref(false)
const showMixer = ref(false)
const showRecorder = ref(false)
const showProjects = ref(false)
const showHelp = ref(false)

async function onSave() {
  saving.value = true
  try {
    await exportBackup(store.serialize())
    toast.success('バックアップを保存しました')
  } catch (e: any) {
    console.error(e)
    toast.error('バックアップの保存に失敗しました: ' + (e?.message ?? ''))
  } finally {
    saving.value = false
  }
}

function onRestoreClick() {
  fileInputRef.value?.click()
}

async function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''
  try {
    if (!confirm('現在のプロジェクトを破棄してバックアップから復元します。よろしいですか？')) return
    store.suspendAutosave()
    await clearProject(store.meta.id)
    const { project, assetCount } = await importBackup(file)
    store.replaceState(project)
    toast.success(`復元しました (素材 ${assetCount} 件)`)
  } catch (err: any) {
    console.error(err)
    toast.error('復元に失敗しました: ' + (err?.message ?? ''))
  } finally {
    store.resumeAutosave()
  }
}

async function onNew() {
  if (!confirm('新規プロジェクトを開きます。現在の内容は破棄されます。')) return
  store.suspendAutosave()
  const oldId = store.meta.id
  await clearProject(oldId)
  await deleteProjectState(oldId).catch(() => void 0)
  store.resetToEmpty()
  store.resumeAutosave()
  toast.info('新しいプロジェクトを作成しました')
}

function onExport() {
  if (!hasWebCodecs) {
    toast.warn('このブラウザはエクスポート(WebCodecs)に対応していません')
    return
  }
  showExport.value = true
}
</script>

<template>
  <div class="topbar">
    <div class="brand">
      <span class="logo-mark">◐</span>
      <span class="logo-text serif">Local Video Editor</span>
    </div>

    <div class="project-name">
      <input
        class="name-input"
        :value="store.meta.name"
        @change="(e) => store.renameProject((e.target as HTMLInputElement).value)"
      />
    </div>

    <div class="actions">
      <button
        class="ghost icon-btn"
        :disabled="!store.canUndo"
        :title="'元に戻す (Cmd/Ctrl+Z)'"
        @click="store.undo()"
      >↶</button>
      <button
        class="ghost icon-btn"
        :disabled="!store.canRedo"
        :title="'やり直し (Cmd/Ctrl+Shift+Z)'"
        @click="store.redo()"
      >↷</button>
      <div class="sep" />
      <button class="ghost" @click="onNew">新規</button>
      <button class="ghost" @click="onRestoreClick">復元</button>
      <button class="ghost" :disabled="saving" @click="onSave">
        {{ saving ? '保存中…' : 'バックアップ' }}
      </button>
      <button class="ghost icon-btn" title="プロジェクト管理" @click="showProjects = true">📂</button>
      <button class="ghost icon-btn" title="録音・録画" @click="showRecorder = true">🎙</button>
      <button class="ghost icon-btn" title="オーディオミキサー" @click="showMixer = !showMixer" :class="{ active: showMixer }">🎚</button>
      <button class="ghost icon-btn" title="キーボードショートカット" @click="showHelp = true">?</button>
      <button
        class="primary"
        :disabled="!hasWebCodecs"
        :title="hasWebCodecs ? 'エクスポート' : 'このブラウザは WebCodecs 未対応'"
        @click="onExport"
      >▼ エクスポート</button>
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
  <ProjectsDialog v-if="showProjects" @close="showProjects = false" />
  <ShortcutHelp v-if="showHelp" @close="showHelp = false" />
</template>

<style scoped>
.topbar {
  height: 48px;
  border-bottom: 1px solid var(--line);
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
.sep {
  width: 1px;
  height: 20px;
  background: var(--line);
  margin: 0 4px;
}
</style>
