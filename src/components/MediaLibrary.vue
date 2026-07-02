<script setup lang="ts">
import { ref, computed } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import type { Asset } from '../types/project'
import { toast } from '../composables/useToast'
import { useLocale } from '../composables/useLocale'

const locale = useLocale()
const { t } = locale

const searchQuery = ref('')
const currentFolder = ref<string | null>(null)

const store = useProjectStore()
const fileInputRef = ref<HTMLInputElement>()
const isDragging = ref(false)
const uploading = ref(false)

const assetList = computed<Asset[]>(() => {
  let list = Object.values(store.assets)
  if (currentFolder.value !== null) {
    list = list.filter(a => (a.folderId ?? null) === currentFolder.value)
  }
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    list = list.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.kind.toLowerCase().includes(q) ||
      (a.tags ?? []).some(t => t.toLowerCase().includes(q))
    )
  }
  return list.sort((a, b) => b.createdAt - a.createdAt)
})

const folders = computed(() => store.state.folders ?? [])

function addFolderPrompt() {
  const name = window.prompt(t('フォルダの名前', 'フォルダ名'))
  if (!name) return
  store.addFolder(name)
}
function deleteFolder(id: string) {
  if (!confirm(t(
    'このフォルダを削除しますか? (中の素材は残ります)',
    'このフォルダを削除しますか? (素材は残ります)'
  ))) return
  store.removeFolder(id)
  if (currentFolder.value === id) currentFolder.value = null
}
function renameFolderPrompt(id: string, cur: string) {
  const name = window.prompt(t('新しい名前', '新しい名前'), cur)
  if (name) store.renameFolder(id, name)
}

function onAssetDragOverFolder(e: DragEvent, folderId: string | null) {
  if (e.dataTransfer?.types.includes('application/x-lve-asset-id')) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
}
function onAssetDropOnFolder(e: DragEvent, folderId: string | null) {
  e.preventDefault()
  const assetId = e.dataTransfer?.getData('application/x-lve-asset-id')
  if (!assetId) return
  store.moveAssetToFolder(assetId, folderId)
}

function onPickClick() {
  fileInputRef.value?.click()
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files || files.length === 0) return
  await uploadFiles(Array.from(files))
  input.value = ''
}

async function uploadFiles(files: File[]) {
  uploading.value = true
  let ok = 0
  try {
    for (const f of files) {
      const a = await store.addAssetFromFile(f)
      if (a) ok++
    }
    if (ok > 0) toast.success(t(`${ok} 件のファイルを追加しました`, `${ok} 件の素材を追加しました`))
  } catch (e: any) {
    console.error(e)
    toast.error(t('ファイルを追加できませんでした: ', '素材の追加に失敗しました: ') + (e?.message ?? ''))
  } finally {
    uploading.value = false
  }
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  uploadFiles(Array.from(files))
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}
function onDragLeave() {
  isDragging.value = false
}

function onAssetDblClick(asset: Asset) {
  store.addClipFromAsset(asset.id)
}

function onAssetDragStart(e: DragEvent, asset: Asset) {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-lve-asset-id', asset.id)
  // dragover 中は getData が使えないため、種別を「タイプ名」として埋め込む。
  // タイムライン側はこれを見て、置けないトラックで no-drop カーソルを出す
  e.dataTransfer.setData(`application/x-lve-kind-${asset.kind}`, '1')
  e.dataTransfer.effectAllowed = 'copy'
}

async function onDelete(asset: Asset) {
  if (!confirm(t(
    `「${asset.name}」を削除しますか? 使っているクリップも消えます。`,
    `素材「${asset.name}」を削除します。この素材を使っているクリップも消えます。`
  ))) return
  await store.removeAsset(asset.id)
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatDuration(d?: number): string {
  if (d === undefined) return '—'
  const s = Math.floor(d)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function kindColor(kind: string): string {
  if (kind === 'video') return 'var(--video)'
  if (kind === 'audio') return 'var(--audio)'
  if (kind === 'image') return 'var(--image)'
  return 'var(--fg-2)'
}

function kindLabelJa(kind: string): string {
  if (kind === 'video') return t('動画', '動画')
  if (kind === 'audio') return t('音声', '音声')
  if (kind === 'image') return t('画像', '画像')
  return kind
}
</script>

<template>
  <div class="panel-title">
    <span>{{ t('素材', 'メディア') }}</span>
    <button class="ghost" @click="onPickClick">＋ {{ t('追加', '追加') }}</button>
  </div>

  <div class="search-wrap">
    <input
      class="search"
      type="search"
      :placeholder="t('検索...', '検索...')"
      v-model="searchQuery"
    />
  </div>

  <div class="folders">
    <div
      class="folder"
      :class="{ active: currentFolder === null }"
      @click="currentFolder = null"
      @dragover="(e) => onAssetDragOverFolder(e, null)"
      @drop="(e) => onAssetDropOnFolder(e, null)"
    >{{ t('全部', '全て') }}</div>
    <div
      v-for="f in folders"
      :key="f.id"
      class="folder"
      :class="{ active: currentFolder === f.id }"
      :style="{ borderLeftColor: f.color ?? 'var(--accent)' }"
      @click="currentFolder = f.id"
      @dblclick="renameFolderPrompt(f.id, f.name)"
      @contextmenu.prevent="deleteFolder(f.id)"
      @dragover="(e) => onAssetDragOverFolder(e, f.id)"
      @drop="(e) => onAssetDropOnFolder(e, f.id)"
    >{{ f.name }}</div>
    <button class="ghost tiny folder-add" @click="addFolderPrompt">＋</button>
  </div>

  <div
    class="drop-zone"
    :class="{ dragging: isDragging }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="assetList.length === 0" class="empty">
      <div class="empty-icon">⬒</div>
      <div class="empty-text">
        <template v-if="locale.isEasy.value">動画・画像・音声を<br />ここにドラッグして追加</template>
        <template v-else>動画・画像・音声ファイルを<br />ドラッグ&ドロップ</template>
      </div>
      <button class="ghost" @click="onPickClick">{{ t('ファイルを選ぶ', 'ファイルを選ぶ') }}</button>
    </div>

    <div v-else class="asset-list">
      <div
        v-for="asset in assetList"
        :key="asset.id"
        class="asset-card"
        draggable="true"
        @dragstart="(e) => onAssetDragStart(e, asset)"
        @dblclick="onAssetDblClick(asset)"
      >
        <div class="kind-dot" :style="{ background: kindColor(asset.kind) }" />
        <div class="asset-info">
          <div class="asset-name" :title="asset.name">{{ asset.name }}</div>
          <div class="asset-meta mono">
            <span>{{ kindLabelJa(asset.kind) }}</span>
            <span v-if="asset.duration">· {{ formatDuration(asset.duration) }}</span>
            <span v-if="asset.width">· {{ asset.width }}×{{ asset.height }}</span>
            <span>· {{ formatSize(asset.size) }}</span>
          </div>
        </div>
        <button class="ghost del" :title="t('削除', '削除')" @click.stop="onDelete(asset)">×</button>
      </div>
    </div>

    <div v-if="uploading" class="uploading">{{ t('読み込み中…', '読み込み中…') }}</div>
    <div v-if="isDragging" class="drop-overlay">
      <span>{{ t('ここにドロップ', 'ここにドロップ') }}</span>
    </div>
  </div>

  <input
    ref="fileInputRef"
    type="file"
    multiple
    accept="video/*,image/*,audio/*"
    style="display: none"
    @change="onFileChange"
  />
</template>

<style scoped>
.drop-zone {
  flex: 1;
  position: relative;
  overflow-y: auto;
  padding: 8px;
  min-height: 0;
}

.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--fg-2);
  padding: 40px 10px;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
}
.empty-icon {
  font-size: 32px;
  color: var(--line-strong);
}
.empty-text {
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}

.asset-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.asset-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  border: 1px solid transparent;
  cursor: grab;
  transition: background 120ms ease, border-color 120ms ease;
}
.asset-card:hover {
  background: var(--bg-3);
  border-color: var(--line);
}
.asset-card:active {
  cursor: grabbing;
}

.kind-dot {
  width: 4px;
  align-self: stretch;
  border-radius: 2px;
  flex-shrink: 0;
}

.asset-info {
  flex: 1;
  min-width: 0;
}
.asset-name {
  font-size: 12px;
  color: var(--fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.asset-meta {
  font-size: 10px;
  color: var(--fg-2);
  display: flex;
  gap: 4px;
  margin-top: 2px;
}

.del {
  padding: 2px 6px;
  font-size: 14px;
  color: var(--fg-2);
}
.del:hover {
  color: var(--danger);
}

.drop-overlay {
  position: absolute;
  inset: 0;
  border: 2px dashed var(--accent);
  background: rgba(232, 168, 56, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius);
  pointer-events: none;
  color: var(--accent);
  font-size: 13px;
}

.uploading {
  text-align: center;
  color: var(--fg-2);
  font-size: 11px;
  padding: 8px;
}

.search-wrap {
  padding: 4px 8px 6px;
  border-bottom: 1px solid var(--line-weak);
}
.search {
  width: 100%;
  font-size: 11px;
  padding: 4px 8px;
}

.folders {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line-weak);
}
.folder {
  padding: 3px 8px;
  font-size: 10px;
  background: var(--bg-2);
  border: 1px solid var(--line-weak);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  user-select: none;
}
.folder.active {
  border-color: var(--accent);
  background: var(--bg-3);
  color: var(--fg-0);
}
.folder-add {
  padding: 2px 6px;
  font-size: 10px;
}
</style>
