<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import type { Clip, Track, KeyframeableProperty } from '../types/project'
import { useSelection } from '../composables/useSelection'
import { useLocale } from '../composables/useLocale'
import { getOrGeneratePeaks, drawPeaks, type Peaks } from '../engine/waveform'
import { loadAssetBlob } from '../persistence/assetStore'

const { t } = useLocale()

const store = useProjectStore()
const selection = useSelection()
const scrollAreaRef = ref<HTMLDivElement>()
const trackAreaRef = ref<HTMLDivElement>()

const zoom = computed(() => store.state.timeline.zoom)
const duration = computed(() => store.state.timeline.duration)
const playhead = computed(() => store.state.timeline.playhead)

const contentWidth = computed(() => duration.value * zoom.value + 200)

// タイムラインの行ジオメトリ (tl-content 内: ルーラーの下にトラック行が並ぶ)
const RULER_H = 24
const ROW_H = 48

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
  // 移動対象クリップ (選択中 + リンク相手) 全ての開始位置スナップショット (move 用)
  origStarts?: Map<string, number>
  // 移動対象クリップの元トラック行 index (orderedTracks 基準, move 用)
  origRows?: Map<string, number>
  // sourceIn 計算で speed 補正に使う
  origSpeed: number
}

const dragRef = ref<DragState | null>(null)

// スナップ成立中のガイドライン位置 (秒)。null なら非表示
const snapGuideTime = ref<number | null>(null)
// move ドラッグ中にホバーしている移動先トラック (行ハイライト用)
const dragHoverTrackId = ref<string | null>(null)

// クリップが載せられるトラック種別か
// (video/image/text/shape 系 → video トラック, audio → audio トラック)
function clipFitsTrack(clip: Clip, track: Track): boolean {
  return clip.kind === 'audio' ? track.kind === 'audio' : track.kind === 'video'
}

function onClipMouseDown(c: Clip, e: MouseEvent, mode: DragState['mode']) {
  if (e.button !== 0) return // 右クリックはコンテキストメニューに回す
  e.stopPropagation()
  e.preventDefault()
  if (!selection.isSelected(c.id)) {
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    selection.selectClip(c.id, additive)
  }
  // move では「選択中のクリップ + それぞれのリンク相手」を一括で動かす。
  // 開始時の start / トラック行をスナップショットしておく
  // (drag 中に store.state.clips が更新されると現在値が動くため、
  //  最新値ベースで delta を足し続けると指数的に飛ぶ)
  let origStarts: Map<string, number> | undefined
  let origRows: Map<string, number> | undefined
  if (mode === 'move') {
    const draggedIds = new Set<string>([c.id])
    for (const id of selection.selectedClipIds.value) draggedIds.add(id)
    for (const id of [...draggedIds]) {
      for (const l of store.getLinkedClips(id)) draggedIds.add(l.id)
    }
    origStarts = new Map()
    origRows = new Map()
    for (const id of draggedIds) {
      const clip = store.getClip(id)
      if (!clip) continue
      origStarts.set(id, clip.start)
      origRows.set(id, orderedTracks.value.findIndex(t => t.id === clip.trackId))
    }
  }
  dragRef.value = {
    mode,
    clipId: c.id,
    startX: e.clientX,
    origStart: c.start,
    origDuration: c.duration,
    origSourceIn: c.sourceIn ?? 0,
    origStarts,
    origRows,
    origSpeed: (c as any).speed ?? 1
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

  if (drag.mode === 'move') {
    // origStarts (= drag 開始時のスナップショット) + 共通 delta で全クリップを動かす。
    // 現在 start を読むと毎フレーム delta が積み重なってしまう。
    const starts = drag.origStarts ?? new Map([[drag.clipId, drag.origStart]])
    const draggedIds = [...starts.keys()]
    const rawStart = Math.max(0, drag.origStart + dt)
    const newStart = store.snapTime(rawStart, threshold, draggedIds)
    // 最も左のクリップが 0 を切らないよう、delta をクランプして全体で揃える
    let minOrig = Infinity
    for (const v of starts.values()) if (v < minOrig) minOrig = v
    const delta = Math.max(-minOrig, newStart - drag.origStart)
    // スナップが成立している間だけガイドラインを表示 (クランプで外れたら消す)
    snapGuideTime.value =
      newStart !== rawStart && Math.abs(drag.origStart + delta - newStart) < 1e-9
        ? newStart
        : null

    // 縦方向: マウス位置の行から行デルタを求め、
    // 対象クリップ全てが互換トラックに収まる場合のみトラックを移動する
    let rowDelta = 0
    dragHoverTrackId.value = null
    const rows = orderedTracks.value
    const rect = trackAreaRef.value?.getBoundingClientRect()
    const grabRow = drag.origRows?.get(drag.clipId) ?? -1
    if (rect && grabRow >= 0) {
      const hoverRow = Math.max(
        0,
        Math.min(rows.length - 1, Math.floor((e.clientY - rect.top - RULER_H) / ROW_H))
      )
      const cand = hoverRow - grabRow
      let ok = true
      for (const [id, r] of drag.origRows!) {
        const target = r >= 0 ? rows[r + cand] : undefined
        const clip = store.getClip(id)
        if (!target || !clip || !clipFitsTrack(clip, target)) {
          ok = false
          break
        }
      }
      if (ok) {
        rowDelta = cand
        dragHoverTrackId.value = rows[hoverRow].id
      }
    }

    for (const [id, origStart] of starts) {
      const r = drag.origRows?.get(id) ?? -1
      const target = r >= 0 ? rows[r + rowDelta] : undefined
      const patch: any = { start: origStart + delta }
      // 移動不可の行にいる間は rowDelta=0 → 元トラックへ戻す
      if (target) patch.trackId = target.id
      store.updateClip(id, patch, mergeKey)
    }
  } else if (drag.mode === 'trim-left') {
    const speed = drag.origSpeed
    // 素材内方向の最大引き戻し量は sourceIn / speed (タイムライン秒換算)
    const minDelta = -drag.origSourceIn / Math.max(0.0001, speed)
    const maxDelta = drag.origDuration - 0.05
    let delta = Math.max(minDelta, Math.min(maxDelta, dt))
    const rawStart = drag.origStart + delta
    const newStart = store.snapTime(rawStart, threshold, [drag.clipId])
    delta = newStart - drag.origStart
    delta = Math.max(minDelta, Math.min(maxDelta, delta))
    snapGuideTime.value =
      newStart !== rawStart && Math.abs(drag.origStart + delta - newStart) < 1e-9
        ? newStart
        : null
    // sourceIn は素材時間軸で増減 (delta * speed)
    store.updateClip(
      drag.clipId,
      {
        start: drag.origStart + delta,
        duration: drag.origDuration - delta,
        sourceIn: drag.origSourceIn + delta * speed
      } as any,
      mergeKey
    )
  } else if (drag.mode === 'trim-right') {
    let newDur = Math.max(0.1, drag.origDuration + dt)
    const rawEdge = drag.origStart + newDur
    const rightEdge = store.snapTime(rawEdge, threshold, [drag.clipId])
    newDur = Math.max(0.1, rightEdge - drag.origStart)
    // video/audio は素材の残り時間を超えて伸ばせない
    // (タイムライン秒 = 素材秒 / speed)
    const c = store.getClip(drag.clipId)
    if (c && (c.kind === 'video' || c.kind === 'audio')) {
      const asset = store.getAsset((c as any).assetId)
      if (asset?.duration) {
        const maxDur =
          (asset.duration - drag.origSourceIn) / Math.max(0.0001, drag.origSpeed)
        newDur = Math.min(newDur, Math.max(0.1, maxDur))
      }
    }
    snapGuideTime.value =
      rightEdge !== rawEdge && Math.abs(drag.origStart + newDur - rightEdge) < 1e-9
        ? rightEdge
        : null
    store.updateClip(drag.clipId, { duration: newDur } as any, mergeKey)
  }
}

function onDragEnd() {
  dragRef.value = null
  snapGuideTime.value = null
  dragHoverTrackId.value = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
}

// ---------- ルーラー操作 ----------

function onRulerClick(e: MouseEvent) {
  if (!trackAreaRef.value) return
  // trackAreaRef はスクロールされる要素そのものなので、rect.left には
  // すでにスクロール分が反映されている (scrollLeft を足すと2重加算になる)
  const rect = trackAreaRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left
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

// ---------- ホイール操作 (ズーム / 横スクロール) ----------

function onWheel(e: WheelEvent) {
  const el = scrollAreaRef.value
  if (!el) return
  if (e.ctrlKey || e.metaKey) {
    // Cmd/Ctrl+ホイール: カーソル位置の時刻を基準にズーム
    // (mac のピンチジェスチャも ctrlKey 付き wheel として届く)
    e.preventDefault()
    const rect = el.getBoundingClientRect()
    const cursorX = e.clientX - rect.left // 可視領域内のカーソル x
    const oldZoom = zoom.value
    const tAtCursor = (el.scrollLeft + cursorX) / oldZoom
    store.setZoom(oldZoom * Math.exp(-e.deltaY * 0.0015))
    const newZoom = store.state.timeline.zoom // setZoom はクランプするので実値を読む
    // カーソル下の時刻が動かないよう、コンテンツ幅の更新後に scrollLeft を補正
    nextTick(() => {
      el.scrollLeft = Math.max(0, tAtCursor * newZoom - cursorX)
    })
  } else if (e.shiftKey) {
    // Shift+ホイール: 横スクロール
    e.preventDefault()
    el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX
  }
}

// ---------- playhead のオートスクロール ----------

// playhead が可視範囲を外れたら追従スクロール (再生中もシークでも同様)。
// クリップドラッグ/ルーラースクラブ/ラバーバンド中はユーザー操作を優先する
watch(playhead, (t) => {
  if (dragRef.value || rulerDragging || rubber.value.active) return
  const el = scrollAreaRef.value
  if (!el || el.clientWidth === 0) return
  const x = t * zoom.value
  const margin = 24
  if (x > el.scrollLeft + el.clientWidth - margin || x < el.scrollLeft) {
    // ページ送り式: playhead を可視範囲の左端付近に持ってくる
    el.scrollLeft = Math.max(0, x - margin)
  }
})

// ---------- トラックへの素材ドロップ ----------

function onTrackDragOver(e: DragEvent, track: Track) {
  const types = e.dataTransfer?.types
  if (!types?.includes('application/x-lve-asset-id')) return
  // MediaLibrary が埋め込んだ種別タイプを見て、置けないトラックでは
  // preventDefault しない → ブラウザが no-drop カーソルを表示する
  const kind = types.includes('application/x-lve-kind-audio')
    ? 'audio'
    : types.includes('application/x-lve-kind-video') ||
        types.includes('application/x-lve-kind-image')
      ? 'visual'
      : null
  if (kind === 'audio' && track.kind !== 'audio') return
  if (kind === 'visual' && track.kind !== 'video') return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}

function onTrackDrop(e: DragEvent, track: Track) {
  const assetId = e.dataTransfer?.getData('application/x-lve-asset-id')
  if (!assetId) return
  if (!trackAreaRef.value) return
  const rect = trackAreaRef.value.getBoundingClientRect()
  const x = e.clientX - rect.left
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
  if (e.button !== 0) return
  // 空白領域クリックで選択解除 + ラバーバンド開始
  if (!(e.target as HTMLElement).classList.contains('track-row')) return
  const rect = trackAreaRef.value!.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
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
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
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

// ---------- クリップの右クリックメニュー ----------

interface CtxMenuState {
  visible: boolean
  x: number
  y: number
  clipId: string | null
}
const ctxMenu = ref<CtxMenuState>({ visible: false, x: 0, y: 0, clipId: null })
const ctxMenuRef = ref<HTMLDivElement>()

function onClipContextMenu(c: Clip, e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  // 選択外のクリップを右クリックしたらそのクリップだけを選択
  // (選択中のクリップなら複数選択を保ち、メニューは選択全体に作用)
  if (!selection.isSelected(c.id)) selection.selectClip(c.id)
  // 画面外にはみ出さないよう位置をクランプ
  const MENU_W = 220
  const MENU_H = 210
  ctxMenu.value = {
    visible: true,
    x: Math.max(0, Math.min(e.clientX, window.innerWidth - MENU_W)),
    y: Math.max(0, Math.min(e.clientY, window.innerHeight - MENU_H)),
    clipId: c.id
  }
  // メニュー外クリックで閉じる (メニュー内 mousedown は無視して click を待つ)
  window.addEventListener('mousedown', closeCtxMenu, true)
}

function closeCtxMenu(e?: MouseEvent) {
  if (
    e &&
    ctxMenuRef.value &&
    e.target instanceof Node &&
    ctxMenuRef.value.contains(e.target)
  ) {
    return
  }
  ctxMenu.value.visible = false
  window.removeEventListener('mousedown', closeCtxMenu, true)
}

// メニューの作用対象 = 選択中クリップ全体 (開いた時点で右クリック先は選択済み)
const ctxClips = computed<Clip[]>(() => {
  if (!ctxMenu.value.visible) return []
  const ids = new Set(selection.selectedClipIds.value)
  if (ctxMenu.value.clipId) ids.add(ctxMenu.value.clipId)
  return store.state.clips.filter(c => ids.has(c.id))
})
const ctxCanSplit = computed(() => {
  const t = playhead.value
  return ctxClips.value.some(
    c => t > c.start + 0.01 && t < c.start + c.duration - 0.01
  )
})
const ctxCanLink = computed(() => ctxClips.value.length >= 2)
const ctxCanUnlink = computed(() => ctxClips.value.some(c => !!c.linkGroup))

function ctxTargetIds(): string[] {
  return ctxClips.value.map(c => c.id)
}

function ctxSplit() {
  const newIds = store.splitSelectedAtPlayhead(ctxTargetIds())
  if (newIds.length > 0) selection.selectClips(newIds)
  closeCtxMenu()
}
function ctxDuplicate() {
  const clips = ctxClips.value
  if (clips.length > 0) {
    // 元クリップの直後に置く (キーボードの Cmd+D と同じオフセット)
    const dups = store.duplicateClips(
      clips,
      Math.max(...clips.map(c => c.duration)) || 0
    )
    store.addClips(dups)
    selection.selectClips(dups.map(d => d.id))
  }
  closeCtxMenu()
}
function ctxLink() {
  const ids = ctxTargetIds()
  if (ids.length >= 2) store.linkClips(ids)
  closeCtxMenu()
}
function ctxUnlink() {
  store.unlinkClips(ctxTargetIds())
  closeCtxMenu()
}
function ctxRemove() {
  store.removeClips(ctxTargetIds())
  selection.clearSelection()
  closeCtxMenu()
}
function ctxRippleDelete() {
  store.rippleDelete(ctxTargetIds())
  selection.clearSelection()
  closeCtxMenu()
}

function addTextClip() {
  const clip = store.addTextClip()
  selection.selectClip(clip.id)
}

function renameMarker(id: string, cur: string) {
  const l = window.prompt(t('マーカーの名前', 'マーカー名'), cur)
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
    // クリップがタイムライン上で duration 秒占めるとき、素材は duration * speed 秒消費する
    const sourceStart = c.sourceIn ?? 0
    const sourceEnd = sourceStart + c.duration * ((c as any).speed ?? 1)
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
  window.removeEventListener('mousedown', closeCtxMenu, true)
})

function hasWaveform(c: Clip): boolean {
  return c.kind === 'audio' || c.kind === 'video'
}
</script>

<template>
  <div class="timeline-panel">
    <div class="tl-toolbar" data-tour="timeline-toolbar">
      <button class="ghost" @click="addTextClip">＋ {{ t('文字', 'テキスト') }}</button>
      <div class="dropdown">
        <button class="ghost">＋ {{ t('図形', '図形') }} ▾</button>
        <div class="dropdown-menu">
          <button class="ghost" @click="store.addShapeClip('rect')">{{ t('四角', '矩形') }}</button>
          <button class="ghost" @click="store.addShapeClip('ellipse')">{{ t('円', '楕円') }}</button>
          <button class="ghost" @click="store.addShapeClip('triangle')">{{ t('三角', '三角形') }}</button>
          <button class="ghost" @click="store.addShapeClip('star')">{{ t('星', '星') }}</button>
          <button class="ghost" @click="store.addShapeClip('arrow')">{{ t('矢印', '矢印') }}</button>
          <button class="ghost" @click="store.addShapeClip('line')">{{ t('線', '線') }}</button>
        </div>
      </div>
      <button class="ghost" @click="store.addTrack('video')">＋ {{ t('映像トラック', '映像トラック') }}</button>
      <button class="ghost" @click="store.addTrack('audio')">＋ {{ t('音声トラック', '音声トラック') }}</button>
      <div class="spacer" />
      <button
        class="ghost tiny"
        :class="{ active: store.state.timeline.snapping }"
        :title="t('スナップ (N)', 'スナップ (N)')"
        @click="store.toggleSnapping()"
      >🧲</button>
      <button
        class="ghost tiny"
        :class="{ active: store.state.timeline.rippleMode }"
        :title="t('リップル削除: 削除したとき後ろのクリップを詰める (Shift+R)', 'リップル削除: 削除時に後続クリップを前へ詰める (Shift+R)')"
        @click="store.toggleRipple()"
      >⇆</button>
      <button
        class="ghost tiny"
        :title="t('マーカー追加 (M)', 'マーカー追加 (M)')"
        @click="store.addMarker(store.state.timeline.playhead)"
      >🚩</button>
      <button
        class="ghost tiny"
        :title="t('開始点 (I)', 'In点 (I)')"
        @click="store.setInPoint(store.state.timeline.playhead)"
      >I</button>
      <button
        class="ghost tiny"
        :title="t('終了点 (O)', 'Out点 (O)')"
        @click="store.setOutPoint(store.state.timeline.playhead)"
      >O</button>
      <button
        class="ghost tiny"
        :title="t('範囲を解除 (Shift+I)', 'In/Out 解除 (Shift+I)')"
        @click="store.clearInOut()"
      >×</button>
      <div class="sep" />
      <span class="muted mono" style="font-size: 11px">{{ t('大きさ', 'zoom') }}</span>
      <input
        type="range"
        min="10"
        max="400"
        :value="zoom"
        class="zoom-slider"
        @input="(e) => store.setZoom(Number((e.target as HTMLInputElement).value))"
      />
    </div>

    <div class="tl-body" data-tour="timeline-body">
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
            :title="t('ソロ (これだけ再生)', 'ソロ')"
            @click="store.updateTrack(track.id, { solo: !track.solo })"
          >S</button>
          <button
            class="ghost tiny"
            :class="{ active: track.muted }"
            :title="track.muted ? t('ミュート解除', 'ミュート解除') : t('ミュート', 'ミュート')"
            @click="store.updateTrack(track.id, { muted: !track.muted })"
          >M</button>
        </div>
      </div>

      <div ref="scrollAreaRef" class="tl-scroll" @wheel="onWheel">
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
              :title="m.label + t(' (ダブルクリックで名前変更 / 右クリックで削除)', ' (ダブルクリックで改名 / 右クリックで削除)')"
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
              :title="t('開始', 'In 点')"
            >I</div>
            <div
              v-if="store.state.timeline.outPoint != null"
              class="inout-marker out-marker"
              :style="{ left: (store.state.timeline.outPoint * zoom) + 'px' }"
              :title="t('終了', 'Out 点')"
            >O</div>
          </div>

          <div
            v-for="track in orderedTracks"
            :key="track.id"
            class="track-row"
            :class="{ 'drop-hover': dragHoverTrackId === track.id }"
            @dragover="(e) => onTrackDragOver(e, track)"
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
              @contextmenu="(e) => onClipContextMenu(c, e)"
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

          <!-- スナップ成立時のガイドライン -->
          <div
            v-if="snapGuideTime != null"
            class="snap-guide"
            :style="{ left: snapGuideTime * zoom + 'px' }"
          />

          <div
            class="playhead"
            :style="{ left: playhead * zoom + 'px' }"
          />

          <div class="rubber-band" :style="rubberStyle" />
        </div>
      </div>
    </div>

    <!-- クリップの右クリックメニュー -->
    <div
      v-if="ctxMenu.visible"
      ref="ctxMenuRef"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @contextmenu.prevent
    >
      <button class="ghost ctx-item" :disabled="!ctxCanSplit" @click="ctxSplit">
        {{ t('再生位置で分割', '再生ヘッドで分割') }}
      </button>
      <button class="ghost ctx-item" @click="ctxDuplicate">
        {{ t('複製', '複製') }}
      </button>
      <div class="ctx-sep" />
      <button class="ghost ctx-item" :disabled="!ctxCanLink" @click="ctxLink">
        {{ t('リンク (一緒に動かす)', 'リンク') }}
      </button>
      <button class="ghost ctx-item" :disabled="!ctxCanUnlink" @click="ctxUnlink">
        {{ t('リンク解除', 'リンク解除') }}
      </button>
      <div class="ctx-sep" />
      <button class="ghost ctx-item danger" @click="ctxRemove">
        {{ t('削除', '削除') }}
      </button>
      <button class="ghost ctx-item danger" @click="ctxRippleDelete">
        {{ t('リップル削除 (後ろを詰める)', 'リップル削除 (後続を詰める)') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.timeline-panel {
  /* 実際の高さは App.vue からインラインで指定 (ドラッグで可変)。これはフォールバック */
  height: 280px;
  border-top: 1px solid var(--line-region);
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

/* move ドラッグ中のホバー先トラック行 (移動可能なときだけ点灯) */
.track-row.drop-hover {
  background-color: rgba(232, 168, 56, 0.08);
  box-shadow: inset 0 0 0 1px var(--accent-dim);
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

/* スナップ成立時の縦ガイドライン (全トラック高) */
.snap-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--accent);
  pointer-events: none;
  z-index: 9;
}

/* クリップの右クリックメニュー */
.ctx-menu {
  position: fixed;
  z-index: 100;
  display: flex;
  flex-direction: column;
  min-width: 180px;
  padding: 4px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.ctx-item {
  justify-content: flex-start;
  text-align: left;
  padding: 6px 10px;
  white-space: nowrap;
}
.ctx-item.danger {
  color: var(--danger);
}
.ctx-sep {
  height: 1px;
  background: var(--line-weak);
  margin: 4px 2px;
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
