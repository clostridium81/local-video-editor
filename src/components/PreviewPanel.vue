<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { useSelection } from '../composables/useSelection'
import { useLocale } from '../composables/useLocale'
import { PreviewEngine } from '../engine/previewEngine'
import { sampleKeyframes } from '../engine/keyframes'
import { toast } from '../composables/useToast'
import type { Clip, VideoClip, ImageClip, TextClip, ShapeClip } from '../types/project'

const { t } = useLocale()

const store = useProjectStore()
const selection = useSelection()
const canvasRef = ref<HTMLCanvasElement>()
const wrapperRef = ref<HTMLDivElement>()
const overlayRef = ref<HTMLDivElement>()
let engine: PreviewEngine | null = null
const playing = ref(false)
const fitScale = ref(1)

function onTogglePlayEvent() {
  togglePlay()
}

onMounted(() => {
  if (!canvasRef.value) return
  engine = new PreviewEngine(canvasRef.value, store.state)
  engine.setOnFrame(() => {
    // 再生時に state が更新されるので Vue が再レンダリング。
    // 末尾到達などで engine が自動 pause した場合にボタン表示を同期する
    playing.value = engine?.isPlaying() ?? false
  })
  engine.setOnError(msg => toast.error(msg))
  engine.renderCurrent()
  updateFit()
  window.addEventListener('resize', updateFit)
  window.addEventListener('lve:toggle-play', onTogglePlayEvent)
})

onBeforeUnmount(() => {
  engine?.dispose()
  engine = null
  window.removeEventListener('resize', updateFit)
  window.removeEventListener('lve:toggle-play', onTogglePlayEvent)
})

// プレビューに関係する state が変わったら再描画
watch(
  () => [
    store.state.clips,
    store.state.tracks,
    store.state.meta,
    store.state.timeline.playhead
  ],
  () => {
    if (!engine) return
    engine.setState(store.state)
    if (!engine.isPlaying()) {
      engine.renderCurrent()
    }
  },
  { deep: true }
)

function updateFit() {
  if (!wrapperRef.value) return
  const rect = wrapperRef.value.getBoundingClientRect()
  const pad = 40
  const availW = rect.width - pad * 2
  const availH = rect.height - pad * 2
  const s = Math.min(
    availW / store.meta.width,
    availH / store.meta.height,
    1
  )
  fitScale.value = Math.max(0.05, s)
}

watch(
  () => [store.meta.width, store.meta.height],
  () => updateFit()
)

function togglePlay() {
  if (!engine) return
  if (engine.isPlaying()) {
    engine.pause()
    playing.value = false
  } else {
    // 範囲 (Out 点) または末尾に到達済みなら、範囲先頭 (In 点) へ戻して再生
    const tl = store.state.timeline
    const rangeEnd = tl.outPoint ?? tl.duration
    if (tl.playhead >= rangeEnd - 0.01) {
      store.setPlayhead(tl.inPoint ?? 0)
    }
    engine.play()
    playing.value = true
  }
}

function toStart() {
  engine?.pause()
  playing.value = false
  store.setPlayhead(0)
}

const playhead = computed(() => store.state.timeline.playhead)
const duration = computed(() => store.state.timeline.duration)

function fmt(t: number) {
  const ms = Math.floor((t % 1) * 100)
  const s = Math.floor(t) % 60
  const m = Math.floor(t / 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
}

// ---------- 選択クリップのオーバーレイ (キャンバスドラッグ) ----------

const selectedClip = computed<Clip | null>(() => {
  const id = selection.selectedClipId.value
  if (!id) return null
  return store.state.clips.find(c => c.id === id) ?? null
})

function isManipulatable(c: Clip | null): c is VideoClip | ImageClip | TextClip | ShapeClip {
  if (!c) return false
  return c.kind === 'video' || c.kind === 'image' || c.kind === 'text' || c.kind === 'shape'
}

interface BoxInfo {
  // 画面上 (overlay 内) の bounding box の中心
  cx: number
  cy: number
  // box の幅・高さ (回転前)
  w: number
  h: number
  // 回転角 (度)
  rotation: number
}

function effectiveTransform(c: Clip) {
  const t = store.state.timeline.playhead - c.start
  const x = sampleKeyframes(c.keyframes?.x, t, (c as any).x ?? 0.5)
  const y = sampleKeyframes(c.keyframes?.y, t, (c as any).y ?? 0.5)
  const scale = sampleKeyframes(c.keyframes?.scale, t, (c as any).scale ?? 1)
  const rotation = sampleKeyframes(c.keyframes?.rotation, t, (c as any).rotation ?? 0)
  return { x, y, scale, rotation }
}

/**
 * 選択クリップの overlay 上での bounding box を算出。
 */
function currentBox(): BoxInfo | null {
  const c = selectedClip.value
  if (!isManipulatable(c)) return null
  const canvas = canvasRef.value
  if (!canvas) return null
  const cw = store.meta.width
  const ch = store.meta.height
  const { x, y, scale, rotation } = effectiveTransform(c)

  let boxW = 0
  let boxH = 0

  if (c.kind === 'shape') {
    // 図形クリップは engine と揃えて短辺基準で正規化
    const ref = Math.min(cw, ch)
    boxW = ref * c.width * scale
    boxH = ref * c.height * scale
  } else {
    let natW = cw
    let natH = ch
    if (c.kind === 'video') {
      const asset = store.getAsset(c.assetId)
      natW = asset?.width ?? cw
      natH = asset?.height ?? ch
    } else if (c.kind === 'image') {
      const asset = store.getAsset(c.assetId)
      natW = asset?.width ?? cw
      natH = asset?.height ?? ch
    } else if (c.kind === 'text') {
      // 厳密にはフォントメトリクスが必要だが、概算で fontSize*文字数 と高さ
      natW = Math.max(120, c.fontSize * Math.max(1, c.text.length))
      natH = c.fontSize * 1.3
    }
    // 画像/映像/テキスト: engine の drawTransformed と同じ contain フィット
    const fit = Math.min(cw / natW, ch / natH)
    boxW = natW * fit * scale
    boxH = natH * fit * scale
  }

  const cx = cw * x
  const cy = ch * y
  return { cx, cy, w: boxW, h: boxH, rotation }
}

/** overlay 座標 → canvas 座標 (fitScale 考慮) */
function overlayToCanvas(ex: number, ey: number) {
  const canvas = canvasRef.value
  if (!canvas) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  const cx = (ex - rect.left) / rect.width * store.meta.width
  const cy = (ey - rect.top) / rect.height * store.meta.height
  return { x: cx, y: cy }
}

const boxInfo = computed<BoxInfo | null>(() => {
  // playhead 変化や clip 変更で再計算
  void store.state.timeline.playhead
  void store.state.clips
  return currentBox()
})

// 表示用: overlay 上の px でのハンドル配置
const overlayBox = computed(() => {
  const b = boxInfo.value
  if (!b) return null
  return {
    left: b.cx - b.w / 2,
    top: b.cy - b.h / 2,
    width: b.w,
    height: b.h,
    rotation: b.rotation
  }
})

// ---------- ドラッグ操作 ----------

type Mode = 'move' | 'scale-nw' | 'scale-ne' | 'scale-sw' | 'scale-se' | 'rotate'

interface DragState {
  mode: Mode
  clipId: string
  // canvas 座標基準の初期ポインター
  startCanvas: { x: number; y: number }
  // 初期 transform
  origX: number
  origY: number
  origScale: number
  origRotation: number
  // scale 計算用: ピボットからの初期距離
  pivotCanvas?: { x: number; y: number }
  initialDistToPivot?: number
  // rotate 用: 中心からの初期角
  initialAngleToCenter?: number
  center: { x: number; y: number }
}

const drag = ref<DragState | null>(null)

function onOverlayPointerDown(e: PointerEvent, mode: Mode) {
  const c = selectedClip.value
  if (!isManipulatable(c)) return
  const box = boxInfo.value
  if (!box) return

  e.stopPropagation()
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

  const p = overlayToCanvas(e.clientX, e.clientY)
  const center = { x: box.cx, y: box.cy }

  // pivot for scale = 対角のハンドル位置 (canvas 座標)
  let pivot: { x: number; y: number } | undefined
  let angle = Math.atan2(p.y - center.y, p.x - center.x)
  if (mode.startsWith('scale-')) {
    const hw = box.w / 2
    const hh = box.h / 2
    const map: Record<string, { x: number; y: number }> = {
      'scale-nw': { x: center.x + hw, y: center.y + hh },
      'scale-ne': { x: center.x - hw, y: center.y + hh },
      'scale-sw': { x: center.x + hw, y: center.y - hh },
      'scale-se': { x: center.x - hw, y: center.y - hh }
    }
    pivot = map[mode]
  }

  drag.value = {
    mode,
    clipId: c.id,
    startCanvas: p,
    origX: (c as any).x ?? 0.5,
    origY: (c as any).y ?? 0.5,
    origScale: (c as any).scale ?? 1,
    origRotation: (c as any).rotation ?? 0,
    pivotCanvas: pivot,
    initialDistToPivot: pivot
      ? Math.hypot(p.x - pivot.x, p.y - pivot.y)
      : undefined,
    initialAngleToCenter: angle,
    center
  }
}

function onOverlayPointerMove(e: PointerEvent) {
  const d = drag.value
  if (!d) return
  const p = overlayToCanvas(e.clientX, e.clientY)

  if (d.mode === 'move') {
    const dx = p.x - d.startCanvas.x
    const dy = p.y - d.startCanvas.y
    const nx = d.origX + dx / store.meta.width
    const ny = d.origY + dy / store.meta.height
    store.updateClip(
      d.clipId,
      { x: clamp01Extended(nx), y: clamp01Extended(ny) } as any,
      `canvas-move:${d.clipId}`
    )
  } else if (d.mode.startsWith('scale-') && d.pivotCanvas && d.initialDistToPivot) {
    const distNow = Math.hypot(p.x - d.pivotCanvas.x, p.y - d.pivotCanvas.y)
    const ratio = distNow / Math.max(1, d.initialDistToPivot)
    const newScale = Math.max(0.05, Math.min(10, d.origScale * ratio))
    store.updateClip(
      d.clipId,
      { scale: newScale } as any,
      `canvas-scale:${d.clipId}`
    )
  } else if (d.mode === 'rotate' && d.initialAngleToCenter != null) {
    const a = Math.atan2(p.y - d.center.y, p.x - d.center.x)
    const deltaDeg = ((a - d.initialAngleToCenter) * 180) / Math.PI
    store.updateClip(
      d.clipId,
      { rotation: d.origRotation + deltaDeg } as any,
      `canvas-rotate:${d.clipId}`
    )
  }
}

function onOverlayPointerUp(e: PointerEvent) {
  if (drag.value) {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    drag.value = null
  }
}

function clamp01Extended(v: number) {
  // 画面外配置も許容: -1..2 に丸める (clip は画面外に出せるように)
  return Math.max(-1, Math.min(2, v))
}

/** オーバーレイ背景 (クリップ外) クリックで選択解除 */
function onBackdropClick() {
  selection.clearSelection()
}

/** クリップのヒットボックス領域をクリックしても選択は切らない */
function onBodyPointerDown(e: PointerEvent) {
  onOverlayPointerDown(e, 'move')
}
</script>

<template>
  <div class="preview-panel">
    <div ref="wrapperRef" class="canvas-wrapper" @click="onBackdropClick">
      <div
        class="canvas-stage"
        :style="{
          width: store.meta.width + 'px',
          height: store.meta.height + 'px',
          transform: `scale(${fitScale})`
        }"
      >
        <canvas ref="canvasRef" />
        <div
          ref="overlayRef"
          class="canvas-overlay"
          :style="{ width: store.meta.width + 'px', height: store.meta.height + 'px' }"
          @click.stop
        >
          <div
            v-if="overlayBox && isManipulatable(selectedClip)"
            class="sel-box"
            :style="{
              left: overlayBox.left + 'px',
              top: overlayBox.top + 'px',
              width: overlayBox.width + 'px',
              height: overlayBox.height + 'px',
              transform: `rotate(${overlayBox.rotation}deg)`
            }"
          >
            <div
              class="sel-body"
              @pointerdown="onBodyPointerDown"
              @pointermove="onOverlayPointerMove"
              @pointerup="onOverlayPointerUp"
            />
            <div
              class="handle corner nw"
              @pointerdown="(e) => onOverlayPointerDown(e, 'scale-nw')"
              @pointermove="onOverlayPointerMove"
              @pointerup="onOverlayPointerUp"
            />
            <div
              class="handle corner ne"
              @pointerdown="(e) => onOverlayPointerDown(e, 'scale-ne')"
              @pointermove="onOverlayPointerMove"
              @pointerup="onOverlayPointerUp"
            />
            <div
              class="handle corner sw"
              @pointerdown="(e) => onOverlayPointerDown(e, 'scale-sw')"
              @pointermove="onOverlayPointerMove"
              @pointerup="onOverlayPointerUp"
            />
            <div
              class="handle corner se"
              @pointerdown="(e) => onOverlayPointerDown(e, 'scale-se')"
              @pointermove="onOverlayPointerMove"
              @pointerup="onOverlayPointerUp"
            />
            <div
              class="handle rotate"
              @pointerdown="(e) => onOverlayPointerDown(e, 'rotate')"
              @pointermove="onOverlayPointerMove"
              @pointerup="onOverlayPointerUp"
            />
            <div class="rotate-line" />
          </div>
        </div>
      </div>
    </div>

    <div class="transport">
      <button class="ghost" @click="toStart" :title="t('先頭へ戻る', '先頭へ')">⏮</button>
      <button class="primary play-btn" :title="playing ? t('一時停止', '一時停止') : t('再生', '再生')" @click="togglePlay">
        {{ playing ? '❙❙' : '▶' }}
      </button>
      <div class="time mono">
        <span>{{ fmt(playhead) }}</span>
        <span class="sep"> / </span>
        <span class="muted">{{ fmt(duration) }}</span>
      </div>
      <div class="spacer" />
      <div class="resolution muted mono">
        {{ store.meta.width }} × {{ store.meta.height }} · {{ store.meta.fps }}fps
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-0);
}

.canvas-wrapper {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  position: relative;
  background:
    radial-gradient(circle at 50% 50%, var(--bg-1) 0%, var(--bg-0) 80%);
}

.canvas-stage {
  /* flex 親で flex-shrink:1 に縮められるとアスペクト比が崩れるため固定 */
  flex-shrink: 0;
  flex-grow: 0;
  transform-origin: center center;
  box-shadow:
    0 0 0 1px var(--line),
    0 20px 60px rgba(0, 0, 0, 0.5);
  position: relative;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
  background: #000;
}

.canvas-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.sel-box {
  position: absolute;
  pointer-events: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(232, 168, 56, 0.2);
  transform-origin: center center;
}

.sel-body {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  cursor: grab;
}
.sel-body:active { cursor: grabbing; }

.handle {
  position: absolute;
  width: 18px;
  height: 18px;
  background: var(--bg-0);
  border: 2px solid var(--accent);
  border-radius: 4px;
  pointer-events: auto;
  transform: translate(-50%, -50%);
}
.handle.corner.nw { top: 0; left: 0; cursor: nwse-resize; }
.handle.corner.ne { top: 0; left: 100%; cursor: nesw-resize; }
.handle.corner.sw { top: 100%; left: 0; cursor: nesw-resize; }
.handle.corner.se { top: 100%; left: 100%; cursor: nwse-resize; }
.handle.rotate {
  top: -44px;
  left: 50%;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent);
  cursor: grab;
}
.handle.rotate:active { cursor: grabbing; }
.rotate-line {
  position: absolute;
  top: -34px;
  left: 50%;
  width: 2px;
  height: 34px;
  background: var(--accent);
  transform: translateX(-50%);
  pointer-events: none;
}

.transport {
  height: 44px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 10px;
  background: var(--bg-1);
  border-top: 1px solid var(--line-weak);
}

.play-btn {
  min-width: 48px;
  font-size: 13px;
}

.time {
  font-size: 13px;
  letter-spacing: 0.04em;
}
.time .sep { color: var(--fg-3); }

.resolution {
  font-size: 11px;
}
</style>
