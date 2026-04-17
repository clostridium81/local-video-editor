import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { ref, computed, watch } from 'vue'
import type {
  Asset,
  Clip,
  Keyframe,
  KeyframeableProperty,
  ProjectState,
  Track,
  VideoClip,
  ImageClip,
  AudioClip,
  TextClip,
  ClipEffects,
  Transition
} from '../types/project'
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

function makeEmptyProject(name = '無題のプロジェクト'): ProjectState {
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
    tracks: [
      { id: nanoid(), kind: 'video', name: 'V1', muted: false, locked: false, order: 1 },
      { id: nanoid(), kind: 'video', name: 'V2', muted: false, locked: false, order: 2 },
      { id: nanoid(), kind: 'audio', name: 'A1', muted: false, locked: false, order: 0 }
    ],
    clips: [],
    timeline: {
      playhead: 0,
      zoom: 50,
      duration: 60
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
      toast.warn(`対応していないファイル形式: ${file.name}`)
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
        toast.error(`ストレージ容量が不足しています: ${file.name}`)
      } else {
        toast.error(`素材の保存に失敗しました: ${file.name}`)
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
      toast.error('素材の削除に失敗しました')
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
    const trackId =
      opts.trackId ??
      tracks.value.find(t => t.kind === trackKind)?.id ??
      state.value.tracks[0].id

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
      text: 'テキスト',
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
      ;(rightBase as VideoClip | AudioClip).sourceIn =
        (c.sourceIn ?? 0) + localSplit
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
          toast.error('ストレージ容量が不足しています (自動保存失敗)')
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
    lastSavedAt: () => lastSavedAt
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
