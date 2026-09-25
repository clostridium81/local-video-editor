<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SpeedPoint } from '../types/project'
import { MIN_CURVE_SPEED, MAX_CURVE_SPEED } from '../engine/frameTiming'

// 速度カーブの編集グラフ。横軸 = クリップ内の位置 (0..1)、縦軸 = 速度 (対数)。
// - 点をドラッグで移動 (両端の点は横に動かさない)
// - 何もない所をクリックで点を追加、点をダブルクリックで削除 (最低 2 点)
// - playhead (0..1, 範囲外なら非表示) に縦線を出す

const props = defineProps<{
  points: SpeedPoint[]
  playhead: number
}>()
const emit = defineEmits<{
  /** dragging=true の間は同じ履歴にまとめるため呼び出し側で mergeKey を付ける */
  change: [points: SpeedPoint[], dragging: boolean]
}>()

const W = 240
const H = 110
const PAD = 6
const LOG_MIN = Math.log10(MIN_CURVE_SPEED)
const LOG_MAX = Math.log10(MAX_CURVE_SPEED)

function toX(x: number) {
  return PAD + x * (W - PAD * 2)
}
function toY(speed: number) {
  const l = Math.log10(Math.max(MIN_CURVE_SPEED, Math.min(MAX_CURVE_SPEED, speed)))
  return PAD + (1 - (l - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (H - PAD * 2)
}
function fromY(y: number) {
  const f = 1 - (y - PAD) / (H - PAD * 2)
  const l = LOG_MIN + Math.max(0, Math.min(1, f)) * (LOG_MAX - LOG_MIN)
  // 1 倍付近は吸着 (元の速さに戻しやすく)
  const v = Math.pow(10, l)
  return Math.abs(Math.log10(v)) < 0.04 ? 1 : Math.round(v * 100) / 100
}

const sorted = computed(() => [...props.points].sort((a, b) => a.x - b.x))
const path = computed(() =>
  sorted.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.x).toFixed(1)},${toY(p.speed).toFixed(1)}`).join(' ')
)
const GRID = [0.1, 0.5, 1, 2, 5, 10]

const svgRef = ref<SVGSVGElement>()
const dragIndex = ref<number | null>(null)

function localPos(e: PointerEvent) {
  const r = svgRef.value!.getBoundingClientRect()
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
}

function onPointDown(e: PointerEvent, i: number) {
  e.stopPropagation()
  ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  dragIndex.value = i
}

function onMove(e: PointerEvent) {
  const i = dragIndex.value
  if (i == null) return
  const pos = localPos(e)
  const pts = sorted.value.map(p => ({ ...p }))
  const isEnd = i === 0 || i === pts.length - 1
  if (!isEnd) {
    // 隣の点を追い越さない
    const lo = pts[i - 1].x + 0.01
    const hi = pts[i + 1].x - 0.01
    pts[i].x = Math.max(lo, Math.min(hi, (pos.x - PAD) / (W - PAD * 2)))
  }
  pts[i].speed = fromY(pos.y)
  emit('change', pts, true)
}

function onUp() {
  dragIndex.value = null
}

function onBackgroundDown(e: PointerEvent) {
  const pos = localPos(e)
  const x = Math.max(0.01, Math.min(0.99, (pos.x - PAD) / (W - PAD * 2)))
  const pts = [...sorted.value.map(p => ({ ...p })), { x, speed: fromY(pos.y) }].sort((a, b) => a.x - b.x)
  emit('change', pts, false)
}

function onPointDblClick(i: number) {
  if (sorted.value.length <= 2 || i === 0 || i === sorted.value.length - 1) return
  emit('change', sorted.value.filter((_, j) => j !== i), false)
}
</script>

<template>
  <svg
    ref="svgRef"
    class="curve"
    :viewBox="`0 0 ${W} ${H}`"
    @pointerdown="onBackgroundDown"
    @pointermove="onMove"
    @pointerup="onUp"
  >
    <g class="grid">
      <line
        v-for="g in GRID" :key="g"
        :x1="PAD" :x2="W - PAD" :y1="toY(g)" :y2="toY(g)"
        :class="{ one: g === 1 }"
      />
      <text v-for="g in GRID" :key="'t' + g" :x="PAD + 2" :y="toY(g) - 2">{{ g }}x</text>
    </g>
    <line
      v-if="playhead >= 0 && playhead <= 1"
      class="playhead"
      :x1="toX(playhead)" :x2="toX(playhead)" :y1="0" :y2="H"
    />
    <path class="line" :d="path" />
    <circle
      v-for="(p, i) in sorted"
      :key="i"
      class="pt"
      :class="{ active: dragIndex === i }"
      :cx="toX(p.x)"
      :cy="toY(p.speed)"
      r="5"
      @pointerdown="(e) => onPointDown(e, i)"
      @dblclick.stop="onPointDblClick(i)"
    >
      <title>{{ p.speed.toFixed(2) }}x</title>
    </circle>
  </svg>
</template>

<style scoped>
.curve {
  width: 100%;
  height: auto;
  aspect-ratio: 240 / 110;
  background: var(--bg-1);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  cursor: crosshair;
  touch-action: none;
  display: block;
}
.grid line {
  stroke: var(--line-weak);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.grid line.one {
  stroke: var(--line-strong);
  stroke-dasharray: 3 3;
}
.grid text {
  fill: var(--fg-3);
  font-size: 7px;
}
.line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.playhead {
  stroke: #e05656;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.pt {
  fill: var(--bg-0);
  stroke: var(--accent);
  stroke-width: 2;
  cursor: grab;
  vector-effect: non-scaling-stroke;
}
.pt.active,
.pt:hover {
  fill: var(--accent);
}
</style>
