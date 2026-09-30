<script setup lang="ts">
import { computed, ref } from 'vue'

// 3 次ベジェの緩急カーブ (CSS の cubic-bezier と同じ) の編集。
// 横軸 = 時間 (0..1)、縦軸 = 進み具合 (行き過ぎを表せるよう -1..2 まで)。
// 2 つの制御点をドラッグして形を変える。

const props = defineProps<{ value: [number, number, number, number] }>()
const emit = defineEmits<{ change: [value: [number, number, number, number], dragging: boolean] }>()

const S = 100 // 0..1 の辺の長さ
const PAD_X = 10
const PAD_Y = 100 // 上下に行き過ぎ (-1..2) の余白
const W = S + PAD_X * 2
const H = S + PAD_Y * 2

const toX = (x: number) => PAD_X + x * S
const toY = (y: number) => PAD_Y + (1 - y) * S

const p1 = computed(() => ({ x: props.value[0], y: props.value[1] }))
const p2 = computed(() => ({ x: props.value[2], y: props.value[3] }))
const path = computed(
  () =>
    `M${toX(0)},${toY(0)} C${toX(p1.value.x)},${toY(p1.value.y)} ${toX(p2.value.x)},${toY(p2.value.y)} ${toX(1)},${toY(1)}`
)

const svgRef = ref<SVGSVGElement>()
const dragging = ref<0 | 1 | null>(null)

function onDown(e: PointerEvent, i: 0 | 1) {
  ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  dragging.value = i
}
function onMove(e: PointerEvent) {
  if (dragging.value == null || !svgRef.value) return
  const r = svgRef.value.getBoundingClientRect()
  const x = Math.max(0, Math.min(1, (((e.clientX - r.left) / r.width) * W - PAD_X) / S))
  const y = Math.max(-1, Math.min(2, 1 - (((e.clientY - r.top) / r.height) * H - PAD_Y) / S))
  const round = (v: number) => Math.round(v * 100) / 100
  const v = [...props.value] as [number, number, number, number]
  v[dragging.value * 2] = round(x)
  v[dragging.value * 2 + 1] = round(y)
  emit('change', v, true)
}
function onUp() {
  dragging.value = null
}
</script>

<template>
  <svg
    ref="svgRef"
    class="bezier"
    :viewBox="`0 0 ${W} ${H}`"
    @pointermove="onMove"
    @pointerup="onUp"
  >
    <rect class="frame" :x="toX(0)" :y="toY(1)" :width="S" :height="S" />
    <line class="diag" :x1="toX(0)" :y1="toY(0)" :x2="toX(1)" :y2="toY(1)" />
    <line class="arm" :x1="toX(0)" :y1="toY(0)" :x2="toX(p1.x)" :y2="toY(p1.y)" />
    <line class="arm" :x1="toX(1)" :y1="toY(1)" :x2="toX(p2.x)" :y2="toY(p2.y)" />
    <path class="curve" :d="path" />
    <circle class="h" :class="{ active: dragging === 0 }" :cx="toX(p1.x)" :cy="toY(p1.y)" r="5" @pointerdown="(e) => onDown(e, 0)" />
    <circle class="h" :class="{ active: dragging === 1 }" :cx="toX(p2.x)" :cy="toY(p2.y)" r="5" @pointerdown="(e) => onDown(e, 1)" />
  </svg>
</template>

<style scoped>
.bezier {
  width: 120px;
  height: auto;
  aspect-ratio: 120 / 300;
  display: block;
  margin: 4px auto;
  touch-action: none;
  background: var(--bg-1);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
}
.frame {
  fill: none;
  stroke: var(--line-strong);
  stroke-width: 1;
}
.diag {
  stroke: var(--line-weak);
  stroke-dasharray: 3 3;
}
.arm {
  stroke: var(--fg-3);
  stroke-width: 1;
}
.curve {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
}
.h {
  fill: var(--bg-0);
  stroke: var(--accent);
  stroke-width: 2;
  cursor: grab;
}
.h.active,
.h:hover {
  fill: var(--accent);
}
</style>
