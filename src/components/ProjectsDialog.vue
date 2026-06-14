<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { useLocale } from '../composables/useLocale'

const { t } = useLocale()
import {
  listStoredProjects,
  deleteProjectState,
  clearProject,
  loadProjectState,
  saveProjectState,
  loadAssetBlob,
  saveAssetBlob,
  listProjectAssets
} from '../persistence/assetStore'
import { toast } from '../composables/useToast'
import { nanoid } from 'nanoid'

const emit = defineEmits<{ close: [] }>()
const store = useProjectStore()

const projects = ref<Array<{ id: string; name: string; updatedAt: number }>>([])
const busy = ref(false)

async function refresh() {
  projects.value = await listStoredProjects()
}
onMounted(refresh)

async function openProject(id: string) {
  if (busy.value) return
  if (id === store.meta.id) {
    emit('close')
    return
  }
  busy.value = true
  try {
    await saveProjectState(store.serialize())
    const next = await loadProjectState(id)
    if (!next) {
      toast.error('さくひんを ひらけなかったよ')
      return
    }
    // 再読込時に loadLatestProjectState がこのプロジェクトを選ぶよう
    // updatedAt を進めて即保存する
    next.meta.updatedAt = Date.now()
    store.suspendAutosave()
    store.replaceState(next)
    store.resumeAutosave()
    await saveProjectState(store.serialize())
    toast.success(`さくひんを きりかえたよ: ${next.meta.name}`)
    emit('close')
  } finally {
    busy.value = false
  }
}

async function duplicateProject(id: string) {
  if (busy.value) return
  busy.value = true
  try {
    const src = await loadProjectState(id)
    if (!src) {
      toast.error('もとの さくひんを ひらけなかったよ')
      return
    }
    const newId = nanoid()
    const copy = JSON.parse(JSON.stringify(src))
    copy.meta.id = newId
    copy.meta.name = `${src.meta.name} (コピー)`
    copy.meta.createdAt = Date.now()
    copy.meta.updatedAt = Date.now()
    const assetIds = await listProjectAssets(id)
    for (const aid of assetIds) {
      const blob = await loadAssetBlob(id, aid)
      if (blob) await saveAssetBlob(newId, aid, blob)
    }
    await saveProjectState(copy)
    toast.success(`コピーを つくったよ: ${copy.meta.name}`)
    refresh()
  } catch (err: any) {
    toast.error('コピーに しっぱいしたよ: ' + (err?.message ?? ''))
  } finally {
    busy.value = false
  }
}

async function deleteProject(id: string) {
  if (id === store.meta.id) {
    toast.warn('いま つかっている さくひんは けせないよ')
    return
  }
  if (!confirm('この さくひんを ぜんぶ けしてもいい? (なかみも きえるよ)')) return
  busy.value = true
  try {
    await clearProject(id)
    await deleteProjectState(id)
    toast.success('けしたよ')
    refresh()
  } finally {
    busy.value = false
  }
}

async function newProject() {
  if (!confirm('あたらしい さくひんを はじめる? (いまの さくひんは ほぞんされるよ)')) return
  busy.value = true
  try {
    await saveProjectState(store.serialize())
    store.suspendAutosave()
    store.resetToEmpty()
    store.resumeAutosave()
    toast.info('あたらしい さくひんを はじめたよ')
    emit('close')
  } finally {
    busy.value = false
  }
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString()
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <div class="title">{{ t('さくひんの きりかえ', 'プロジェクト管理') }}</div>
        <button class="ghost close" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <div class="toolbar">
          <button class="primary" @click="newProject">＋ {{ t('あたらしい さくひん', '新規プロジェクト') }}</button>
          <div class="spacer" />
        </div>
        <div class="list">
          <div v-if="projects.length === 0" class="empty muted">{{ t('さくひんが まだ ないよ', 'プロジェクトが見つかりません') }}</div>
          <div
            v-for="p in projects"
            :key="p.id"
            class="item"
            :class="{ current: p.id === store.meta.id }"
          >
            <div class="info">
              <div class="name">{{ p.name }}</div>
              <div class="meta mono muted">{{ fmtDate(p.updatedAt) }} · {{ p.id.slice(0, 6) }}</div>
            </div>
            <div class="buttons">
              <button
                v-if="p.id !== store.meta.id"
                class="ghost tiny"
                :disabled="busy"
                @click="openProject(p.id)"
              >{{ t('ひらく', '開く') }}</button>
              <span v-else class="badge">{{ t('いま つかってる', '使用中') }}</span>
              <button class="ghost tiny" :disabled="busy" @click="duplicateProject(p.id)">{{ t('コピー', '複製') }}</button>
              <button class="ghost tiny danger" :disabled="busy || p.id === store.meta.id" @click="deleteProject(p.id)">{{ t('けす', '削除') }}</button>
            </div>
          </div>
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
  z-index: 9300;
}
.modal {
  width: 600px;
  max-width: 92vw;
  max-height: 80vh;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line-weak);
}
.title { font-size: 14px; font-weight: 600; }
.close { background: none; border: none; font-size: 18px; cursor: pointer; color: var(--fg-2); }
.modal-body {
  flex: 1;
  padding: 12px 18px 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.spacer { flex: 1; }
.list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}
.empty {
  padding: 20px;
  text-align: center;
  font-size: 12px;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.item.current {
  border-color: var(--accent-dim);
  background: linear-gradient(90deg, rgba(232, 168, 56, 0.05), var(--bg-2));
}
.info { flex: 1; min-width: 0; }
.name { font-size: 13px; color: var(--fg-0); }
.meta { font-size: 10px; margin-top: 2px; }
.buttons {
  display: flex;
  gap: 4px;
  align-items: center;
}
button.tiny { padding: 3px 8px; font-size: 11px; }
button.danger { color: var(--danger); }
.badge {
  font-size: 10px;
  color: var(--accent-hi);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 6px;
  border: 1px solid var(--accent-dim);
  border-radius: var(--radius-sm);
}
</style>
