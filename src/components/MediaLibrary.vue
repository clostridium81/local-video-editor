<script setup lang="ts">
import { ref, computed } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import type { Asset } from '../types/project'
import { toast } from '../composables/useToast'

const store = useProjectStore()
const fileInputRef = ref<HTMLInputElement>()
const isDragging = ref(false)
const uploading = ref(false)

const assetList = computed<Asset[]>(() =>
  Object.values(store.assets).sort((a, b) => b.createdAt - a.createdAt)
)

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
    if (ok > 0) toast.success(`${ok} 件の素材を追加しました`)
  } catch (e: any) {
    console.error(e)
    toast.error('素材の追加に失敗しました: ' + (e?.message ?? ''))
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
  e.dataTransfer.effectAllowed = 'copy'
}

async function onDelete(asset: Asset) {
  if (!confirm(`素材「${asset.name}」を削除します。この素材を使っているクリップも消えます。`)) return
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
</script>

<template>
  <div class="panel-title">
    <span>Media Library</span>
    <button class="ghost" @click="onPickClick">＋ 追加</button>
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
        動画・画像・音声ファイルを<br />ドラッグ&ドロップ
      </div>
      <button class="ghost" @click="onPickClick">ファイルを選ぶ</button>
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
            <span>{{ asset.kind }}</span>
            <span v-if="asset.duration">· {{ formatDuration(asset.duration) }}</span>
            <span v-if="asset.width">· {{ asset.width }}×{{ asset.height }}</span>
            <span>· {{ formatSize(asset.size) }}</span>
          </div>
        </div>
        <button class="ghost del" title="削除" @click.stop="onDelete(asset)">×</button>
      </div>
    </div>

    <div v-if="uploading" class="uploading">読み込み中…</div>
    <div v-if="isDragging" class="drop-overlay">
      <span>ここにドロップ</span>
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
</style>
