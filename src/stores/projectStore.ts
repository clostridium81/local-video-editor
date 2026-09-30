import { defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { ref, computed, watch } from 'vue'
import type {
  Asset,
  Clip,
  Easing,
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
  AudioEQ,
  Crop,
  Mask,
  BgFill
} from '../types/project'
import type { SubtitleCue } from '../engine/subtitles'
import { getPreset } from '../engine/effectPresets'
import {
  saveAssetBlob,
  getAssetObjectURL,
  replaceSessionAssets,
  retainProjectAssets
} from '../persistence/assetStore'
import { detectAssetKind, extractMediaMeta } from '../persistence/mediaMeta'
import { historyManager } from './history'
import {
  insertKeyframe,
  removeKeyframeAt,
  splitAllKeyframes,
  findKeyframeAt
} from '../engine/keyframes'
import { setPath, valueAt } from '../engine/animatable'
import { toast } from '../composables/useToast'
import { contentSignature, isEmptyProject } from './backupSignature'
import { useClipboard } from '../composables/useClipboard'
import { useSelection } from '../composables/useSelection'
import { clearWaveformCache } from '../engine/waveform'
import { mapClipTimeToSource, splitSpeedCurve } from '../engine/frameTiming'
import { clearDuckCache } from '../engine/ducking'
import { getTextStyle, textStylePatch } from '../engine/textStyles'
import { canLoadFont, syncFonts } from '../persistence/fontRegistry'

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

// 何回編集したらバックアップ促進ウィンドウを出すか (履歴に積まれた新規操作の数)
const EDIT_PROMPT_THRESHOLD = 25

export const useProjectStore = defineStore('project', () => {
  const state = ref<ProjectState>(makeEmptyProject())
  const historyVersion = ref(0)
  const sessionVersion = ref(0)

  // フォント素材をブラウザに登録する (追加・削除・Undo・作品の切り替え/復元に追従)
  watch(
    () => [state.value.meta.id, sessionVersion.value, Object.values(state.value.assets).filter(a => a.kind === 'font').map(a => a.id).join()],
    () => {
      void syncFonts(state.value.meta.id, state.value.assets)
    },
    { immediate: true }
  )

  // 操作完了後に実行する。削除/Undo の途中で必要な Blob を解放しない。
  watch(() => [Object.keys(state.value.assets), historyVersion.value], () => {
    const retained = historyManager.retainedAssetIds()
    for (const id of Object.keys(state.value.assets)) retained.add(id)
    retainProjectAssets(state.value.meta.id, retained)
  }, { flush: 'post' })

  // 最後のバックアップ以降の編集回数と、促進ウィンドウの表示フラグ。
  // 自動保存を廃したため、手動バックアップを忘れないよう定期的に促す。
  const editsSinceBackup = ref(0)
  const shouldPromptBackup = ref(false)

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
    // record は「新しい履歴エントリを積んだか」を返す。
    // mergeKey でまとめられた連続変更 (ドラッグ等) は 1 回とカウントする。
    const isNewEntry = historyManager.record(state.value, mergeKey)
    bumpHistoryVersion()
    if (isNewEntry) {
      editsSinceBackup.value++
      if (editsSinceBackup.value >= EDIT_PROMPT_THRESHOLD) {
        shouldPromptBackup.value = true
      }
    }
  }

  /** 促進ウィンドウを閉じる (「後で」)。次の閾値まで再表示しない */
  function dismissBackupPrompt() {
    editsSinceBackup.value = 0
    shouldPromptBackup.value = false
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

  async function addAssetFromFile(file: File, expectedSession = sessionVersion.value): Promise<Asset | null> {
    if (expectedSession !== sessionVersion.value) return null
    const prepared = await prepareAsset(file, expectedSession)
    if (!prepared) return null
    recordHistory()
    state.value.assets[prepared.id] = prepared
    touch()
    return prepared
  }

  /**
   * File からメタデータを読み、素材本体をセッションに登録する (state には入れない)。
   * 呼び出し側が recordHistory() の後で state.assets に追加する。
   */
  async function prepareAsset(file: File, expectedSession: number): Promise<Asset | null> {
    const kind = detectAssetKind(file)
    if (!kind) {
      toast.warn(`この形式のファイルは使えません: ${file.name}`)
      return null
    }
    if (kind === 'font' && !(await canLoadFont(file))) {
      toast.warn(`フォントとして読み込めませんでした: ${file.name}`)
      return null
    }
    const assetId = nanoid()
    const mediaMeta = kind === 'font' ? {} : await extractMediaMeta(file, kind).catch(() => ({}))
    // メタデータ読み込み中に新規作成/復元した場合、前の操作を新しい作品に混ぜない。
    if (expectedSession !== sessionVersion.value) return null
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
      saveAssetBlob(state.value.meta.id, assetId, file)
    } catch {
      toast.error(`ファイルを追加できませんでした: ${file.name}`)
      return null
    }
    return asset
  }

  async function removeAsset(assetId: string) {
    if (!state.value.assets[assetId]) return
    recordHistory()
    state.value.clips = state.value.clips.filter(c => {
      if ('assetId' in c && c.assetId === assetId) return false
      return true
    })
    delete state.value.assets[assetId]
    // Blob は Undo/Redo からも参照されなくなった時点で解放する。
    touch()
  }

  // ---------- クリップの追加・操作 ----------

  function addClipFromAsset(
    assetId: string,
    opts: { trackId?: string; start?: number } = {}
  ): Clip | null {
    const asset = state.value.assets[assetId]
    if (!asset) return null

    // 配置先トラックが指定されていればその種別に従う。
    // 動画素材を音声トラックに置いた場合は「音声だけを使うクリップ」になる。
    let trackId = opts.trackId
    const explicitTrack = trackId
      ? state.value.tracks.find(t => t.id === trackId)
      : undefined
    if (trackId && !explicitTrack) return null
    // 音声トラックに置けるのは音声を持つ素材 (audio / video) だけ
    // フォントは書体として使う素材なのでタイムラインには置かない
    if (asset.kind === 'font') return null
    if (explicitTrack?.kind === 'audio' && asset.kind === 'image') return null
    if (explicitTrack?.kind === 'video' && asset.kind === 'audio') return null

    const trackKind =
      explicitTrack?.kind ?? (asset.kind === 'audio' ? 'audio' : 'video')
    // 適合トラックが無ければ自動で作る (例: video トラック全削除済みに image を投入)。
    // fallback で逆種別のトラック (例: audio に image) に置くと、タイムラインから
    // 消えたように見えてしまうのを防ぐ。
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
    if (trackKind === 'audio') {
      // 音声トラック: 素材が動画でも音声クリップとして扱う (映像は使わない)
      clip = {
        ...base,
        kind: 'audio',
        assetId,
        volume: 1
      } as AudioClip
    } else if (asset.kind === 'video') {
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
    } else {
      // ここに来るのは映像トラック + 画像素材のみ
      // (音声素材は上のガードで映像トラックに置けない)
      clip = {
        ...base,
        kind: 'image',
        assetId,
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotation: 0
      } as ImageClip
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
    const rightId = splitWithoutHistory(clipId, absoluteTime)
    touch()
    return rightId
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
    clips = clips.filter(c => !('assetId' in c) || !!state.value.assets[c.assetId])
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
  function currentEffectiveValue(
    clip: Clip,
    prop: KeyframeableProperty,
    at = state.value.timeline.playhead
  ): number {
    return valueAt(clip, prop, at - clip.start)
  }

  /**
   * 動かせる項目の値を「再生位置の値」として設定する。
   * - その項目にキーフレームがあり、再生位置がクリップ内なら、再生位置にキーを打つ
   *   (キーフレームがあると基準値を変えても画面が変わらず、操作が効かないように見えるため)
   * - それ以外は基準の値を変える
   * 複数の項目をまとめて 1 回の履歴にできる (mergeKey でドラッグ中をまとめる)。
   */
  function setAnimatable(clipId: string, values: Record<string, number>, mergeKey?: string) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    let c = state.value.clips[idx]
    const local = state.value.timeline.playhead - c.start
    const inClip = local >= 0 && local <= c.duration
    recordHistory(mergeKey ?? `anim:${clipId}:${Object.keys(values).join(',')}`)
    for (const [path, raw] of Object.entries(values)) {
      if (!Number.isFinite(raw)) continue
      // 範囲の丸めは描画時 (applyAnimatedProps) に行う。ここで丸めると、数値入力で
      // 範囲外にした値 (大きな回転など) がドラッグの瞬間に跳ねてしまう
      const value = raw
      const kfs = c.keyframes?.[path]
      if (kfs?.length && inClip) {
        const existing = findKeyframeAt(kfs, local)
        const next = insertKeyframe(kfs, {
          time: existing?.time ?? local,
          value,
          easing: existing?.easing ?? 'linear',
          ...(existing?.bezier ? { bezier: existing.bezier } : {})
        })
        c = { ...c, keyframes: { ...(c.keyframes ?? {}), [path]: next } }
      } else {
        const next = setPath(c, path, value)
        if (next) c = next
      }
    }
    state.value.clips[idx] = c
    extendDurationIfNeeded(c.start + c.duration)
    touch()
  }

  /** 再生位置のキーフレームの緩急を変える */
  function setKeyframeEasing(
    clipId: string,
    prop: KeyframeableProperty,
    time: number,
    easing: Easing,
    bezier?: [number, number, number, number]
  ) {
    const c = state.value.clips.find(x => x.id === clipId)
    const k = findKeyframeAt(c?.keyframes?.[prop], time)
    if (!c || !k) return
    const kf: Keyframe = { time: k.time, value: k.value, easing }
    if (easing === 'bezier') kf.bezier = bezier ?? k.bezier ?? [0.25, 0.1, 0.25, 1]
    // insertKeyframe は同時刻を置き換える (bezier を外す場合も新しいオブジェクトで上書き)
    const idx = state.value.clips.findIndex(x => x.id === clipId)
    recordHistory(`kfease:${clipId}:${prop}`)
    const list = (c.keyframes?.[prop] ?? []).map(x => (Math.abs(x.time - k.time) < 1e-4 ? kf : x))
    state.value.clips[idx] = { ...c, keyframes: { ...(c.keyframes ?? {}), [prop]: list } }
    touch()
  }

  /** 項目のキーフレームをすべて消す (現在の値を基準値として残す) */
  function clearKeyframes(clipId: string, prop: KeyframeableProperty) {
    const idx = state.value.clips.findIndex(x => x.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (!c.keyframes?.[prop]) return
    recordHistory()
    const v = valueAt(c, prop, state.value.timeline.playhead - c.start)
    const kfs = { ...c.keyframes }
    delete kfs[prop]
    let next: Clip = { ...c, keyframes: Object.keys(kfs).length ? kfs : undefined }
    next = setPath(next, prop, v) ?? next
    state.value.clips[idx] = next
    touch()
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

  /**
   * 同じトラックで「前のクリップにくっついている」全クリップに、入りの
   * トランジションをまとめて設定する (つなぎ目への一括適用)。
   * 長さは前後どちらのクリップにも収まるよう短くする。設定した数を返す。
   */
  function applyTransitionToTrack(trackId: string, transition: Transition): number {
    const onTrack = state.value.clips
      .filter(c => c.trackId === trackId && c.kind !== 'audio')
      .sort((a, b) => a.start - b.start)
    const targets: Array<{ id: string; duration: number }> = []
    for (let i = 1; i < onTrack.length; i++) {
      const prev = onTrack[i - 1]
      const cur = onTrack[i]
      // 隙間 / 重なりが 0.05 秒以内ならつなぎ目とみなす
      if (Math.abs(prev.start + prev.duration - cur.start) > 0.05) continue
      const limit = transition.overlap ? Math.min(prev.duration, cur.duration) : cur.duration
      targets.push({ id: cur.id, duration: Math.min(transition.duration, limit) })
    }
    if (targets.length === 0) return 0
    recordHistory()
    for (const { id, duration } of targets) {
      const idx = state.value.clips.findIndex(c => c.id === id)
      state.value.clips[idx] = { ...state.value.clips[idx], transitionIn: { ...transition, duration } }
    }
    touch()
    return targets.length
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
  function replaceState(newState: ProjectState, blobs: ReadonlyMap<string, Blob>) {
    for (const id of Object.keys(newState.assets)) {
      if (!blobs.has(id)) throw new Error(`復元する素材がありません: ${id}`)
    }
    replaceSessionAssets(newState.meta.id, blobs)
    state.value = newState
    sessionVersion.value++
    historyManager.clear()
    bumpHistoryVersion()
    useClipboard().clear()
    useSelection().clearSelection()
    clearWaveformCache()
    clearDuckCache()
    dismissBackupPrompt()
    // 切替先プロジェクトの最終バックアップ署名を読み直す
    loadBackupSig(newState.meta.id)
  }

  function resetToEmpty() {
    replaceState(makeEmptyProject(), new Map())
  }

  function serialize(): ProjectState {
    return JSON.parse(JSON.stringify(state.value))
  }

  async function getAssetURL(assetId: string): Promise<string | null> {
    return getAssetObjectURL(state.value.meta.id, assetId)
  }

  // 自動保存・起動時自動復元は廃止。データの保存/復元は手動バックアップ
  // (ZIP エクスポート/インポート) からのみ行う。

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

  // ---------- キャンバスサイズ (縦横比) ----------

  /**
   * 作品の画面サイズを変える。クリップの位置は 0..1 の正規化座標なので
   * そのまま新しい画面に対応する (画像/映像は新しい画面に contain フィット)。
   */
  function setCanvasSize(width: number, height: number) {
    const w = Math.max(16, Math.round(width / 2) * 2)
    const h = Math.max(16, Math.round(height / 2) * 2)
    if (w === state.value.meta.width && h === state.value.meta.height) return
    updateProjectMeta({ width: w, height: h })
  }

  // ---------- クロップ / マスク ----------

  function setCrop(clipId: string, crop: Crop | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'video' && c.kind !== 'image') return
    recordHistory(`crop:${clipId}`)
    state.value.clips[idx] = { ...c, crop } as Clip
    touch()
  }

  function setMask(clipId: string, mask: Mask | undefined) {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return
    const c = state.value.clips[idx]
    if (c.kind !== 'video' && c.kind !== 'image') return
    recordHistory(`mask:${clipId}`)
    state.value.clips[idx] = { ...c, mask } as Clip
    touch()
  }

  // ---------- 背景ぼかし塗り ----------

  /** 複数の動画/画像クリップに背景ぼかし塗りをまとめて設定 (undefined で解除) */
  function setBgFill(clipIds: string[], fill: BgFill | undefined): number {
    const ids = new Set(clipIds)
    const targets = state.value.clips.filter(c => ids.has(c.id) && (c.kind === 'video' || c.kind === 'image'))
    if (targets.length === 0) return 0
    recordHistory(targets.length === 1 ? `bgfill:${targets[0].id}` : undefined)
    state.value.clips = state.value.clips.map(c =>
      ids.has(c.id) && (c.kind === 'video' || c.kind === 'image')
        ? ({ ...c, bgFill: fill ? { ...fill } : undefined } as Clip)
        : c
    )
    touch()
    return targets.length
  }

  // ---------- テキストのスタイル集 ----------

  /** 複数のテキストクリップにスタイルをまとめて当てる (位置・内容は変えない) */
  function applyTextStyle(clipIds: string[], presetId: string): number {
    const preset = getTextStyle(presetId)
    if (!preset) return 0
    const ids = new Set(clipIds)
    const targets = state.value.clips.filter(c => ids.has(c.id) && c.kind === 'text')
    if (targets.length === 0) return 0
    recordHistory()
    state.value.clips = state.value.clips.map(c =>
      ids.has(c.id) && c.kind === 'text' ? ({ ...c, ...textStylePatch(preset) } as Clip) : c
    )
    touch()
    return targets.length
  }

  // ---------- フリーズフレーム ----------

  /**
   * 動画クリップの absoluteTime の画を静止画 (frameFile) として hold 秒挿入する。
   * - 動画クリップを absoluteTime で分割し、間に静止画クリップを置く
   * - absoluteTime 以降に始まるクリップ (全トラック) は hold 秒後ろへずらす
   * - 静止画クリップは元クリップの配置・エフェクト・切り抜き・マスクを引き継ぐ
   * 素材の追加も含めて 1 回の Undo で戻せる。
   */
  async function insertFreezeFrame(
    clipId: string,
    absoluteTime: number,
    frameFile: File,
    hold = 2
  ): Promise<ImageClip | null> {
    const session = sessionVersion.value
    const src = state.value.clips.find(c => c.id === clipId)
    if (!src || src.kind !== 'video') return null
    if (absoluteTime < src.start || absoluteTime > src.start + src.duration) return null
    const asset = await prepareAsset(frameFile, session)
    if (!asset) return null
    const cur = state.value.clips.find(c => c.id === clipId)
    if (!cur || cur.kind !== 'video') return null

    recordHistory()
    state.value.assets[asset.id] = asset
    const eps = 1e-6
    const t = absoluteTime
    const localSplit = t - cur.start

    // 分割 (境界ぴったりなら分割しない)
    let rightId: string | null = null
    if (localSplit > 0.01 && localSplit < cur.duration - 0.01) {
      rightId = splitWithoutHistory(cur.id, t)
    } else if (localSplit <= 0.01) {
      rightId = cur.id // 先頭で止める → クリップ全体を後ろへ
    }

    // t 以降に始まるクリップを後ろへ
    state.value.clips = state.value.clips.map(c =>
      c.start >= t - eps || c.id === rightId ? { ...c, start: c.start + hold } : c
    )

    const still: ImageClip = {
      id: nanoid(),
      kind: 'image',
      trackId: cur.trackId,
      assetId: asset.id,
      start: t,
      duration: hold,
      opacity: currentEffectiveValue(cur, 'opacity', t),
      x: currentEffectiveValue(cur, 'x', t),
      y: currentEffectiveValue(cur, 'y', t),
      scale: currentEffectiveValue(cur, 'scale', t),
      rotation: currentEffectiveValue(cur, 'rotation', t),
      blendMode: cur.blendMode,
      effects: clone(cur.effects),
      colorGrade: clone(cur.colorGrade),
      chromaKey: clone(cur.chromaKey),
      pixelFx: clone(cur.pixelFx),
      crop: clone(cur.crop),
      mask: clone(cur.mask)
    }
    state.value.clips.push(still)
    const end = Math.max(...state.value.clips.map(c => c.start + c.duration))
    extendDurationIfNeeded(end)
    touch()
    return still
  }

  /**
   * クリップを絶対時刻で分割する (履歴は積まない。splitClipAt や複合操作の内部用)。
   * キーフレームと速度カーブも境界で分け、右側の sourceIn は境界の素材時刻にする。
   */
  function splitWithoutHistory(clipId: string, absoluteTime: number): string | null {
    const idx = state.value.clips.findIndex(c => c.id === clipId)
    if (idx < 0) return null
    const c = state.value.clips[idx]
    const localSplit = absoluteTime - c.start
    const { left: leftKf, right: rightKf } = splitAllKeyframes(c.keyframes, localSplit)
    const curve = splitSpeedCurve(c.speedCurve, localSplit / c.duration)
    // 左側: 分割境界にはトランジション不要
    const leftClip: Clip = {
      ...c,
      duration: localSplit,
      keyframes: leftKf,
      speedCurve: curve.left,
      transitionOut: undefined
    }
    const right = {
      ...c,
      id: nanoid(),
      start: absoluteTime,
      duration: c.duration - localSplit,
      keyframes: rightKf,
      speedCurve: curve.right,
      transitionIn: undefined
    } as Clip
    if (right.kind === 'video' || right.kind === 'audio') {
      // タイムライン上で localSplit 秒進んだ間に素材が進んだ分 (speed / 速度カーブ込み)
      right.sourceIn = mapClipTimeToSource(c, absoluteTime)
    }
    state.value.clips.splice(idx, 1, leftClip, right)
    return right.id
  }

  // ---------- 字幕 (SRT / VTT) ----------

  /**
   * 字幕を新しい「字幕」トラックにテキストクリップとして並べる。
   * offset 秒ずらして配置する (通常は 0)。作成したクリップ数を返す。
   */
  function importSubtitles(cues: SubtitleCue[], offset = 0): number {
    const valid = cues.filter(c => c.text.trim() && c.end > c.start)
    if (valid.length === 0) return 0
    recordHistory()
    const topOrder = Math.max(0, ...state.value.tracks.filter(t => t.kind === 'video').map(t => t.order))
    const track: Track = {
      id: nanoid(),
      kind: 'video',
      name: '字幕',
      muted: false,
      locked: false,
      order: topOrder + 1
    }
    state.value.tracks.push(track)
    for (const cue of valid) {
      const clip: TextClip = {
        id: nanoid(),
        kind: 'text',
        trackId: track.id,
        start: Math.max(0, cue.start + offset),
        duration: cue.end - cue.start,
        opacity: 1,
        text: cue.text,
        fontFamily: "'Noto Sans JP'",
        fontSize: 56,
        color: '#ffffff',
        x: 0.5,
        y: 0.86,
        align: 'center',
        bold: true,
        italic: false,
        decor: { outline: { color: '#000000', width: 8 } }
      }
      state.value.clips.push(clip)
      extendDurationIfNeeded(clip.start + clip.duration)
    }
    touch()
    return valid.length
  }

  // ---------- バックアップ状態の追跡 ----------
  // 「最後に ZIP バックアップ (エクスポート/インポート) した内容」のハッシュを
  // localStorage に記録し、タブを閉じる際に未バックアップの編集があるかを判定する。
  //
  // フラグ方式ではなく「内容ハッシュの比較」にしているのは、変更検知の漏れを防ぐため。
  // どの操作経路で state が変わっても、閉じる瞬間に内容そのものを比べれば確実に
  // 差分を捕捉できる (個々の操作に dirty=true を立て忘れる余地がない)。
  // 署名の算出ロジックは backupSignature.ts (純粋関数, テスト対象) に切り出している。
  const BACKUP_HASH_PREFIX = 'lve.backupHash.v1:'

  // UI のインジケーター用に「最後のバックアップ署名」を reactive に保持する。
  // (beforeunload の最終判定は下の hasUnbackedUpChanges が localStorage を直読み
  //  するので、この ref がずれても閉じる際の警告は正確に出る)
  const lastBackupSig = ref<string | null>(null)

  function loadBackupSig(projectId: string) {
    try {
      lastBackupSig.value = localStorage.getItem(BACKUP_HASH_PREFIX + projectId)
    } catch {
      lastBackupSig.value = null
    }
  }
  loadBackupSig(state.value.meta.id)

  /**
   * 現在の (または渡された) 状態をバックアップ済みとして記録する。
   * exportBackup / importBackup の成功直後に呼ぶ。
   */
  function markBackedUp(snapshot?: ProjectState) {
    const s = snapshot ?? state.value
    const sig = contentSignature(s)
    try {
      localStorage.setItem(BACKUP_HASH_PREFIX + s.meta.id, sig)
    } catch {
      // localStorage が使えなくても動作は継続 (警告判定ができないだけ)
    }
    // 記録対象が現在開いているプロジェクトなら reactive 状態も更新
    if (s.meta.id === state.value.meta.id) lastBackupSig.value = sig
    // バックアップしたので編集カウントと促進フラグをリセット
    editsSinceBackup.value = 0
    shouldPromptBackup.value = false
  }

  /**
   * 最後のバックアップ以降に編集があるか。タブを閉じる際の警告判定に使う。
   * 空プロジェクト (何も作っていない) の場合は失うものがないので false。
   */
  function hasUnbackedUpChanges(): boolean {
    const s = state.value
    if (isEmptyProject(s)) return false
    let saved: string | null = null
    try {
      saved = localStorage.getItem(BACKUP_HASH_PREFIX + s.meta.id)
    } catch {
      // localStorage 不可時は「未バックアップ」とみなして警告する (安全側)
      return true
    }
    return saved !== contentSignature(s)
  }

  /**
   * UI バッジ用の reactive な未バックアップ判定。
   * contentSignature は playhead/zoom を読まないため、再生・ズームでは
   * 再評価されず、実質的な編集があったときだけ true になる。
   */
  const isDirtySinceBackup = computed(() => {
    const s = state.value
    if (isEmptyProject(s)) return false
    return contentSignature(s) !== lastBackupSig.value
  })

  return {
    state,
    sessionVersion,
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
    setAnimatable,
    setKeyframeEasing,
    clearKeyframes,
    setTransition,
    applyTransitionToTrack,
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
    // backup tracking
    markBackedUp,
    hasUnbackedUpChanges,
    editsSinceBackup,
    shouldPromptBackup,
    dismissBackupPrompt,
    isDirtySinceBackup,
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
    // v0.6
    setCanvasSize,
    setCrop,
    setMask,
    setBgFill,
    applyTextStyle,
    insertFreezeFrame,
    importSubtitles
  }
})

function clone<T>(v: T | undefined): T | undefined {
  return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as T)
}

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
  if (lower.endsWith('.ttf')) return 'font/ttf'
  if (lower.endsWith('.otf')) return 'font/otf'
  if (lower.endsWith('.woff2')) return 'font/woff2'
  if (lower.endsWith('.woff')) return 'font/woff'
  return 'application/octet-stream'
}
