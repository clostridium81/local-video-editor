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

// ---------- 表示ガイド (グリッド / セーフエリア) ----------
// ON/OFF は localStorage に永続化する

const GUIDES_KEY = 'lve.preview.guides.v1'

function loadGuides(): { grid: boolean; safe: boolean } {
  try {
    const raw = localStorage.getItem(GUIDES_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      return { grid: !!v.grid, safe: !!v.safe }
    }
  } catch {
    // localStorage 不可や破損 JSON はデフォルトへフォールバック
  }
  return { grid: false, safe: false }
}

const storedGuides = loadGuides()
const showGrid = ref(storedGuides.grid)
const showSafe = ref(storedGuides.safe)

watch([showGrid, showSafe], () => {
  try {
    localStorage.setItem(
      GUIDES_KEY,
      JSON.stringify({ grid: showGrid.value, safe: showSafe.value })
    )
  } catch {
    // 書き込み失敗は黙殺 (永続化できないだけで動作はする)
  }
})

// ---------- プレビューズーム ----------
// 'fit' = ラッパーに収まるスケール / それ以外は固定倍率

type ZoomMode = 'fit' | '0.5' | '1'
const zoomMode = ref<ZoomMode>('fit')

const effectiveScale = computed(() =>
  zoomMode.value === 'fit' ? fitScale.value : Number(zoomMode.value)
)

// ガイド線の太さ (canvas 座標系 px)。stage が scale されるため、
// 画面上で常に約 1px になるようスケールの逆数で補正する
const guideStroke = computed(
  () => Math.max(1, 1 / Math.max(0.05, effectiveScale.value))
)

// ---------- ドラッグ中の中央吸着ガイド ----------
const alignSnap = ref({ x: false, y: false })

function onTogglePlayEvent() {
  togglePlay()
}

let fitObserver: ResizeObserver | null = null

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
  // window resize 以外 (パネル幅変更など) のラッパーサイズ変化にも追従
  if (wrapperRef.value && typeof ResizeObserver !== 'undefined') {
    fitObserver = new ResizeObserver(() => updateFit())
    fitObserver.observe(wrapperRef.value)
  }
  window.addEventListener('lve:toggle-play', onTogglePlayEvent)
})

onBeforeUnmount(() => {
  engine?.dispose()
  engine = null
  window.removeEventListener('resize', updateFit)
  fitObserver?.disconnect()
  fitObserver = null
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
    // Space からの再生は常に等速順方向 (J/K/L のシャトルレートを引き継がない)
    engine.setPlaybackRate(1)
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

/** プロジェクト fps (フレーム計算用に 1 以上の整数へ丸める) */
function projectFps() {
  return Math.max(1, Math.round(store.meta.fps))
}

/** 秒 → MM:SS.FF (FF = フレーム番号、プロジェクト fps 基準) */
function fmt(time: number) {
  const fps = projectFps()
  const totalFrames = Math.round(time * fps)
  const frames = totalFrames % fps
  const totalSec = Math.floor(totalFrames / fps)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(frames).padStart(2, '0')}`
}

/** 1フレーム単位で playhead を前後させる (フレーム境界にスナップ) */
function stepFrame(delta: number) {
  engine?.pause()
  playing.value = false
  const fps = projectFps()
  const currentFrame = Math.round(store.state.timeline.playhead * fps)
  store.setPlayhead((currentFrame + delta) / fps)
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
 * 任意クリップの canvas 座標系での bounding box を算出。
 * (選択枠の表示と、クリック時のヒットテストで共用)
 */
function clipBoxOf(c: Clip): BoxInfo | null {
  if (!isManipulatable(c)) return null
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

/**
 * 選択クリップの overlay 上での bounding box を算出。
 */
function currentBox(): BoxInfo | null {
  const c = selectedClip.value
  if (!isManipulatable(c)) return null
  if (!canvasRef.value) return null
  return clipBoxOf(c)
}

/**
 * canvas 座標 (px) にあるクリップを手前から探す。
 * playhead 上でアクティブな映像系クリップのみ対象。
 */
function pickClipAt(px: number, py: number): Clip | null {
  const t = store.state.timeline.playhead
  // order が大きいトラックほど後に描画される = 手前
  const orderOf = new Map(store.state.tracks.map(tr => [tr.id, tr.order]))
  const audioTrackIds = new Set(
    store.state.tracks.filter(tr => tr.kind === 'audio').map(tr => tr.id)
  )
  const candidates = store.state.clips
    .filter(c => t >= c.start && t < c.start + c.duration)
    .filter(c => isManipulatable(c) && !audioTrackIds.has(c.trackId))
    // 手前 (order 大) から判定
    .sort((a, b) => (orderOf.get(b.trackId) ?? 0) - (orderOf.get(a.trackId) ?? 0))
  for (const c of candidates) {
    const box = clipBoxOf(c)
    if (!box || box.w <= 0 || box.h <= 0) continue
    // クリック点を box ローカル座標へ逆回転して矩形内判定
    const dx = px - box.cx
    const dy = py - box.cy
    const rad = (-box.rotation * Math.PI) / 180
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
    if (Math.abs(lx) <= box.w / 2 && Math.abs(ly) <= box.h / 2) return c
  }
  return null
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
    let nx = clamp01Extended(d.origX + dx / store.meta.width)
    let ny = clamp01Extended(d.origY + dy / store.meta.height)
    // 中央 (x=0.5 / y=0.5) への吸着。吸着中はガイド線を表示する
    const SNAP_THRESHOLD = 0.01
    const snapX = Math.abs(nx - 0.5) < SNAP_THRESHOLD
    const snapY = Math.abs(ny - 0.5) < SNAP_THRESHOLD
    if (snapX) nx = 0.5
    if (snapY) ny = 0.5
    alignSnap.value = { x: snapX, y: snapY }
    store.updateClip(
      d.clipId,
      { x: nx, y: ny } as any,
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
  // ドラッグ終了で吸着ガイドを消す
  alignSnap.value = { x: false, y: false }
}

function clamp01Extended(v: number) {
  // 画面外配置も許容: -1..2 に丸める (clip は画面外に出せるように)
  return Math.max(-1, Math.min(2, v))
}

/**
 * キャンバスのクリック: その位置にあるクリップを手前から探して選択する。
 * 何もない場所なら選択解除。(タイムラインを経由せずに直接選べるように)
 */
function onBackdropClick(e: MouseEvent) {
  const p = overlayToCanvas(e.clientX, e.clientY)
  const hit = pickClipAt(p.x, p.y)
  if (hit) selection.selectClip(hit.id)
  else selection.clearSelection()
}

/** クリップのヒットボックス領域をクリックしても選択は切らない */
function onBodyPointerDown(e: PointerEvent) {
  onOverlayPointerDown(e, 'move')
}
</script>

<template>
  <div class="preview-panel">
    <div
      ref="wrapperRef"
      class="canvas-wrapper"
      :class="{ scrollable: zoomMode !== 'fit' }"
      @click="onBackdropClick"
    >
      <!-- sizer: 見た目のサイズ (scale 後) で場所を確保し、固定倍率時のスクロール量を正しくする -->
      <div
        class="canvas-stage-sizer"
        :style="{
          width: store.meta.width * effectiveScale + 'px',
          height: store.meta.height * effectiveScale + 'px'
        }"
      >
        <div
          class="canvas-stage"
          :style="{
            width: store.meta.width + 'px',
            height: store.meta.height + 'px',
            transform: `scale(${effectiveScale})`
          }"
        >
        <canvas ref="canvasRef" />
        <div
          ref="overlayRef"
          class="canvas-overlay"
          :style="{ width: store.meta.width + 'px', height: store.meta.height + 'px' }"
          @click.stop
        >
          <!-- 三分割グリッド (rule of thirds) -->
          <div v-if="showGrid" class="guide-layer" aria-hidden="true">
            <div class="grid-line v" :style="{ left: '33.3333%', width: guideStroke + 'px' }" />
            <div class="grid-line v" :style="{ left: '66.6667%', width: guideStroke + 'px' }" />
            <div class="grid-line h" :style="{ top: '33.3333%', height: guideStroke + 'px' }" />
            <div class="grid-line h" :style="{ top: '66.6667%', height: guideStroke + 'px' }" />
          </div>
          <!-- セーフエリア (90% アクションセーフ / 80% タイトルセーフ) -->
          <div v-if="showSafe" class="guide-layer" aria-hidden="true">
            <div class="safe-box action" :style="{ borderWidth: guideStroke + 'px' }" />
            <div class="safe-box title" :style="{ borderWidth: guideStroke + 'px' }" />
          </div>
          <!-- ドラッグ中の中央吸着ガイド -->
          <div v-if="alignSnap.x" class="align-guide v" :style="{ width: guideStroke * 2 + 'px' }" />
          <div v-if="alignSnap.y" class="align-guide h" :style="{ height: guideStroke * 2 + 'px' }" />
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
    </div>

    <div class="transport">
      <button class="ghost" @click="toStart" :title="t('先頭へ戻る', '先頭へ')">⏮</button>
      <button
        class="ghost step-btn mono"
        :title="t('1フレーム前に戻ります', '1フレーム戻る')"
        @click="stepFrame(-1)"
      >|◀</button>
      <button class="primary play-btn" :title="playing ? t('一時停止', '一時停止') : t('再生', '再生')" @click="togglePlay">
        {{ playing ? '❙❙' : '▶' }}
      </button>
      <button
        class="ghost step-btn mono"
        :title="t('1フレーム先に進みます', '1フレーム進む')"
        @click="stepFrame(1)"
      >▶|</button>
      <div
        class="time mono"
        :title="t('時間は 分:秒.フレーム番号 の形式で表示しています', '表示形式: 分:秒.フレーム (MM:SS.FF)')"
      >
        <span>{{ fmt(playhead) }}</span>
        <span class="sep"> / </span>
        <span class="muted">{{ fmt(duration) }}</span>
      </div>
      <div class="spacer" />
      <select
        v-model="zoomMode"
        class="zoom-select"
        :title="t('プレビューの表示倍率を変えられます', 'プレビュー表示倍率')"
      >
        <option value="fit">{{ t('画面に合わせる', 'フィット') }}</option>
        <option value="0.5">50%</option>
        <option value="1">100%</option>
      </select>
      <button
        class="ghost guide-btn"
        :class="{ active: showGrid }"
        :title="t('三分割のグリッド線を表示します', 'グリッド表示 (三分割線)')"
        @click="showGrid = !showGrid"
      >⊞</button>
      <button
        class="ghost guide-btn"
        :class="{ active: showSafe }"
        :title="t('セーフエリア (画面の安全な範囲) を表示します', 'セーフエリア表示 (90% / 80%)')"
        @click="showSafe = !showSafe"
      >▣</button>
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
  overflow: hidden;
  position: relative;
  background:
    radial-gradient(circle at 50% 50%, var(--bg-1) 0%, var(--bg-0) 80%);
}

/* 固定倍率 (50% / 100%) 時はスクロールしてパンできるようにする */
.canvas-wrapper.scrollable {
  overflow: auto;
}

.canvas-stage-sizer {
  /* flex 親で flex-shrink:1 に縮められるとアスペクト比が崩れるため固定 */
  flex-shrink: 0;
  flex-grow: 0;
  /* margin:auto で中央寄せ (justify/align center と違い、
     はみ出した際もスクロールで端まで到達できる) */
  margin: auto;
  position: relative;
}

.canvas-stage {
  /* sizer の左上に合わせて縮小/等倍表示する */
  transform-origin: 0 0;
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

/* ---------- 表示ガイド (グリッド / セーフエリア / 吸着ガイド) ---------- */
/* % ベースで配置しているため canvas-stage のスケールに自動追従する */

.guide-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.grid-line {
  position: absolute;
  background: rgba(255, 255, 255, 0.3);
  pointer-events: none;
}
.grid-line.v { top: 0; bottom: 0; transform: translateX(-50%); }
.grid-line.h { left: 0; right: 0; transform: translateY(-50%); }

.safe-box {
  position: absolute;
  border-style: solid;
  pointer-events: none;
}
/* アクションセーフ: 90% (上下左右 5% 内側) */
.safe-box.action {
  inset: 5%;
  border-color: rgba(255, 255, 255, 0.45);
}
/* タイトルセーフ: 80% (上下左右 10% 内側) */
.safe-box.title {
  inset: 10%;
  border-style: dashed;
  border-color: rgba(255, 255, 255, 0.35);
}

.align-guide {
  position: absolute;
  background: var(--accent);
  pointer-events: none;
}
.align-guide.v { left: 50%; top: 0; bottom: 0; transform: translateX(-50%); }
.align-guide.h { top: 50%; left: 0; right: 0; transform: translateY(-50%); }

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

.step-btn {
  padding: 6px 6px;
  font-size: 11px;
  letter-spacing: -0.05em;
}

.zoom-select {
  padding: 4px 6px;
  font-size: 11px;
}

.guide-btn {
  font-size: 14px;
  padding: 4px 8px;
  line-height: 1;
}
.guide-btn.active {
  color: var(--accent);
  border-color: var(--accent-dim);
  background: var(--bg-hover);
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
