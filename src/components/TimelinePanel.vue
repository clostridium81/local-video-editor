<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import type { Clip, Track, KeyframeableProperty } from '../types/project'
import { useSelection } from '../composables/useSelection'
import { getOrGeneratePeaks, drawPeaks, type Peaks } from '../engine/waveform'
import { loadAssetBlob } from '../persistence/assetStore'

const store = useProjectStore()
const selection = useSelection()
const scrollAreaRef = ref<HTMLDivElement>()
const trackAreaRef = ref<HTMLDivElement>()

const zoom = computed(() => store.state.timeline.zoom)
const duration = computed(() => store.state.timeline.duration)
const playhead = computed(() => store.state.timeline.playhead)

const contentWidth = computed(() => duration.value * zoom.value + 200)

const orderedTracks = computed(() => {
  const videos = store.tracks
    .filter(t => t.kind === 'video')
    .sort((a, b) => b.order - a.order)
  const audios = store.tracks
    .filter(t => t.kind === 'audio')
    .sort((a, b) => b.order - a.order)
  return [...videos, ...audios]
})

const tickMarks = computed(() => {
  const marks: { t: number; major: boolean; label: string }[] = []
  let step = 1
  const pxStep = zoom.value
  if (pxStep < 20) step = 10
  else if (pxStep < 40) step = 5
  else if (pxStep < 80) step = 2
  for (let t = 0; t <= duration.value; t += step) {
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    marks.push({
      t,
      major: true,
      label: `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    })
  }
  return marks
})

// ---------- クリップ描画 ----------

function clipStyle(c: Clip) {
  return {
    left: c.start * zoom.value + 'px',
    width: Math.max(2, c.duration * zoom.value) + 'px'
  }
}

function clipsOnTrack(trackId: string) {
  return store.state.clips.filter(c => c.trackId === trackId)
}

function clipLabel(c: Clip): string {
  if (c.kind === 'text') return `T: ${c.text}`
  const assetId = (c as any).assetId as string | undefined
  if (assetId) {
    const a = store.getAsset(assetId)
    return a?.name ?? c.kind
  }
  return c.kind
}

function clipTintByKind(c: Clip): string {
  if (c.kind === 'video') return 'linear-gradient(180deg, #2d5069 0%, #1f394c 100%)'
  if (c.kind === 'audio') return 'linear-gradient(180deg, #37613b 0%, #264529 100%)'
  if (c.kind === 'image') return 'linear-gradient(180deg, #593e6a 0%, #3e2b4a 100%)'
  if (c.kind === 'text') return 'linear-gradient(180deg, #614a22 0%, #433212 100%)'
  return 'var(--bg-3)'
}

function trackKindColor(kind: string) {
  return kind === 'audio' ? 'var(--audio)' : 'var(--video)'
}

function keyframeDotPositions(c: Clip): Array<{ x: number; prop: string }> {
  if (!c.keyframes) return []
  const result: Array<{ x: number; prop: string }> = []
  for (const prop of Object.keys(c.keyframes) as KeyframeableProperty[]) {
    const kfs = c.keyframes[prop]
    if (!kfs) continue
    for (const k of kfs) {
      if (k.time < 0 || k.time > c.duration) continue
      result.push({ x: k.time * zoom.value, prop })
    }
  }
  return result
}

// ---------- クリップクリック & ドラッグ ----------

function onClipClick(c: Clip, e: MouseEvent) {
  e.stopPropagation()
  const additive = e.shiftKey || e.metaKey || e.ctrlKey
  selection.selectClip(c.id, additive)
}

interface DragState {
  mode: 'move' | 'trim-left' | 'trim-right'
  clipId: string
  startX: number
  origStart: number
  origDuration: number
  origSourceIn: number
}

const dragRef = ref<DragState | null>(null)

function onClipMouseDown(c: Clip, e: MouseEvent, mode: DragState['mode']) {
  e.stopPropagation()
  e.preventDefault()
  if (!selection.isSelected(c.id)) {
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    selection.selectClip(c.id, additive)
  }
  dragRef.value = {
    mode,
    clipId: c.id,
    startX: e.clientX,
    origStart: c.start,
    origDuration: c.duration,
    origSourceIn: c.sourceIn ?? 0
  }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

function onDragMove(e: MouseEvent) {
  const drag = dragRef.value
  if (!drag) return
  const dxPx = e.clientX - drag.startX
  const dt = dxPx / zoom.value
  const threshold = 8 / zoom.value // 8px 以内でスナップ

  const mergeKey = `tl-${drag.mode}:${drag.clipId}`
  // リンクされたクリップを取得 (まとめて移動用)
  const linked = store.getLinkedClips(drag.clipId)
  const linkedIds = linked.map(l => l.id)
  const isLinked = linked.length > 1

  if (drag.mode === 'move') {
    let newStart = Math.max(0, drag.origStart + dt)
    newStart = store.snapTime(newStart, threshold, isLinked ? linkedIds : [drag.clipId])
    // リップル: 以降のクリップを push
    if (store.state.timeline.rippleMode && dt !== 0) {
      // 単純化: drag 対象のみ start を変える (他のリップル動作は非自動)
    }
    const delta = newStart - drag.origStart
    if (isLinked) {
      for (const l of linked) {
        store.updateClip(
          l.id,
          { start: Math.max(0, l.start + (l.id === drag.clipId ? delta : delta)) } as any,
          mergeKey
        )
      }
    } else {
      store.updateClip(drag.clipId, { start: newStart } as any, mergeKey)
    }
  } else if (drag.mode === 'trim-left') {
    const maxDelta = drag.origDuration - 0.05
    let delta = Math.max(-drag.origSourceIn, Math.min(maxDelta, dt))
    const newStart = store.snapTime(drag.origStart + delta, threshold, [drag.clipId])
    delta = newStart - drag.origStart
    delta = Math.max(-drag.origSourceIn, Math.min(maxDelta, delta))
    store.updateClip(
      drag.clipId,
      {
        start: drag.origStart + delta,
        duration: drag.origDuration - delta,
        sourceIn: drag.origSourceIn + delta
      } as any,
      mergeKey
    )
  } else if (drag.mode === 'trim-right') {
    let newDur = Math.max(0.1, drag.origDuration + dt)
    const rightEdge = store.snapTime(
      drag.origStart + newDur,
      threshold,
      [drag.clipId]
    )
    newDur = Math.max(0.1, rightEdge - drag.origStart)
    store.updateClip(drag.clipId, { duration: newDur } as any, mergeKey)
  }
}

function onDragEnd() {
  dragRef.value = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
}

// ---------- ルーラー操作 ----------

function onRulerClick(e: MouseEvent) {
  if (!trackAreaRef.value) return
  const rect = trackAreaRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left + (scrollAreaRef.value?.scrollLeft ?? 0)
  const t = Math.max(0, Math.min(duration.value, x / zoom.value))
  store.setPlayhead(t)
}

let rulerDragging = false
function onRulerMouseDown(e: MouseEvent) {
  rulerDragging = true
  onRulerClick(e)
  window.addEventListener('mousemove', onRulerDrag)
  window.addEventListener('mouseup', onRulerMouseUp)
}
function onRulerDrag(e: MouseEvent) {
  if (rulerDragging) onRulerClick(e)
}
function onRulerMouseUp() {
  rulerDragging = false
  window.removeEventListener('mousemove', onRulerDrag)
  window.removeEventListener('mouseup', onRulerMouseUp)
}

// ---------- トラックへの素材ドロップ ----------

function onTrackDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('application/x-lve-asset-id')) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
}

function onTrackDrop(e: DragEvent, track: Track) {
  const assetId = e.dataTransfer?.getData('application/x-lve-asset-id')
  if (!assetId) return
  if (!trackAreaRef.value) return
  const rect = trackAreaRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left + (scrollAreaRef.value?.scrollLeft ?? 0)
  const t = Math.max(0, x / zoom.value)
  const asset = store.getAsset(assetId)
  if (!asset) return
  if (asset.kind === 'audio' && track.kind === 'video') return
  if (asset.kind !== 'audio' && track.kind === 'audio') return
  store.addClipFromAsset(assetId, { trackId: track.id, start: t })
}

// ---------- ラバーバンド選択 ----------

interface RubberBand {
  active: boolean
  startX: number
  startY: number
  x: number
  y: number
}
const rubber = ref<RubberBand>({ active: false, startX: 0, startY: 0, x: 0, y: 0 })

function onContentMouseDown(e: MouseEvent) {
  // 空白領域クリックで選択解除 + ラバーバンド開始
  if (!(e.target as HTMLElement).classList.contains('track-row')) return
  const rect = trackAreaRef.value!.getBoundingClientRect()
  const scroll = scrollAreaRef.value?.scrollLeft ?? 0
  const scrollY = scrollAreaRef.value?.scrollTop ?? 0
  const x = e.clientX - rect.left + scroll
  const y = e.clientY - rect.top + scrollY
  rubber.value = { active: true, startX: x, startY: y, x, y }
  if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
    selection.clearSelection()
  }
  window.addEventListener('mousemove', onRubberMove)
  window.addEventListener('mouseup', onRubberEnd)
}

function onRubberMove(e: MouseEvent) {
  const rb = rubber.value
  if (!rb.active) return
  const rect = trackAreaRef.value!.getBoundingClientRect()
  const scroll = scrollAreaRef.value?.scrollLeft ?? 0
  const scrollY = scrollAreaRef.value?.scrollTop ?? 0
  const x = e.clientX - rect.left + scroll
  const y = e.clientY - rect.top + scrollY
  rubber.value = { ...rb, x, y }
}

function onRubberEnd() {
  const rb = rubber.value
  if (!rb.active) return
  const x1 = Math.min(rb.startX, rb.x)
  const x2 = Math.max(rb.startX, rb.x)
  const y1 = Math.min(rb.startY, rb.y)
  const y2 = Math.max(rb.startY, rb.y)
  const t1 = x1 / zoom.value
  const t2 = x2 / zoom.value
  const RULER_H = 24
  const ROW_H = 48
  const i1 = Math.max(0, Math.floor((y1 - RULER_H) / ROW_H))
  const i2 = Math.max(0, Math.floor((y2 - RULER_H) / ROW_H))
  const trackIds = orderedTracks.value.slice(i1, i2 + 1).map(t => t.id)
  const ids = store.state.clips
    .filter(c => trackIds.includes(c.trackId))
    .filter(c => c.start < t2 && c.start + c.duration > t1)
    .map(c => c.id)
  if (ids.length > 0) selection.selectClips(ids)
  rubber.value = { active: false, startX: 0, startY: 0, x: 0, y: 0 }
  window.removeEventListener('mousemove', onRubberMove)
  window.removeEventListener('mouseup', onRubberEnd)
}

const rubberStyle = computed(() => {
  const rb = rubber.value
  if (!rb.active) return { display: 'none' }
  const left = Math.min(rb.startX, rb.x)
  const top = Math.min(rb.startY, rb.y)
  const width = Math.abs(rb.x - rb.startX)
  const height = Math.abs(rb.y - rb.startY)
  return {
    left: left + 'px',
    top: top + 'px',
    width: width + 'px',
    height: height + 'px'
  }
})

function addTextClip() {
  const clip = store.addTextClip()
  selection.selectClip(clip.id)
}

function renameMarker(id: string, cur: string) {
  const l = window.prompt('マーカー名', cur)
  if (l !== null) store.updateMarker(id, { label: l })
}

// ---------- 波形 ----------

const peaksMap = ref<Map<string, Peaks>>(new Map())

async function ensureWaveformForAsset(assetId: string) {
  if (peaksMap.value.has(assetId)) return
  const peaks = await getOrGeneratePeaks(
    assetId,
    () => loadAssetBlob(store.meta.id, assetId)
  )
  if (peaks) {
    peaksMap.value.set(assetId, peaks)
    peaksMap.value = new Map(peaksMap.value) // trigger reactivity
  }
}

// 音声クリップが現れたら波形生成を開始
watch(
  () => store.state.clips.map(c =>
    c.kind === 'audio' || c.kind === 'video' ? (c as any).assetId : null
  ),
  (ids) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (id && !seen.has(id)) {
        seen.add(id)
        ensureWaveformForAsset(id)
      }
    }
  },
  { immediate: true }
)

// 波形 canvas refs を clipId でひも付けて管理
const waveCanvases = ref<Map<string, HTMLCanvasElement>>(new Map())

function setWaveCanvas(id: string, el: HTMLCanvasElement | null) {
  if (el) waveCanvases.value.set(id, el)
  else waveCanvases.value.delete(id)
}

function renderWaveforms() {
  for (const c of store.state.clips) {
    if (c.kind !== 'audio' && c.kind !== 'video') continue
    const asset = store.getAsset((c as any).assetId)
    if (!asset) continue
    const peaks = peaksMap.value.get((c as any).assetId)
    if (!peaks) continue
    const canvas = waveCanvases.value.get(c.id)
    if (!canvas) continue
    const w = Math.max(2, c.duration * zoom.value)
    const h = 40
    if (canvas.width !== Math.round(w)) canvas.width = Math.round(w)
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const sourceStart = c.sourceIn ?? 0
    const sourceEnd = sourceStart + c.duration
    const color =
      c.kind === 'audio' ? 'rgba(180, 230, 180, 0.9)' : 'rgba(180, 210, 240, 0.7)'
    drawPeaks(
      ctx,
      peaks,
      sourceStart,
      sourceEnd,
      0,
      0,
      canvas.width,
      canvas.height,
      color
    )
  }
}

watch(
  () => [store.state.clips, zoom.value, peaksMap.value],
  () => {
    // DOM 更新後に描画
    requestAnimationFrame(() => renderWaveforms())
  },
  { deep: true, immediate: true }
)

// ---------- マウント ----------

onMounted(() => {
  // キーボードは useKeyboard() が App.vue で処理
})
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  window.removeEventListener('mousemove', onRulerDrag)
  window.removeEventListener('mouseup', onRulerMouseUp)
  window.removeEventListener('mousemove', onRubberMove)
  window.removeEventListener('mouseup', onRubberEnd)
})

function hasWaveform(c: Clip): boolean {
  return c.kind === 'audio' || c.kind === 'video'
}
</script>

<template>
  <div class="timeline-panel">
    <div class="tl-toolbar">
      <button class="ghost" @click="addTextClip">＋ テキスト</button>
      <div class="dropdown">
        <button class="ghost">＋ 図形 ▾</button>
        <div class="dropdown-menu">
          <button class="ghost" @click="store.addShapeClip('rect')">矩形</button>
          <button class="ghost" @click="store.addShapeClip('ellipse')">楕円</button>
          <button class="ghost" @click="store.addShapeClip('triangle')">三角形</button>
          <button class="ghost" @click="store.addShapeClip('star')">星</button>
          <button class="ghost" @click="store.addShapeClip('arrow')">矢印</button>
          <button class="ghost" @click="store.addShapeClip('line')">線</button>
        </div>
      </div>
      <button class="ghost" @click="store.addTrack('video')">＋ V トラック</button>
      <button class="ghost" @click="store.addTrack('audio')">＋ A トラック</button>
      <div class="spacer" />
      <button
        class="ghost tiny"
        :class="{ active: store.state.timeline.snapping }"
        title="スナップ (N)"
        @click="store.toggleSnapping()"
      >🧲</button>
      <button
        class="ghost tiny"
        :class="{ active: store.state.timeline.rippleMode }"
        title="リップル (Shift+R)"
        @click="store.toggleRipple()"
      >⇆</button>
      <button
        class="ghost tiny"
        title="マーカー追加 (M)"
        @click="store.addMarker(store.state.timeline.playhead)"
      >🚩</button>
      <button
        class="ghost tiny"
        title="In点 (I)"
        @click="store.setInPoint(store.state.timeline.playhead)"
      >I</button>
      <button
        class="ghost tiny"
        title="Out点 (O)"
        @click="store.setOutPoint(store.state.timeline.playhead)"
      >O</button>
      <button
        class="ghost tiny"
        title="In/Out 解除 (Shift+I)"
        @click="store.clearInOut()"
      >×</button>
      <div class="sep" />
      <span class="muted mono" style="font-size: 11px">zoom</span>
      <input
        type="range"
        min="10"
        max="400"
        :value="zoom"
        class="zoom-slider"
        @input="(e) => store.setZoom(Number((e.target as HTMLInputElement).value))"
      />
    </div>

    <div class="tl-body">
      <div class="tl-headers">
        <div class="header-spacer" />
        <div
          v-for="track in orderedTracks"
          :key="track.id"
          class="track-header"
        >
          <div class="track-kind-bar" :style="{ background: trackKindColor(track.kind) }" />
          <span class="track-name mono">{{ track.name }}</span>
          <div class="spacer" />
          <button
            class="ghost tiny"
            :class="{ active: !!track.solo }"
            title="ソロ"
            @click="store.updateTrack(track.id, { solo: !track.solo })"
          >S</button>
          <button
            class="ghost tiny"
            :class="{ active: track.muted }"
            :title="track.muted ? 'ミュート解除' : 'ミュート'"
            @click="store.updateTrack(track.id, { muted: !track.muted })"
          >M</button>
        </div>
      </div>

      <div ref="scrollAreaRef" class="tl-scroll">
        <div
          ref="trackAreaRef"
          class="tl-content"
          :style="{ width: contentWidth + 'px' }"
        >
          <div class="ruler" @mousedown="onRulerMouseDown">
            <div
              v-for="m in tickMarks"
              :key="m.t"
              class="tick"
              :class="{ major: m.major }"
              :style="{ left: m.t * zoom + 'px' }"
            >
              <span class="tick-label mono">{{ m.label }}</span>
            </div>
            <!-- マーカー -->
            <div
              v-for="m in (store.state.markers ?? [])"
              :key="m.id"
              class="marker"
              :style="{ left: m.time * zoom + 'px', color: m.color ?? 'var(--accent)' }"
              :title="m.label"
              @click.stop="store.setPlayhead(m.time)"
              @dblclick.stop="renameMarker(m.id, m.label)"
              @contextmenu.stop.prevent="() => store.removeMarker(m.id)"
            >
              <div class="marker-flag" />
              <div class="marker-label">{{ m.label }}</div>
            </div>
            <!-- In/Out 範囲 -->
            <div
              v-if="store.state.timeline.inPoint != null || store.state.timeline.outPoint != null"
              class="inout-range"
              :style="{
                left: ((store.state.timeline.inPoint ?? 0) * zoom) + 'px',
                width: (((store.state.timeline.outPoint ?? duration) - (store.state.timeline.inPoint ?? 0)) * zoom) + 'px'
              }"
            />
            <div
              v-if="store.state.timeline.inPoint != null"
              class="inout-marker in-marker"
              :style="{ left: (store.state.timeline.inPoint * zoom) + 'px' }"
              title="In 点"
            >I</div>
            <div
              v-if="store.state.timeline.outPoint != null"
              class="inout-marker out-marker"
              :style="{ left: (store.state.timeline.outPoint * zoom) + 'px' }"
              title="Out 点"
            >O</div>
          </div>

          <div
            v-for="track in orderedTracks"
            :key="track.id"
            class="track-row"
            @dragover="onTrackDragOver"
            @drop="(e) => onTrackDrop(e, track)"
            @mousedown="onContentMouseDown"
          >
            <div
              v-for="c in clipsOnTrack(track.id)"
              :key="c.id"
              class="clip"
              :class="{ selected: selection.isSelected(c.id) }"
              :style="{
                ...clipStyle(c),
                background: clipTintByKind(c)
              }"
              @mousedown="(e) => onClipMouseDown(c, e, 'move')"
              @click="(e) => onClipClick(c, e)"
            >
              <div
                class="trim-handle left"
                @mousedown.stop="(e) => onClipMouseDown(c, e, 'trim-left')"
              />
              <canvas
                v-if="hasWaveform(c)"
                class="clip-wave"
                :ref="el => setWaveCanvas(c.id, el as HTMLCanvasElement | null)"
              />
              <div class="clip-inner">
                <div class="clip-label">{{ clipLabel(c) }}</div>
              </div>
              <div
                v-for="(kfd, i) in keyframeDotPositions(c)"
                :key="i"
                class="kf-dot"
                :style="{ left: kfd.x + 'px' }"
                :title="kfd.prop"
              />
              <div
                v-if="c.transitionIn && c.transitionIn.duration > 0"
                class="transition-in"
                :style="{ width: (c.transitionIn.duration * zoom) + 'px' }"
              />
              <div
                v-if="c.transitionOut && c.transitionOut.duration > 0"
                class="transition-out"
                :style="{ width: (c.transitionOut.duration * zoom) + 'px' }"
              />
              <div
                class="trim-handle right"
                @mousedown.stop="(e) => onClipMouseDown(c, e, 'trim-right')"
              />
            </div>
          </div>

          <div
            class="playhead"
            :style="{ left: playhead * zoom + 'px' }"
          />

          <div class="rubber-band" :style="rubberStyle" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline-panel {
  height: 340px;
  border-top: 1px solid var(--line);
  background: var(--bg-1);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tl-toolbar {
  height: 36px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--line-weak);
}
.zoom-slider {
  width: 120px;
  accent-color: var(--accent);
}

.tl-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.tl-headers {
  width: 100px;
  flex-shrink: 0;
  background: var(--bg-2);
  border-right: 1px solid var(--line-weak);
  display: flex;
  flex-direction: column;
}
.header-spacer {
  height: 24px;
  border-bottom: 1px solid var(--line-weak);
}
.track-header {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid var(--line-weak);
}
.track-kind-bar {
  width: 3px;
  height: 20px;
  border-radius: 2px;
  flex-shrink: 0;
}
.track-name {
  font-size: 11px;
  color: var(--fg-1);
  letter-spacing: 0.06em;
}
.spacer { flex: 1; }
button.tiny {
  padding: 2px 6px;
  font-size: 10px;
  min-width: 22px;
}
button.tiny.active {
  background: var(--accent-dim);
  color: var(--accent-hi);
}

.tl-scroll {
  flex: 1;
  overflow: auto;
  min-width: 0;
}

.tl-content {
  position: relative;
}

.ruler {
  height: 24px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  position: relative;
  cursor: pointer;
  user-select: none;
}
.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--line-weak);
}
.tick.major {
  border-left-color: var(--line);
}
.tick-label {
  position: absolute;
  left: 4px;
  top: 4px;
  font-size: 9px;
  color: var(--fg-2);
  letter-spacing: 0.05em;
}

.track-row {
  height: 48px;
  border-bottom: 1px solid var(--line-weak);
  position: relative;
  background:
    repeating-linear-gradient(
      90deg,
      transparent,
      transparent calc(var(--zoom, 50px) - 1px),
      var(--bg-2) calc(var(--zoom, 50px) - 1px),
      var(--bg-2) var(--zoom, 50px)
    );
}

.clip {
  position: absolute;
  top: 4px;
  bottom: 4px;
  border-radius: 4px;
  color: #fff;
  overflow: hidden;
  cursor: grab;
  border: 1px solid rgba(255, 255, 255, 0.08);
  user-select: none;
}
.clip:active { cursor: grabbing; }
.clip.selected {
  outline: 2px solid var(--accent);
  outline-offset: 0;
  z-index: 2;
}
.clip-wave {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: 100%;
  pointer-events: none;
  opacity: 0.85;
}
.clip-inner {
  position: absolute;
  inset: 0;
  padding: 5px 8px;
  display: flex;
  align-items: center;
  pointer-events: none;
}
.clip-label {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
}
.trim-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
  background: rgba(255, 255, 255, 0.0);
  transition: background 120ms;
  z-index: 3;
}
.trim-handle:hover {
  background: rgba(255, 255, 255, 0.3);
}
.trim-handle.left { left: 0; }
.trim-handle.right { right: 0; }

.kf-dot {
  position: absolute;
  top: 3px;
  width: 6px;
  height: 6px;
  background: var(--accent);
  transform: translate(-50%, 0) rotate(45deg);
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}

.transition-in, .transition-out {
  position: absolute;
  top: 0;
  bottom: 0;
  background: linear-gradient(
    to right,
    rgba(232, 168, 56, 0.55),
    rgba(232, 168, 56, 0)
  );
  pointer-events: none;
}
.transition-in {
  left: 0;
}
.transition-out {
  right: 0;
  background: linear-gradient(
    to left,
    rgba(232, 168, 56, 0.55),
    rgba(232, 168, 56, 0)
  );
}

.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--accent);
  pointer-events: none;
  z-index: 10;
  box-shadow: 0 0 8px rgba(232, 168, 56, 0.6);
}
.playhead::before {
  content: '';
  position: absolute;
  top: 0;
  left: -5px;
  width: 12px;
  height: 12px;
  background: var(--accent);
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}

.rubber-band {
  position: absolute;
  border: 1px dashed var(--accent);
  background: rgba(232, 168, 56, 0.1);
  pointer-events: none;
  z-index: 4;
}

.marker {
  position: absolute;
  top: 2px;
  transform: translateX(-50%);
  cursor: pointer;
  user-select: none;
}
.marker-flag {
  width: 10px;
  height: 14px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 0, 100% 70%, 50% 100%, 0 70%);
}
.marker-label {
  position: absolute;
  top: 14px;
  left: 8px;
  font-size: 9px;
  color: var(--fg-1);
  white-space: nowrap;
  background: var(--bg-1);
  padding: 1px 3px;
  border-radius: 2px;
  pointer-events: none;
  opacity: 0.8;
}

.inout-range {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(93, 184, 228, 0.08);
  border-left: 1px solid var(--video);
  border-right: 1px solid var(--video);
  pointer-events: none;
}
.inout-marker {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-size: 9px;
  font-weight: 700;
  color: #0a0b0d;
  background: var(--video);
  padding: 2px 4px;
  border-radius: 2px;
  pointer-events: none;
  letter-spacing: 0.06em;
}

.dropdown {
  position: relative;
}
.dropdown:hover .dropdown-menu {
  display: flex;
}
.dropdown-menu {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  flex-direction: column;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  min-width: 120px;
  padding: 4px;
  z-index: 20;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.dropdown-menu button {
  justify-content: flex-start;
  text-align: left;
  padding: 6px 10px;
}
.sep {
  width: 1px;
  height: 20px;
  background: var(--line);
  margin: 0 4px;
}
</style>
