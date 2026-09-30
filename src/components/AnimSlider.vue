<script setup lang="ts">
import { computed } from 'vue'
import type { Clip } from '../types/project'
import { useProjectStore } from '../stores/projectStore'
import { animatableDef, isAnimated, valueAt } from '../engine/animatable'
import { findKeyframeAt } from '../engine/keyframes'

// キーフレームで動かせる項目のスライダー。
// - 表示は再生位置での値 (キーフレーム適用後)
// - ◆ で再生位置のキーフレームを付け外し
// - キーフレームがある項目を動かすと、再生位置にキーが打たれる (store.setAnimatable)

const props = defineProps<{
  clip: Clip
  path: string
  label: string
  min?: number
  max?: number
  step?: number
}>()

const store = useProjectStore()
const def = computed(() => animatableDef(props.path))
const min = computed(() => props.min ?? def.value?.min ?? 0)
const max = computed(() => props.max ?? def.value?.max ?? 1)
const step = computed(() => props.step ?? def.value?.step ?? 0.01)

const local = computed(() => store.state.timeline.playhead - props.clip.start)
const inClip = computed(() => local.value >= 0 && local.value <= props.clip.duration)
const value = computed(() => valueAt(props.clip, props.path, local.value))
const animated = computed(() => isAnimated(props.clip, props.path))
const keyHere = computed(() => !!findKeyframeAt(props.clip.keyframes?.[props.path], local.value))

const display = computed(() => (step.value >= 1 ? value.value.toFixed(0) : value.value.toFixed(2)))

function onInput(e: Event) {
  const v = Number((e.target as HTMLInputElement).value)
  store.setAnimatable(props.clip.id, { [props.path]: v }, `anim-slide:${props.clip.id}:${props.path}`)
}

function toggleKey() {
  if (!inClip.value) return
  const k = findKeyframeAt(props.clip.keyframes?.[props.path], local.value)
  if (k) store.removeKeyframe(props.clip.id, props.path, k.time)
  else store.addKeyframe(props.clip.id, props.path, { time: local.value, value: value.value, easing: 'linear' })
}
</script>

<template>
  <label class="field anim-slider">
    <span>
      {{ label }}
      <button
        type="button"
        class="kf-btn inline"
        :class="{ on: keyHere, has: animated && !keyHere }"
        :disabled="!inClip"
        :title="keyHere ? 'この位置のキーフレームを削除' : 'この位置にキーフレームを追加'"
        @click.prevent="toggleKey"
      >◆</button>
      <span class="mono muted">{{ display }}</span>
    </span>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="value"
      @input="onInput"
    />
  </label>
</template>

<style scoped>
.anim-slider > span {
  color: var(--fg-2);
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.anim-slider > span .mono {
  margin-left: auto;
}
.kf-btn {
  background: none;
  border: 1px solid var(--line);
  color: var(--fg-3);
  padding: 0 5px;
  font-size: 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.kf-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.kf-btn.has {
  color: var(--accent-dim);
  border-color: var(--accent-dim);
}
.kf-btn.on {
  color: var(--accent-hi);
  border-color: var(--accent);
  background: rgba(232, 168, 56, 0.1);
}
</style>
