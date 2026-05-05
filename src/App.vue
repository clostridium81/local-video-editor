<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import MediaLibrary from './components/MediaLibrary.vue'
import PreviewPanel from './components/PreviewPanel.vue'
import InspectorPanel from './components/InspectorPanel.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import Toast from './components/Toast.vue'
import TutorialOverlay from './components/TutorialOverlay.vue'
import { useKeyboard } from './composables/useKeyboard'
import { useTutorial } from './composables/useTutorial'
import { onMounted } from 'vue'

useKeyboard()
const tutorial = useTutorial()

onMounted(() => {
  // 初回アクセス時に自動表示 (少し遅らせてレイアウト確定後)
  setTimeout(() => tutorial.openIfFirstVisit(), 400)
})
</script>

<template>
  <div class="app-root">
    <TopBar />
    <div class="main">
      <aside class="left" data-tour="media-library">
        <MediaLibrary />
      </aside>
      <section class="center">
        <div data-tour="preview" class="preview-wrap">
          <PreviewPanel />
        </div>
        <TimelinePanel />
      </section>
      <aside class="right" data-tour="inspector">
        <InspectorPanel />
      </aside>
    </div>
    <Toast />
    <TutorialOverlay v-if="tutorial.showing.value" />
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
  grid-template-columns: 260px 1fr 300px;
  min-height: 0;
}

.left {
  border-right: 1px solid var(--line-weak);
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
  border-left: 1px solid var(--line-weak);
  background: var(--bg-1);
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
