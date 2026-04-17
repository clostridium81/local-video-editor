<script setup lang="ts">
import { useToast } from '../composables/useToast'

const t = useToast()

function levelIcon(level: string) {
  if (level === 'success') return '✓'
  if (level === 'warn') return '!'
  if (level === 'error') return '×'
  return 'i'
}
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <transition-group name="toast">
      <div
        v-for="toast in t.toasts.value"
        :key="toast.id"
        class="toast"
        :class="'lv-' + toast.level"
        role="status"
        @click="t.dismiss(toast.id)"
      >
        <div class="icon">{{ levelIcon(toast.level) }}</div>
        <div class="msg">{{ toast.message }}</div>
        <button class="close" @click.stop="t.dismiss(toast.id)">×</button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 9999;
  max-width: 420px;
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: var(--radius);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  font-size: 12px;
  color: var(--fg-0);
  min-width: 240px;
  pointer-events: auto;
  cursor: pointer;
}
.toast.lv-info { border-left-color: var(--video); }
.toast.lv-success { border-left-color: var(--audio); }
.toast.lv-warn { border-left-color: var(--accent); }
.toast.lv-error { border-left-color: var(--danger); }
.icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  color: #0a0b0d;
  background: var(--fg-1);
  flex-shrink: 0;
  margin-top: 1px;
}
.toast.lv-info .icon { background: var(--video); }
.toast.lv-success .icon { background: var(--audio); }
.toast.lv-warn .icon { background: var(--accent); }
.toast.lv-error .icon { background: var(--danger); color: #fff; }
.msg {
  flex: 1;
  line-height: 1.4;
  word-break: break-word;
}
.close {
  background: none;
  border: none;
  color: var(--fg-2);
  cursor: pointer;
  padding: 0 4px;
  font-size: 14px;
  line-height: 1;
}
.close:hover { color: var(--fg-0); }

.toast-enter-from, .toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
.toast-enter-active, .toast-leave-active {
  transition: all 200ms ease;
}
</style>
