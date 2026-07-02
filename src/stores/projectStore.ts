import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { ref, computed, watch } from 'vue'
import type {
  Asset,
  AssetFolder,
  Clip,
  Keyframe,
  KeyframeableProperty,
  Marker,
  ProjectState,
  Track,
  VideoClip,
  ImageClip,
  AudioClip,
  TextClip,
  ShapeClip,
  ShapeKind,
  ClipEffects,
  ColorGrade,
  ChromaKey,
  PixelEffects,
  Transition,
  TextAnim,
  TextDecor,
  BlendMode,
  AudioEQ
} from '../types/project'
import { getPreset } from '../engine/effectPresets'
import {
  saveAssetBlob,
  deleteAssetBlob,
  getAssetObjectURL,
  revokeAllObjectURLs,
  saveProjectState,
  loadLatestProjectState
} from '../persistence/assetStore'
import { detectAssetKind, extractMediaMeta } from '../persistence/mediaMeta'
import { historyManager } from './history'
import {
  insertKeyframe,
  removeKeyframeAt,
  splitAllKeyframes,
  sampleKeyframes
} from '../engine/keyframes'
import { toast } from '../composables/useToast'

// ============================================================
// プロジェクトストア
// ============================================================
// このストアに入っているものはすべてシリアライズ可能でなければならない
// (バックアップZIPに project.json として書き出すため)。
// Blob や ObjectURL はここには保持しない。
// ============================================================

const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080
const DEFAULT_FPS = 30
const AUTOSAVE_DEBOUNCE_MS = 1200

function makeEmptyProject(name = 'なまえなしの さくひん'): ProjectState {
  const now = Date.now()
  return {
    meta: {
      id: nanoid(),
      name,
      createdAt: now,
      updatedAt: now,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      fps: DEFAULT_FPS,
      backgroundColor: '#000000'
    },
    assets: {},
    folders: [],
    tracks: [
      { id: nanoid(), kind: 'video', name: 'V1', muted: false, locked: false, order: 1 },
      { id: nanoid(), kind: 'video', name: 'V2', muted: false, locked: false, order: 2 },
      { id: nanoid(), kind: 'audio', name: 'A1', muted: false, locked: false, order: 0, volume: 1 }
    ],
    clips: [],
    markers: [],
    timeline: {
      playhead: 0,
      zoom: 50,
      duration: 60,
      snapping: true,
      rippleMode: false,
      masterVolume: 1
    }
  }
}

export const useProjectStore = defineStore('project', () => {
  const state = ref<ProjectState>(makeEmptyProject())
  const historyVersion = ref(0)

  function bumpHistoryVersion() {
    historyVersion.value = historyManager.getVersion()
  }

  // ---------- getters ----------
  const meta = computed(() => state.value.meta)
  const assets = computed(() => state.value.assets)
  const tracks = computed(() =>
    [...state.value.tracks].sort((a, b) => a.order - b.order)
  )
  const clips = computed(() => state.value.clips)
  const timeline = computed(() => state.value.timeline)

  function getClipsOnTrack(trackId: string) {
    return state.value.clips.filter(c => c.trackId === trackId)
  }

  function getAsset(assetId: string): Asset | undefined {
    return state.value.assets[assetId]
  }

  function getClip(clipId: string): Clip | undefined {
    return state.value.clips.find(c => c.id === clipId)
  }

  // ---------- history ----------

  function recordHistory(mergeKey?: string) {
    historyManager.record(state.value, mergeKey)
    bumpHistoryVersion()
  }

  const canUndo = computed(() => {
    void historyVersion.value
    return historyManager.canUndo()
  })
  const canRedo = computed(() => {
    void historyVersion.value
    return historyManager.canRedo()
  })

  function undo() {
    const prev = historyManager.performUndo(state.value)
    if (prev) {
      state.value = prev
      bumpHistoryVersion()
    }
  }

  function redo() {
    const next = historyManager.performRedo(state.value)
    if (next) {
      state.value = next
      bumpHistoryVersion()
    }
  }

  // ---------- 素材の追加 ----------

  async function addAssetFromFile(file: File): Promise<Asset | null> {
    const kind = detectAssetKind(file)
    if (!kind) {
      toast.warn(`この形式のファイルは使えません: ${file.name}`)
      return null
    }
    const assetId = nanoid()
    const mediaMeta = await extractMediaMeta(file, kind).catch(() => ({}))
    const asset: Asset = {
      id: assetId,
      kind,
      name: file.name,
      mimeType: file.type || guessMimeByName(file.name),
      size: file.size,
      duration: (mediaMeta as any).duration,
      width: (mediaMeta as any).width,
      height: (mediaMeta as any).height,
      createdAt: Date.now()
    }
    try {
      await saveAssetBlob(state.value.meta.id, assetId, file)
    } catch (err: any) {
      if (err?.name === 'QuotaExceededError') {
        toast.error(`保存できる容量がいっぱいです: ${file.name}`)
      } else {
        toast.error(`ファイルを追加できませんでした: ${file.name}`)
      }
      return null
    }
    state.value.assets[assetId] = asset
    touch()
    // 素材追加は履歴外 (IndexedDB 副作用のため)。
    // 履歴をクリアすると undo が詰まるので残すが、以降の undo で素材を失う
    // 可能性に備えて clear 不要 (undo で消えても IndexedDB 上 blob は残る)。
    return asset
  }

  async function removeAsset(assetId: string) {
    state.value.clips = state.value.clips.filter(c => {
      if ('assetId' in c && c.assetId === assetId) return false
      return true
    })
    delete state.value.assets[assetId]
    try {
      await deleteAssetBlob(state.value.meta.id, assetId)
    } catch (err) {
      toast.error('素材を削除できませんでした')
    }
    touch()
  }

  // ---------- クリップの追加・操作 ----------

  function addClipFromAsset(
    assetId: string,
    opts: { trackId?: string; start?: number } = {}
  ): Clip | null {
    const asset = state.value.assets[assetId]
    if (!asset) return null

    const trackKind = asset.kind === 'audio' ? 'audio' : 'video'
    // 適合トラックが無ければ自動で作る (例: video トラック全削除済みに image を投入)。
    // fallback で逆種別のトラック (例: audio に image) に置くと、タイムラインから
    // 消えたように見えてしまうのを防ぐ。
    let trackId = opts.trackId
    if (!trackId) {
      const compat = tracks.value.find(t => t.kind === trackKind)
      if (compat) {
        trackId = compat.id
      } else {
        addTrack(trackKind)
        // addTrack 直後の tracks computed には新しい order の track が入っている
        const created = state.value.tracks.filter(t => t.kind === trackKind).pop()
        trackId = created?.id ?? state.value.tracks[0].id
      }
    }

    const start = opts.start ?? state.value.timeline.playhead
    const duration = asset.duration ?? (asset.kind === 'image' ? 5 : 3)

    const base = {
      id: nanoid(),
      trackId,
      start,
      duration,
      sourceIn: 0,
      opacity: 1
    }

    recordHistory()

    let clip: Clip
    if (asset.kind === 'video') {
      clip = {
        ...base,
        kind: 'video',
        assetId,
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0,
        volume: 1
      } as VideoClip
    } else if (asset.kind === 'image') {
      clip = {
        ...base,
        kind: 'image',
        assetId,
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0
      } as ImageClip
    } else {
      clip = {
        ...base,
        kind: 'audio',
        assetId,
        volume: 1
      } as AudioClip
    }

    state.value.clips.push(clip)
    extendDurationIfNeeded(start + duration)
    touch()
    return clip
  }

  function addTextClip(opts: { start?: number; trackId?: string } = {}): TextClip {
    const trackId =
      opts.trackId ??
      tracks.value.find(t => t.kind === 'video')?.id ??
      state.value.tracks[0].id
    const start = opts.start ?? state.value.timeline.playhead
    const clip: TextClip = {
      id: nanoid(),
      kind: 'text',
      trackId,
      start,
      duration: 3,
      opacity: 1,
      text: 'もじ',
      fontFamily: 'sans-serif',
      fontSize: 72,
      color: '#ffffff',
      x: 0.5,
      y: 0.5,
      align: 'center',
      bold: true,
      italic: false
    }
    recordHistory()
    state.value.clips.push(clip)
    extendDurationIfNeeded(start + clip.duration)
    touch()
    return clip
  }

  function updateClip(id: string, patch: Partial<Clip>, mergeKey?: string) {
    const i = state.value.clips.findIndex(c => c.id === id)
    if (i < 0) return
    recordHistory(mergeKey ?? `update:${id}`)
    state.value.clips[i] = { ...state.value.clips[i], ...(patch as any) }
    const c = state.value.clips[i]
    extendDurationIfNeeded(c.start + c.duration)
    touch()
  }

  function removeClip(id: string) {
    recordHistory()
    state.value.clips = state.value.clips.filter(c => c.id !== id)
    touch()
  }

  function removeClips(ids: string[]) {
    if (ids.length === 0) return
    recordHistory()
    const set = new Set(ids)
    state.value.clips = state.value.clips.filter(c => !set.has(c.id))
    touch()
  }

  // ---------- クリップ分割 ----------

  /**
   * クリップを絶対時刻で 2 つに分割。返り値は右側 (新規作成) のID。
   * mergeKey を渡すと連続呼び出しを 1 履歴にまとめる。
   */
  function splitClipAt(
    clipId: string,
    absoluteTime: number,
    mergeKey?: string
  ): string | null {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return null
    const c = state.value.clips[idx]
    const localSplit = absoluteTime - c.start
    if (localSplit <= 0.01 || localSplit >= c.duration - 0.01) return null

    recordHistory(mergeKey)

    const { left: leftKf, right: rightKf } = splitAllKeyframes(c.keyframes, localSplit)

    // 左側
    const leftClip: Clip = {
      ...c,
      duration: localSplit,
      keyframes: leftKf,
      transitionOut: undefined // 分割境界にはトランジション不要
    }

    // 右側: 新 ID、sourceIn を進める (video/audio)
    const rightBase = {
      ...c,
      id: nanoid(),
      start: absoluteTime,
      duration: c.duration - localSplit,
      keyframes: rightKf,
      transitionIn: undefined
    }
    if (c.kind === 'video' || c.kind === 'audio') {
      // タイムライン上で localSplit 秒進んだ間に、素材は localSplit * speed 秒
      // 進んでいる (speed=2 なら倍消費)。逆再生時は素材側オフセット (sourceIn)
      // は終端基準なので動かさず、再生中の "残り素材時間" が短くなる扱いにする。
      const speed = (c as any).speed ?? 1
      const reversed = !!(c as any).reversed
      ;(rightBase as VideoClip | AudioClip).sourceIn = reversed
        ? (c.sourceIn ?? 0)
        : (c.sourceIn ?? 0) + localSplit * speed
    }

    state.value.clips.splice(idx, 1, leftClip, rightBase as Clip)
    touch()
    return rightBase.id
  }

  function splitSelectedAtPlayhead(selectedIds: string[]) {
    const t = state.value.timeline.playhead
    const targets =
      selectedIds.length > 0
        ? state.value.clips.filter(c => selectedIds.includes(c.id))
        : state.value.clips.filter(c => t > c.start && t < c.start + c.duration)
    const hits = targets.filter(c => t > c.start + 0.01 && t < c.start + c.duration - 0.01)
    if (hits.length === 0) return []
    const mergeKey = `splitAt:${t.toFixed(3)}`
    const newIds: string[] = []
    for (const c of hits) {
      const nid = splitClipAt(c.id, t, mergeKey)
      if (nid) newIds.push(nid)
    }
    return newIds
  }

  // ---------- クリップの複製 / 貼り付け ----------

  function duplicateClips(clips: Clip[], timeOffset: number): Clip[] {
    const created: Clip[] = []
    for (const c of clips) {
      const copy: Clip = JSON.parse(JSON.stringify(c))
      copy.id = nanoid()
      copy.start = Math.max(0, c.start + timeOffset)
      // trackId が現プロジェクトに存在するか確認
      if (!state.value.tracks.find(t => t.id === copy.trackId)) {
        const compat = state.value.tracks.find(t =>
          copy.kind === 'audio' ? t.kind === 'audio' : t.kind === 'video'
        )
        if (compat) copy.trackId = compat.id
      }
      created.push(copy)
    }
    return created
  }

  function addClips(clips: Clip[]) {
    if (clips.length === 0) return
    recordHistory()
    for (const c of clips) {
      state.value.clips.push(c)
      extendDurationIfNeeded(c.start + c.duration)
    }
    touch()
  }

  function pasteClipsAtPlayhead(clips: Clip[]): string[] {
    if (clips.length === 0) return []
    const minStart = Math.min(...clips.map(c => c.start))
    const offset = state.value.timeline.playhead - minStart
    const created = duplicateClips(clips, offset)
    addClips(created)
    return created.map(c => c.id)
  }

  // ---------- キーフレーム ----------

  function addKeyframe(clipId: string, prop: KeyframeableProperty, kf: Keyframe) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    recordHistory(`kf:${clipId}:${prop}`)
    const c = state.value.clips[idx] as any
    const kfs: Keyframe[] | undefined = c.keyframes?.[prop]
    const next = insertKeyframe(kfs, kf)
    c.keyframes = { ...(c.keyframes ?? {}), [prop]: next }
    state.value.clips[idx] = { ...c }
    touch()
  }

  function removeKeyframe(clipId: string, prop: KeyframeableProperty, time: number) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    recordHistory(`kfdel:${clipId}:${prop}`)
    const c = state.value.clips[idx] as any
    const kfs: Keyframe[] | undefined = c.keyframes?.[prop]
    const next = removeKeyframeAt(kfs, time)
    const newKfs = { ...(c.keyframes ?? {}) }
    if (next) newKfs[prop] = next
    else delete newKfs[prop]
    c.keyframes = Object.keys(newKfs).length > 0 ? newKfs : undefined
    state.value.clips[idx] = { ...c }
    touch()
  }

  /**
   * 指定プロパティの現在の (キーフレーム適用後の) 有効値を返す。
   * UI の「現在値でキーフレームを追加」操作で使う。
   */
  function currentEffectiveValue(clip: Clip, prop: KeyframeableProperty): number {
    const base = (clip as any)[prop]
    if (typeof base !== 'number') return 0
    const localT = state.value.timeline.playhead - clip.start
    const kfs = clip.keyframes?.[prop]
    return sampleKeyframes(kfs, localT, base)
  }

  // ---------- トランジション / エフェクト ----------

  function setTransition(
    clipId: string,
    side: 'in' | 'out',
    transition: Transition | undefined
  ) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    recordHistory(`trans:${clipId}:${side}`)
    const c: any = { ...state.value.clips[idx] }
    if (side === 'in') c.transitionIn = transition
    else c.transitionOut = transition
    state.value.clips[idx] = c
    touch()
  }

  function setEffects(clipId: string, effects: ClipEffects | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'video' && c.kind !== 'image') return
    recordHistory(`effects:${clipId}`)
    state.value.clips[idx] = { ...c, effects } as Clip
    touch()
  }

  // ---------- トラック ----------

  function addTrack(kind: Track['kind']) {
    recordHistory()
    const sameKind = state.value.tracks.filter(t => t.kind === kind)
    const track: Track = {
      id: nanoid(),
      kind,
      name: `${kind === 'video' ? 'V' : 'A'}${sameKind.length + 1}`,
      muted: false,
      locked: false,
      order:
        kind === 'video'
          ? Math.max(0, ...state.value.tracks.filter(t => t.kind === 'video').map(t => t.order)) + 1
          : Math.min(0, ...state.value.tracks.filter(t => t.kind === 'audio').map(t => t.order)) - 1
    }
    state.value.tracks.push(track)
    touch()
  }

  function updateTrack(id: string, patch: Partial<Track>) {
    const i = state.value.tracks.findIndex(t => t.id === id)
    if (i < 0) return
    recordHistory(`track:${id}`)
    state.value.tracks[i] = { ...state.value.tracks[i], ...patch }
    touch()
  }

  // ---------- タイムライン (UI 状態, 履歴外) ----------

  function setPlayhead(t: number) {
    state.value.timeline.playhead = Math.max(0, Math.min(t, state.value.timeline.duration))
  }

  function setZoom(z: number) {
    state.value.timeline.zoom = Math.max(5, Math.min(500, z))
  }

  function extendDurationIfNeeded(t: number) {
    if (t > state.value.timeline.duration) {
      state.value.timeline.duration = Math.ceil(t + 5)
    }
  }

  function setDuration(d: number) {
    recordHistory('setDuration')
    state.value.timeline.duration = Math.max(5, d)
    touch()
  }

  // ---------- プロジェクト全体 ----------

  function touch() {
    state.value.meta.updatedAt = Date.now()
  }

  function renameProject(name: string) {
    recordHistory('rename')
    state.value.meta.name = name
    touch()
  }

  function updateProjectMeta(patch: Partial<ProjectState['meta']>) {
    recordHistory('projectMeta')
    state.value.meta = { ...state.value.meta, ...patch }
    touch()
  }

  /**
   * プロジェクト全体を置き換え (復元時に使用)。履歴はクリア。
   */
  function replaceState(newState: ProjectState) {
    revokeAllObjectURLs()
    state.value = newState
    historyManager.clear()
    bumpHistoryVersion()
  }

  function resetToEmpty() {
    revokeAllObjectURLs()
    state.value = makeEmptyProject()
    historyManager.clear()
    bumpHistoryVersion()
  }

  function serialize(): ProjectState {
    return JSON.parse(JSON.stringify(state.value))
  }

  async function getAssetURL(assetId: string): Promise<string | null> {
    return getAssetObjectURL(state.value.meta.id, assetId)
  }

  // ---------- 自動保存 / 起動時復元 ----------

  let autosaveTimer: number | null = null
  let autosaveSuspended = false
  let lastSavedAt = 0

  function scheduleAutosave() {
    if (autosaveSuspended) return
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer)
    autosaveTimer = window.setTimeout(async () => {
      autosaveTimer = null
      try {
        await saveProjectState(state.value)
        lastSavedAt = Date.now()
      } catch (err: any) {
        if (err?.name === 'QuotaExceededError') {
          toast.error('保存できる容量がいっぱいです (自動保存)')
        } else {
          // 連続エラー時のスパム防止: 最後の保存失敗から 10s 経過時のみ
          console.error('autosave error', err)
        }
      }
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  // state 全体を deep watch。巨大 state では重くなるので debounce 側で吸収
  watch(
    () => state.value,
    () => scheduleAutosave(),
    { deep: true }
  )

  function suspendAutosave() {
    autosaveSuspended = true
  }
  function resumeAutosave() {
    autosaveSuspended = false
  }

  async function bootstrap(): Promise<boolean> {
    try {
      const latest = await loadLatestProjectState()
      if (latest && latest.meta && latest.clips) {
        // 後方互換: 欠けているフィールドを初期化
        if (!latest.folders) latest.folders = []
        if (!latest.markers) latest.markers = []
        if (!latest.timeline.snapping) latest.timeline.snapping = true
        if (latest.timeline.rippleMode === undefined) latest.timeline.rippleMode = false
        if (latest.timeline.masterVolume === undefined) latest.timeline.masterVolume = 1
        state.value = latest
        historyManager.clear()
        bumpHistoryVersion()
        return true
      }
    } catch (err) {
      console.warn('bootstrap failed', err)
    }
    return false
  }

  // ---------- マーカー ----------

  function addMarker(time: number, label = 'マーカー', color = '#e8a838'): Marker {
    recordHistory('marker:add')
    const m: Marker = { id: nanoid(), time, label, color }
    if (!state.value.markers) state.value.markers = []
    state.value.markers.push(m)
    state.value.markers.sort((a, b) => a.time - b.time)
    touch()
    return m
  }

  function removeMarker(id: string) {
    if (!state.value.markers) return
    recordHistory('marker:del')
    state.value.markers = state.value.markers.filter(m => m.id !== id)
    touch()
  }

  function updateMarker(id: string, patch: Partial<Marker>) {
    if (!state.value.markers) return
    const i = state.value.markers.findIndex(m => m.id === id)
    if (i < 0) return
    recordHistory(`marker:upd:${id}`)
    state.value.markers[i] = { ...state.value.markers[i], ...patch }
    state.value.markers.sort((a, b) => a.time - b.time)
    touch()
  }

  // ---------- イン/アウト ----------

  function setInPoint(t: number | undefined) {
    recordHistory('inpoint')
    state.value.timeline.inPoint = t
    touch()
  }
  function setOutPoint(t: number | undefined) {
    recordHistory('outpoint')
    state.value.timeline.outPoint = t
    touch()
  }
  function clearInOut() {
    recordHistory('inout-clear')
    state.value.timeline.inPoint = undefined
    state.value.timeline.outPoint = undefined
    touch()
  }

  // ---------- スナップ / リップル ----------

  function toggleSnapping() {
    state.value.timeline.snapping = !state.value.timeline.snapping
    touch()
  }
  function toggleRipple() {
    state.value.timeline.rippleMode = !state.value.timeline.rippleMode
    touch()
  }

  function setMasterVolume(v: number) {
    state.value.timeline.masterVolume = Math.max(0, Math.min(2, v))
    touch()
  }

  /**
   * 指定時刻を、他クリップの境界/playhead/マーカー/ticks にスナップ。
   * 閾値 (秒) を超えたら元の time を返す。
   */
  function snapTime(
    t: number,
    threshold: number,
    ignoreClipIds: string[] = []
  ): number {
    if (!state.value.timeline.snapping) return t
    const candidates: number[] = [0, state.value.timeline.duration]
    candidates.push(state.value.timeline.playhead)
    if (state.value.timeline.inPoint != null)
      candidates.push(state.value.timeline.inPoint)
    if (state.value.timeline.outPoint != null)
      candidates.push(state.value.timeline.outPoint)
    for (const m of state.value.markers ?? []) candidates.push(m.time)
    for (const c of state.value.clips) {
      if (ignoreClipIds.includes(c.id)) continue
      candidates.push(c.start)
      candidates.push(c.start + c.duration)
    }
    let bestT = t
    let bestDelta = threshold
    for (const ct of candidates) {
      const d = Math.abs(ct - t)
      if (d < bestDelta) {
        bestDelta = d
        bestT = ct
      }
    }
    return bestT
  }

  // ---------- クリップのリンク ----------

  function linkClips(clipIds: string[]) {
    if (clipIds.length < 2) return
    recordHistory('link')
    const group = nanoid()
    for (const id of clipIds) {
      const i = state.value.clips.findIndex(c => c.id === id)
      if (i >= 0) {
        state.value.clips[i] = { ...state.value.clips[i], linkGroup: group }
      }
    }
    touch()
  }
  function unlinkClips(clipIds: string[]) {
    recordHistory('unlink')
    for (const id of clipIds) {
      const i = state.value.clips.findIndex(c => c.id === id)
      if (i >= 0) {
        const c = { ...state.value.clips[i] }
        delete c.linkGroup
        state.value.clips[i] = c
      }
    }
    touch()
  }

  function getLinkedClips(clipId: string): Clip[] {
    const c = state.value.clips.find(x => x.id === clipId)
    if (!c?.linkGroup) return [c].filter(Boolean) as Clip[]
    return state.value.clips.filter(x => x.linkGroup === c.linkGroup)
  }

  // ---------- リップル削除 ----------

  function rippleDelete(clipIds: string[]) {
    if (clipIds.length === 0) return
    recordHistory('ripple-del')
    const targets = state.value.clips.filter(c => clipIds.includes(c.id))
    if (targets.length === 0) return
    const cut = Math.min(...targets.map(c => c.start))
    const len = Math.max(...targets.map(c => c.start + c.duration)) - cut
    const set = new Set(clipIds)
    state.value.clips = state.value.clips
      .filter(c => !set.has(c.id))
      .map(c => (c.start >= cut + len ? { ...c, start: c.start - len } : c))
    touch()
  }

  // ---------- 形状クリップ ----------

  function addShapeClip(
    shape: ShapeKind,
    opts: { trackId?: string; start?: number } = {}
  ): ShapeClip {
    const trackId =
      opts.trackId ??
      tracks.value.find(t => t.kind === 'video')?.id ??
      state.value.tracks[0].id
    const start = opts.start ?? state.value.timeline.playhead
    recordHistory('shape:add')
    // 形状別の自然なアスペクト比で初期化 (line と arrow は横長、他は正方形)
    let defaultW = 0.3
    let defaultH = 0.3
    if (shape === 'line' || shape === 'arrow') {
      defaultW = 0.4
      defaultH = 0.06
    }
    const clip: ShapeClip = {
      id: nanoid(),
      kind: 'shape',
      trackId,
      start,
      duration: 3,
      opacity: 1,
      shape,
      x: 0.5,
      y: 0.5,
      width: defaultW,
      height: defaultH,
      rotation: 0,
      scale: 1,
      style: {
        fill: '#e8a838',
        stroke: undefined,
        strokeWidth: 0,
        cornerRadius: 0
      }
    }
    state.value.clips.push(clip)
    extendDurationIfNeeded(start + clip.duration)
    touch()
    return clip
  }

  // ---------- カラーグレード / クロマキー ----------

  function setColorGrade(clipId: string, grade: ColorGrade | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'video' && c.kind !== 'image') return
    recordHistory(`grade:${clipId}`)
    state.value.clips[idx] = { ...c, colorGrade: grade } as Clip
    touch()
  }
  function setChromaKey(clipId: string, ck: ChromaKey | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'video' && c.kind !== 'image') return
    recordHistory(`chroma:${clipId}`)
    state.value.clips[idx] = { ...c, chromaKey: ck } as Clip
    touch()
  }
  function setPixelEffects(clipId: string, fx: PixelEffects | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'video' && c.kind !== 'image') return
    recordHistory(`pixelfx:${clipId}`)
    state.value.clips[idx] = { ...c, pixelFx: fx } as Clip
    touch()
  }
  /**
   * プリセットを適用。effects / colorGrade / pixelFx を丸ごと差し替える
   * (= 一度クリアしてプリセットの内容をセット)。
   */
  function applyEffectPreset(clipId: string, presetId: string) {
    const preset = getPreset(presetId)
    if (!preset) return
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'video' && c.kind !== 'image') return
    recordHistory(`preset:${clipId}`)
    const clone = <T>(v: T | undefined): T | undefined =>
      v ? (JSON.parse(JSON.stringify(v)) as T) : undefined
    state.value.clips[idx] = {
      ...c,
      effects: clone(preset.effects),
      colorGrade: clone(preset.colorGrade),
      pixelFx: clone(preset.pixelFx)
    } as Clip
    touch()
  }
  function setTextDecor(clipId: string, decor: TextDecor | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'text') return
    recordHistory(`decor:${clipId}`)
    state.value.clips[idx] = { ...c, decor } as Clip
    touch()
  }
  function setTextAnim(clipId: string, anim: TextAnim | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'text') return
    recordHistory(`anim:${clipId}`)
    state.value.clips[idx] = { ...c, anim } as Clip
    touch()
  }
  function setBlendMode(clipId: string, mode: BlendMode | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    recordHistory(`blend:${clipId}`)
    state.value.clips[idx] = { ...state.value.clips[idx], blendMode: mode } as Clip
    touch()
  }
  function setAudioEQ(clipId: string, eq: AudioEQ | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'audio' && c.kind !== 'video') return
    recordHistory(`eq:${clipId}`)
    state.value.clips[idx] = { ...c, eq } as any
    touch()
  }

  // ---------- フォルダ ----------

  function addFolder(name: string, color?: string): AssetFolder {
    recordHistory('folder:add')
    const f: AssetFolder = { id: nanoid(), name, color, parentId: null }
    if (!state.value.folders) state.value.folders = []
    state.value.folders.push(f)
    touch()
    return f
  }
  function removeFolder(id: string) {
    if (!state.value.folders) return
    recordHistory('folder:del')
    state.value.folders = state.value.folders.filter(f => f.id !== id)
    for (const a of Object.values(state.value.assets)) {
      if (a.folderId === id) a.folderId = null
    }
    touch()
  }
  function renameFolder(id: string, name: string) {
    if (!state.value.folders) return
    const i = state.value.folders.findIndex(f => f.id === id)
    if (i < 0) return
    recordHistory(`folder:rename:${id}`)
    state.value.folders[i] = { ...state.value.folders[i], name }
    touch()
  }
  function moveAssetToFolder(assetId: string, folderId: string | null) {
    const a = state.value.assets[assetId]
    if (!a) return
    recordHistory(`asset:fold:${assetId}`)
    state.value.assets[assetId] = { ...a, folderId }
    touch()
  }

  return {
    state,
    meta,
    assets,
    tracks,
    clips,
    timeline,
    getClipsOnTrack,
    getAsset,
    getClip,
    addAssetFromFile,
    removeAsset,
    addClipFromAsset,
    addTextClip,
    updateClip,
    removeClip,
    removeClips,
    splitClipAt,
    splitSelectedAtPlayhead,
    duplicateClips,
    addClips,
    pasteClipsAtPlayhead,
    addKeyframe,
    removeKeyframe,
    currentEffectiveValue,
    setTransition,
    setEffects,
    addTrack,
    updateTrack,
    setPlayhead,
    setZoom,
    setDuration,
    renameProject,
    updateProjectMeta,
    replaceState,
    resetToEmpty,
    serialize,
    getAssetURL,
    // history
    canUndo,
    canRedo,
    undo,
    redo,
    recordHistory,
    // autosave
    bootstrap,
    suspendAutosave,
    resumeAutosave,
    lastSavedAt: () => lastSavedAt,
    // markers
    addMarker,
    removeMarker,
    updateMarker,
    // in/out
    setInPoint,
    setOutPoint,
    clearInOut,
    // snap/ripple
    toggleSnapping,
    toggleRipple,
    snapTime,
    setMasterVolume,
    // link
    linkClips,
    unlinkClips,
    getLinkedClips,
    rippleDelete,
    // shape
    addShapeClip,
    // grading
    setColorGrade,
    setChromaKey,
    setPixelEffects,
    applyEffectPreset,
    setTextDecor,
    setTextAnim,
    setBlendMode,
    setAudioEQ,
    // folders
    addFolder,
    removeFolder,
    renameFolder,
    moveAssetToFolder
  }
})

function guessMimeByName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  return 'application/octet-stream'
}
