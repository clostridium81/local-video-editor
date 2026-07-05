<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import MediaLibrary from './components/MediaLibrary.vue'
import PreviewPanel from './components/PreviewPanel.vue'
import InspectorPanel from './components/InspectorPanel.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import Toast from './components/Toast.vue'
import TutorialOverlay from './components/TutorialOverlay.vue'
import BackupReminderDialog from './components/BackupReminderDialog.vue'
import { useKeyboard } from './composables/useKeyboard'
import { useTutorial } from './composables/useTutorial'
import { useLayout } from './composables/useLayout'
import { useLocale } from './composables/useLocale'
import { useStorage } from './composables/useStorage'
import { useProjectStore } from './stores/projectStore'
import { computed, onMounted, onBeforeUnmount } from 'vue'

useKeyboard()
const tutorial = useTutorial()
const { t } = useLocale()
const store = useProjectStore()
const storage = useStorage()

const {
  leftWidth,
  rightWidth,
  timelineHeight,
  setLeftWidth,
  setRightWidth,
  setTimelineHeight,
  reset
} = useLayout()

const gridCols = computed(
  () => `${leftWidth.value}px 5px 1fr 5px ${rightWidth.value}px`
)

// ---------- エリア境界のドラッグリサイズ ----------

type ResizeKind = 'left' | 'right' | 'timeline'

function startResize(e: MouseEvent, kind: ResizeKind) {
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  const orig =
    kind === 'left'
      ? leftWidth.value
      : kind === 'right'
        ? rightWidth.value
        : timelineHeight.value
  document.body.style.cursor = kind === 'timeline' ? 'row-resize' : 'col-resize'
  document.body.style.userSelect = 'none'
  const onMove = (ev: MouseEvent) => {
    if (kind === 'left') {
      setLeftWidth(orig + (ev.clientX - startX))
    } else if (kind === 'right') {
      // 右パネルは左へドラッグすると広がる
      setRightWidth(orig - (ev.clientX - startX))
    } else {
      // タイムラインは上へドラッグすると広がる
      setTimelineHeight(orig - (ev.clientY - startY))
    }
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ---------- タブを閉じる際の未バックアップ警告 ----------
// 最後の ZIP バックアップ以降に編集があれば、ブラウザ標準の離脱確認を出す。
// (メッセージ文言は現代ブラウザでは固定で、カスタム文字列は表示されない)
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (store.hasUnbackedUpChanges()) {
    e.preventDefault()
    e.returnValue = ''
  }
}

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  // ストレージを永続化 (退避されにくくする) + 残量を取得
  storage.requestPersist()
  storage.refreshEstimate()
  // 初回アクセス時に自動表示 (少し遅らせてレイアウト確定後)
  setTimeout(() => tutorial.openIfFirstVisit(), 400)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <div class="app-root">
    <TopBar />
    <div class="main" :style="{ gridTemplateColumns: gridCols }">
      <aside class="left" data-tour="media-library">
        <MediaLibrary />
      </aside>
      <div
        class="resizer resizer-v"
        :title="t('ドラッグで幅を調整 / ダブルクリックで元に戻す', 'ドラッグで幅を調整 / ダブルクリックでリセット')"
        @mousedown="(e) => startResize(e, 'left')"
        @dblclick="reset('leftWidth')"
      />
      <section class="center">
        <div data-tour="preview" class="preview-wrap">
          <PreviewPanel />
        </div>
        <div
          class="resizer resizer-h"
          :title="t('ドラッグで高さを調整 / ダブルクリックで元に戻す', 'ドラッグで高さを調整 / ダブルクリックでリセット')"
          @mousedown="(e) => startResize(e, 'timeline')"
          @dblclick="reset('timelineHeight')"
        />
        <TimelinePanel :style="{ height: timelineHeight + 'px' }" />
      </section>
      <div
        class="resizer resizer-v"
        :title="t('ドラッグで幅を調整 / ダブルクリックで元に戻す', 'ドラッグで幅を調整 / ダブルクリックでリセット')"
        @mousedown="(e) => startResize(e, 'right')"
        @dblclick="reset('rightWidth')"
      />
      <aside class="right" data-tour="inspector">
        <InspectorPanel />
      </aside>
    </div>
    <Toast />
    <TutorialOverlay v-if="tutorial.showing.value" />
    <BackupReminderDialog
      v-if="store.shouldPromptBackup"
      @close="store.dismissBackupPrompt()"
    />
  </div>
</template>

<style scoped>
.app-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-0);
}

.main {
  flex: 1;
  display: grid;
  grid-template-columns: 260px 5px 1fr 5px 300px;
  min-height: 0;
}

.left {
  border-right: 1px solid var(--line-region);
  background: var(--bg-1);
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.center {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.preview-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.right {
  border-left: 1px solid var(--line-region);
  background: var(--bg-1);
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ---------- エリア境界リサイザー ---------- */
.resizer {
  background: var(--bg-1);
  transition: background 120ms ease;
  z-index: 5;
}
.resizer:hover,
.resizer:active {
  background: var(--accent-dim);
}
.resizer-v {
  cursor: col-resize;
}
.resizer-h {
  height: 5px;
  flex-shrink: 0;
  cursor: row-resize;
}
</style>
