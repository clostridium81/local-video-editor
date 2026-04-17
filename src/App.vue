<script setup lang="ts">
import TopBar from './components/TopBar.vue'
import MediaLibrary from './components/MediaLibrary.vue'
import PreviewPanel from './components/PreviewPanel.vue'
import InspectorPanel from './components/InspectorPanel.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import Toast from './components/Toast.vue'
import { useKeyboard } from './composables/useKeyboard'

useKeyboard()
</script>

<template>
  <div class="app-root">
    <TopBar />
    <div class="main">
      <aside class="left">
        <MediaLibrary />
      </aside>
      <section class="center">
        <PreviewPanel />
        <TimelinePanel />
      </section>
      <aside class="right">
        <InspectorPanel />
      </aside>
    </div>
    <Toast />
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

.right {
  border-left: 1px solid var(--line-weak);
  background: var(--bg-1);
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
