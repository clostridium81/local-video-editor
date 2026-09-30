<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { useSelection } from '../composables/useSelection'
import type {
  Clip,
  VideoClip,
  ImageClip,
  TextClip,
  AudioClip,
  ShapeClip,
  ShapeKind,
  KeyframeableProperty,
  Easing,
  TransitionType,
  ClipEffects,
  Transition,
  BlendMode,
  ColorGrade,
  ChromaKey,
  PixelEffects,
  Duotone,
  TextDecor,
  TextAnim,
  TextAnimType,
  AudioEQ,
  Crop,
  Mask,
  MaskShape,
  SpeedPoint,
  BgFill,
  Karaoke,
  KaraokeMode
} from '../types/project'
import { findKeyframeAt, neighborKeyframes } from '../engine/keyframes'
import { EFFECT_PRESETS } from '../engine/effectPresets'
import { useLocale } from '../composables/useLocale'
import EffectSlider from './EffectSlider.vue'
import AnimSlider from './AnimSlider.vue'
import BezierEditor from './BezierEditor.vue'
import SpeedCurveEditor from './SpeedCurveEditor.vue'
import { clipSourceSpan, durationForSourceSpan, trimSpeedCurveRight } from '../engine/frameTiming'
import { animatableDef } from '../engine/animatable'
import { fontFamilyForAsset, fontDisplayName, assetIdFromFontFamily } from '../persistence/fontRegistry'
import { TEXT_STYLE_PRESETS, textStylePreviewCss } from '../engine/textStyles'
import { mapClipTimeToSource } from '../engine/frameTiming'
import { captureVideoFrame } from '../engine/frameCapture'
import { toast } from '../composables/useToast'

const { t } = useLocale()

const store = useProjectStore()
const selection = useSelection()

const selectedClip = computed<Clip | null>(() => {
  const id = selection.selectedClipId.value
  if (!id) return null
  return store.state.clips.find(c => c.id === id) ?? null
})

// 型ガード済みの computed
const videoOrImageClip = computed<VideoClip | ImageClip | null>(() => {
  const c = selectedClip.value
  return c && (c.kind === 'video' || c.kind === 'image') ? c : null
})
const textClip = computed<TextClip | null>(() => {
  const c = selectedClip.value
  return c && c.kind === 'text' ? c : null
})
const shapeClip = computed<ShapeClip | null>(() => {
  const c = selectedClip.value
  return c && c.kind === 'shape' ? c : null
})
const audioLikeClip = computed<VideoClip | AudioClip | null>(() => {
  const c = selectedClip.value
  return c && (c.kind === 'video' || c.kind === 'audio') ? c : null
})

const localPlayhead = computed(() => {
  const c = selectedClip.value
  if (!c) return 0
  return store.state.timeline.playhead - c.start
})

const playheadInClip = computed(() => {
  const c = selectedClip.value
  if (!c) return false
  const lt = localPlayhead.value
  return lt >= 0 && lt <= c.duration
})

const CORE_ANIM_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'] as const

/** 再生位置での値 (キーフレーム適用後)。入力欄の表示に使う */
function cv(prop: KeyframeableProperty): number {
  const c = selectedClip.value
  return c ? store.currentEffectiveValue(c, prop) : 0
}

function update(patch: Partial<Clip>) {
  const id = selection.selectedClipId.value
  if (!id) return
  // 開始時間の変更はリンクされたクリップにも同じ移動量を適用する
  // (タイムラインのドラッグ移動と同じ挙動に揃える)
  if (typeof patch.start === 'number') {
    const c = store.getClip(id)
    if (c) {
      const delta = patch.start - c.start
      const linked = store.getLinkedClips(id)
      if (delta !== 0 && linked.length > 1) {
        for (const l of linked) {
          store.updateClip(
            l.id,
            { start: Math.max(0, l.start + delta) } as any,
            `insp-start:${id}`
          )
        }
        return
      }
    }
  }
  // 位置・大きさ・回転・不透明度・音量にキーフレームがある場合は、基準値ではなく
  // 再生位置のキーとして設定する (基準値を変えても画面に反映されないため)
  {
    const c = store.getClip(id)
    const animatedKeys = CORE_ANIM_KEYS.filter(
      k => typeof (patch as any)[k] === 'number' && (c?.keyframes?.[k]?.length ?? 0) > 0
    )
    if (c && animatedKeys.length) {
      const values: Record<string, number> = {}
      for (const k of animatedKeys) {
        values[k] = (patch as any)[k]
        delete (patch as any)[k]
      }
      store.setAnimatable(id, values)
      if (Object.keys(patch).length === 0) return
    }
  }
  // 長さの変更は右端のトリムと同じく、速度カーブを伸縮させずに切り取り/延長する
  if (typeof patch.duration === 'number') {
    const c = store.getClip(id)
    if (c?.speedCurve) {
      ;(patch as any).speedCurve = trimSpeedCurveRight(c.speedCurve, c.duration, patch.duration)
    }
  }
  store.updateClip(id, patch as any)
}

function updateEffects(patch: Partial<ClipEffects>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).effects ?? {}
  store.setEffects(c.id, { ...prev, ...patch })
}

// 画面に映るクリップ (不透明度・位置 x/y を持つ)。図形も含む
function hasVisual(c: Clip): c is VideoClip | ImageClip | TextClip | ShapeClip {
  return (
    c.kind === 'video' ||
    c.kind === 'image' ||
    c.kind === 'text' ||
    c.kind === 'shape'
  )
}

// スケール・回転を持つクリップ (テキストは fontSize / 図形は width/height で
// サイズ管理するためスケールは対象外だが、回転は持つ)
function hasRotation(c: Clip): c is VideoClip | ImageClip | ShapeClip {
  return c.kind === 'video' || c.kind === 'image' || c.kind === 'shape'
}

function hasVolume(c: Clip): c is VideoClip | AudioClip {
  return c.kind === 'video' || c.kind === 'audio'
}

function hasEffects(c: Clip): c is VideoClip | ImageClip {
  return c.kind === 'video' || c.kind === 'image'
}

function fmtSec(s: number): string {
  return s.toFixed(2) + ' s'
}

// ---------- キーフレーム操作 ----------

function kfExistsAt(prop: KeyframeableProperty): boolean {
  const c = selectedClip.value
  if (!c) return false
  return !!findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
}

function toggleKeyframe(prop: KeyframeableProperty) {
  const c = selectedClip.value
  if (!c) return
  if (!playheadInClip.value) return
  const existing = findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
  if (existing) {
    store.removeKeyframe(c.id, prop, existing.time)
  } else {
    const value = store.currentEffectiveValue(c, prop)
    store.addKeyframe(c.id, prop, {
      time: localPlayhead.value,
      value,
      easing: 'linear'
    })
  }
}

function jumpToPrevKeyframe(prop: KeyframeableProperty) {
  const c = selectedClip.value
  if (!c) return
  const { prev } = neighborKeyframes(c.keyframes?.[prop], localPlayhead.value)
  if (prev) store.setPlayhead(c.start + prev.time)
}
function jumpToNextKeyframe(prop: KeyframeableProperty) {
  const c = selectedClip.value
  if (!c) return
  const { next } = neighborKeyframes(c.keyframes?.[prop], localPlayhead.value)
  if (next) store.setPlayhead(c.start + next.time)
}

function currentEasing(prop: KeyframeableProperty): Easing {
  const c = selectedClip.value
  if (!c) return 'linear'
  const k = findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
  return k?.easing ?? 'linear'
}

function setEasing(prop: KeyframeableProperty, easing: Easing) {
  const c = selectedClip.value
  if (!c) return
  const k = findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
  if (!k) return
  store.setKeyframeEasing(c.id, prop, k.time, easing)
}

function currentBezier(prop: KeyframeableProperty): [number, number, number, number] {
  const c = selectedClip.value
  const k = c ? findKeyframeAt(c.keyframes?.[prop], localPlayhead.value) : undefined
  return k?.bezier ?? [0.25, 0.1, 0.25, 1]
}

function setBezier(prop: KeyframeableProperty, v: [number, number, number, number]) {
  const c = selectedClip.value
  if (!c) return
  const k = findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
  if (!k) return
  store.setKeyframeEasing(c.id, prop, k.time, 'bezier', v)
}

// ---------- キーフレーム一覧 ----------

const EASINGS: Array<{ value: Easing; easy: string; normal: string }> = [
  { value: 'linear', easy: '一定の速さ', normal: 'リニア' },
  { value: 'easeIn', easy: 'だんだん速く', normal: 'イーズイン' },
  { value: 'easeOut', easy: 'だんだん遅く', normal: 'イーズアウト' },
  { value: 'easeInOut', easy: 'ゆっくり始まりゆっくり止まる', normal: 'イーズインアウト' },
  { value: 'easeInCubic', easy: 'だんだん速く (強め)', normal: 'イーズイン (強)' },
  { value: 'easeOutCubic', easy: 'だんだん遅く (強め)', normal: 'イーズアウト (強)' },
  { value: 'easeInOutCubic', easy: 'ゆっくり始まり止まる (強め)', normal: 'イーズインアウト (強)' },
  { value: 'back', easy: '少し行き過ぎて戻る', normal: 'バック' },
  { value: 'spring', easy: 'バネ (揺れて止まる)', normal: 'スプリング' },
  { value: 'bounce', easy: '弾んで止まる', normal: 'バウンス' },
  { value: 'elastic', easy: 'ゴムのように伸び縮み', normal: 'エラスティック' },
  { value: 'hold', easy: '動かさず急に切り替え', normal: 'ホールド' },
  { value: 'bezier', easy: 'カーブを自分で作る', normal: 'ベジェ (カスタム)' }
]

const BEZIER_PRESETS: Array<{ easy: string; normal: string; v: [number, number, number, number] }> = [
  { easy: 'なめらか', normal: 'ease', v: [0.25, 0.1, 0.25, 1] },
  { easy: 'シャープ', normal: 'expo', v: [0.87, 0, 0.13, 1] },
  { easy: '勢いよく止まる', normal: 'out-expo', v: [0.16, 1, 0.3, 1] },
  { easy: '溜めて飛び出す', normal: 'anticipate', v: [0.68, -0.6, 0.32, 1.6] }
]

/** キーフレームが付いている項目 (一覧に出す) */
const animatedProps = computed(() => {
  const c = selectedClip.value
  if (!c?.keyframes) return []
  return Object.keys(c.keyframes)
    .filter(p => (c.keyframes?.[p]?.length ?? 0) > 0)
    .map(p => {
      const def = animatableDef(p)
      return { path: p, label: def ? t(def.easy, def.normal) : p, count: c.keyframes![p]!.length }
    })
})

function clearAllKeyframes(prop: KeyframeableProperty) {
  const c = selectedClip.value
  if (c) store.clearKeyframes(c.id, prop)
}

// ---------- トランジション ----------

function setTransition(side: 'in' | 'out', tr: Transition | undefined) {
  const c = selectedClip.value
  if (!c) return
  store.setTransition(c.id, side, tr)
}

function applyFadePreset(side: 'in' | 'out') {
  // キビキビした印象になるよう既定は短め (以前は 0.5s で遅く感じた)
  setTransition(side, { type: 'fade', duration: 0.25 })
}

function clearTransition(side: 'in' | 'out') {
  setTransition(side, undefined)
}

// ---------- エフェクト ----------

function resetEffects() {
  const c = selectedClip.value
  if (!c || !hasEffects(c)) return
  store.setEffects(c.id, undefined)
}

// ---------- 速度 / 再生 / ブレンド ----------

function setSpeed(v: number) {
  const c = selectedClip.value
  if (!c) return
  store.updateClip(c.id, { speed: Math.max(0.125, Math.min(8, v)) } as any, `speed:${c.id}`)
}
function setBlendMode(m: BlendMode) {
  const c = selectedClip.value
  if (!c) return
  store.setBlendMode(c.id, m === 'normal' ? undefined : m)
}

// ---------- カラーグレード ----------

function updateGrade(patch: Partial<ColorGrade>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).colorGrade ?? {}
  store.setColorGrade(c.id, { ...prev, ...patch })
}
function resetGrade() {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  store.setColorGrade(c.id, undefined)
}

// ---------- クロマキー ----------

function updateChroma(patch: Partial<ChromaKey>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).chromaKey ?? {
    enabled: false,
    color: '#00ff00',
    threshold: 0.25,
    softness: 0.1,
    spillSuppress: 0.3
  }
  store.setChromaKey(c.id, { ...prev, ...patch })
}
function clearChroma() {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  store.setChromaKey(c.id, undefined)
}

// ---------- ピクセルエフェクト ----------

function updatePixelFx(patch: Partial<PixelEffects>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).pixelFx ?? {}
  store.setPixelEffects(c.id, { ...prev, ...patch })
}
function updateDuotone(patch: Partial<Duotone>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).pixelFx?.duotone ?? {
    enabled: false,
    shadow: '#1a1a4a',
    highlight: '#ffd98a'
  }
  updatePixelFx({ duotone: { ...prev, ...patch } })
}
function resetPixelFx() {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  store.setPixelEffects(c.id, undefined)
}

// ---------- プリセット ----------

function applyPreset(id: string) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  store.applyEffectPreset(c.id, id)
}

// ---------- テキスト装飾・アニメ ----------

function updateDecor(patch: Partial<TextDecor>) {
  const c = selectedClip.value
  if (!c || c.kind !== 'text') return
  const prev = (c as TextClip).decor ?? {}
  store.setTextDecor(c.id, { ...prev, ...patch })
}
function clearDecor() {
  const c = selectedClip.value
  if (!c || c.kind !== 'text') return
  store.setTextDecor(c.id, undefined)
}
function setAnim(type: TextAnimType, duration = 1) {
  const c = selectedClip.value
  if (!c || c.kind !== 'text') return
  if (type === 'none') store.setTextAnim(c.id, undefined)
  else store.setTextAnim(c.id, { type, duration })
}

// ---------- EQ ----------

function updateEQ(patch: Partial<AudioEQ>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'audio' && c.kind !== 'video')) return
  const prev = (c as AudioClip).eq ?? {}
  store.setAudioEQ(c.id, { ...prev, ...patch })
}

// ---------- 図形 ----------

function updateShape(patch: Partial<ShapeClip>) {
  const c = selectedClip.value
  if (!c || c.kind !== 'shape') return
  store.updateClip(c.id, patch as any)
}
function updateShapeStyle(patch: Partial<ShapeClip['style']>) {
  const c = selectedClip.value
  if (!c || c.kind !== 'shape') return
  const sc = c as ShapeClip
  store.updateClip(c.id, { style: { ...sc.style, ...patch } } as any)
}

// ---------- リンク ----------

function linkSelection() {
  const ids = selection.selectedClipIds.value
  if (ids.length >= 2) store.linkClips(ids)
}
function unlinkSelection() {
  const ids = selection.selectedClipIds.value
  if (ids.length > 0) store.unlinkClips(ids)
}

// ---------- トランジションの種類 ----------

interface TransitionOption {
  type: TransitionType
  inLabel: [string, string] // [やさしい, ふつう]
  outLabel: [string, string]
}

interface TransitionGroup {
  label: [string, string]
  options: TransitionOption[]
}

// メニューは分類ごとに optgroup で表示する (fade は先頭に別枠)
const TRANSITION_GROUPS: TransitionGroup[] = [
  {
    label: ['すべる', 'スライド'],
    options: [
      { type: 'slide-left', inLabel: ['右から入る', 'スライド (右から)'], outLabel: ['左へ出る', 'スライド (左へ)'] },
      { type: 'slide-right', inLabel: ['左から入る', 'スライド (左から)'], outLabel: ['右へ出る', 'スライド (右へ)'] },
      { type: 'slide-up', inLabel: ['下から入る', 'スライド (下から)'], outLabel: ['上へ出る', 'スライド (上へ)'] },
      { type: 'slide-down', inLabel: ['上から入る', 'スライド (上から)'], outLabel: ['下へ出る', 'スライド (下へ)'] }
    ]
  },
  {
    label: ['ふく (ワイプ)', 'ワイプ'],
    options: [
      { type: 'wipe', inLabel: ['左から拭う', 'ワイプ (左→右)'], outLabel: ['左へ拭って消える', 'ワイプ (右→左)'] },
      { type: 'wipe-rtl', inLabel: ['右から拭う', 'ワイプ (右→左)'], outLabel: ['右へ拭って消える', 'ワイプ (左→右)'] },
      { type: 'wipe-up', inLabel: ['下から拭う', 'ワイプ (下→上)'], outLabel: ['下へ拭って消える', 'ワイプ (上→下)'] },
      { type: 'wipe-down', inLabel: ['上から拭う', 'ワイプ (上→下)'], outLabel: ['上へ拭って消える', 'ワイプ (下→上)'] },
      { type: 'wipe-diag', inLabel: ['ななめに拭う', 'ワイプ (斜め)'], outLabel: ['ななめに拭って消える', 'ワイプ (斜め)'] },
      { type: 'split', inLabel: ['まん中から左右に開く', 'スプリット (横に開く)'], outLabel: ['左右から閉じる', 'スプリット (横に閉じる)'] },
      { type: 'split-v', inLabel: ['まん中から上下に開く', 'スプリット (縦に開く)'], outLabel: ['上下から閉じる', 'スプリット (縦に閉じる)'] },
      { type: 'blinds', inLabel: ['ブラインド (横じま)', 'ブラインド'], outLabel: ['ブラインド (横じま)', 'ブラインド'] },
      { type: 'checker', inLabel: ['いちまつ模様', 'チェッカー'], outLabel: ['いちまつ模様', 'チェッカー'] }
    ]
  },
  {
    label: ['かたち', 'シェイプ'],
    options: [
      { type: 'iris', inLabel: ['丸く開く', 'アイリス (開く)'], outLabel: ['丸く閉じる', 'アイリス (閉じる)'] },
      { type: 'diamond', inLabel: ['ひし形に開く', 'ダイヤ (開く)'], outLabel: ['ひし形に閉じる', 'ダイヤ (閉じる)'] },
      { type: 'heart', inLabel: ['ハート形に開く', 'ハート (開く)'], outLabel: ['ハート形に閉じる', 'ハート (閉じる)'] },
      { type: 'clock', inLabel: ['時計の針のように開く', 'クロックワイプ'], outLabel: ['時計の針のように消える', 'クロックワイプ'] }
    ]
  },
  {
    label: ['うごき', 'モーション'],
    options: [
      { type: 'zoom', inLabel: ['ズームイン (小→大)', 'ズームイン'], outLabel: ['ズームアウト (大→小)', 'ズームアウト'] },
      { type: 'zoom-out', inLabel: ['大きい状態から戻る', 'ズーム (拡大から)'], outLabel: ['大きくなって消える', 'ズーム (拡大へ)'] },
      { type: 'bounce', inLabel: ['ぽよんと弾んで出る', 'バウンス'], outLabel: ['弾んで消える', 'バウンス'] },
      { type: 'spin', inLabel: ['回りながら出る', 'スピン'], outLabel: ['回りながら消える', 'スピン'] },
      { type: 'flip-x', inLabel: ['横にくるっと裏返る', 'フリップ (横)'], outLabel: ['横に裏返って消える', 'フリップ (横)'] },
      { type: 'flip-y', inLabel: ['縦にくるっと裏返る', 'フリップ (縦)'], outLabel: ['縦に裏返って消える', 'フリップ (縦)'] },
      { type: 'shake', inLabel: ['ゆれて止まる', 'シェイク'], outLabel: ['ゆれ出す', 'シェイク'] }
    ]
  },
  {
    label: ['こうか', 'エフェクト'],
    options: [
      { type: 'blur', inLabel: ['ぼかしから出る', 'ブラー'], outLabel: ['ぼけて消える', 'ブラー'] },
      { type: 'zoom-blur', inLabel: ['近づきながらぼかしから', 'ズームブラー'], outLabel: ['近づきながらぼけて消える', 'ズームブラー'] },
      { type: 'flash', inLabel: ['白く光ってから出る', 'フラッシュ'], outLabel: ['白く光って終わる', 'フラッシュ'] },
      { type: 'pixelate', inLabel: ['モザイクから出る', 'ピクセレート'], outLabel: ['モザイクになって消える', 'ピクセレート'] },
      { type: 'glitch', inLabel: ['ノイズで乱れて出る', 'グリッチ'], outLabel: ['ノイズで乱れて消える', 'グリッチ'] }
    ]
  }
]

// 前のクリップ (同じトラックで終わりが開始位置にくっついているもの)
const prevAdjacentClip = computed<Clip | null>(() => {
  const c = selectedClip.value
  if (!c) return null
  return (
    store.state.clips.find(
      o => o.id !== c.id && o.trackId === c.trackId && Math.abs(o.start + o.duration - c.start) <= 0.05
    ) ?? null
  )
})

function setOverlap(on: boolean) {
  const c = selectedClip.value
  if (!c?.transitionIn) return
  setTransition('in', { ...c.transitionIn, overlap: on || undefined })
}

function applyInToTrack() {
  const c = selectedClip.value
  if (!c?.transitionIn) return
  const n = store.applyTransitionToTrack(c.trackId, c.transitionIn)
  if (n > 0) toast.success(t(`${n} か所の つなぎ目に 入れました`, `${n} か所のつなぎ目に適用しました`))
  else toast.info(t('くっついている クリップが ありません', '隣接したクリップがありません'))
}

// ---------- クロップ ----------

function updateCrop(patch: Partial<Crop>) {
  const c = videoOrImageClip.value
  if (!c) return
  const prev = c.crop ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const next = { ...prev, ...patch }
  const empty = next.left === 0 && next.top === 0 && next.right === 0 && next.bottom === 0
  store.setCrop(c.id, empty ? undefined : next)
}
function resetCrop() {
  const c = videoOrImageClip.value
  if (c) store.setCrop(c.id, undefined)
}

// ---------- マスク ----------

const MASK_SHAPES: Array<{ value: MaskShape | ''; easy: string; normal: string }> = [
  { value: '', easy: 'なし', normal: 'なし' },
  { value: 'rect', easy: '四角', normal: '矩形' },
  { value: 'ellipse', easy: '円', normal: '楕円' },
  { value: 'linear', easy: '線 (片側だけ残す)', normal: '線形' }
]

function setMaskShape(shape: MaskShape | '') {
  const c = videoOrImageClip.value
  if (!c) return
  if (!shape) {
    store.setMask(c.id, undefined)
    return
  }
  const prev: Mask = c.mask ?? {
    shape,
    x: 0.5,
    y: 0.5,
    width: 0.6,
    height: 0.6,
    rotation: 0,
    feather: 0.1,
    invert: false
  }
  store.setMask(c.id, { ...prev, shape })
}
function updateMask(patch: Partial<Mask>) {
  const c = videoOrImageClip.value
  if (!c?.mask) return
  store.setMask(c.id, { ...c.mask, ...patch })
}

// ---------- 音声フェード ----------

function updateAudioFade(side: 'in' | 'out', v: number) {
  const c = audioLikeClip.value
  if (!c) return
  const prev = c.audioFade ?? { in: 0, out: 0 }
  const half = c.duration / 2
  const next = { ...prev, [side]: Math.max(0, Math.min(half, v)) }
  store.updateClip(
    c.id,
    { audioFade: next.in > 0 || next.out > 0 ? next : undefined } as any,
    `afade:${c.id}`
  )
}

// ---------- 速度カーブ ----------

interface SpeedPreset {
  id: string
  easy: string
  normal: string
  points: Array<[number, number]>
}

const SPEED_PRESETS: SpeedPreset[] = [
  { id: 'montage', easy: 'モンタージュ', normal: 'モンタージュ', points: [[0, 1], [0.3, 3], [0.5, 0.5], [0.7, 3], [1, 1]] },
  { id: 'hero', easy: 'ヒーロー (途中でスロー)', normal: 'ヒーロー', points: [[0, 2], [0.4, 2], [0.5, 0.3], [0.6, 2], [1, 2]] },
  { id: 'bullet', easy: 'バレット (一瞬止まる)', normal: 'バレット', points: [[0, 1.5], [0.45, 1.5], [0.5, 0.15], [0.55, 1.5], [1, 1.5]] },
  { id: 'jump', easy: 'ジャンプカット', normal: 'ジャンプカット', points: [[0, 1], [0.4, 1], [0.45, 6], [0.55, 6], [0.6, 1], [1, 1]] },
  { id: 'flash-in', easy: 'はじめだけ速く', normal: 'フラッシュイン', points: [[0, 5], [0.25, 1], [1, 1]] },
  { id: 'flash-out', easy: 'おわりだけ速く', normal: 'フラッシュアウト', points: [[0, 1], [0.75, 1], [1, 5]] },
  { id: 'ramp-up', easy: 'だんだん速く', normal: '加速', points: [[0, 0.5], [1, 3]] },
  { id: 'ramp-down', easy: 'だんだん遅く', normal: '減速', points: [[0, 3], [1, 0.5]] }
]

function setSpeedCurve(points: SpeedPoint[] | undefined, dragging = false) {
  const c = audioLikeClip.value
  if (!c) return
  store.updateClip(
    c.id,
    { speedCurve: points && points.length >= 2 ? points : undefined } as any,
    dragging ? `speedcurve-drag:${c.id}` : `speedcurve:${c.id}:${Date.now()}`
  )
}
function applySpeedPreset(p: SpeedPreset) {
  setSpeedCurve(p.points.map(([x, speed]) => ({ x, speed })))
}
function startCustomCurve() {
  const c = audioLikeClip.value
  if (!c) return
  const s = c.speed ?? 1
  setSpeedCurve([{ x: 0, speed: s }, { x: 1, speed: s }])
}

/** 選択クリップが消費する素材の秒数と、素材に対する過不足 */
const sourceUsage = computed(() => {
  const c = audioLikeClip.value
  if (!c) return null
  const span = clipSourceSpan(c)
  const asset = store.getAsset(c.assetId)
  const remain = asset?.duration != null ? asset.duration - (c.sourceIn ?? 0) : null
  return { span, remain, over: remain != null && span > remain + 0.05 }
})

/** 素材の残りをちょうど使い切る長さにする (速度カーブは切り取り / 末尾の速度で延長) */
function fitDurationToSource() {
  const c = audioLikeClip.value
  const u = sourceUsage.value
  if (!c || !u || u.remain == null || u.span <= 0) return
  const newD = Math.max(0.1, durationForSourceSpan(c, u.remain))
  store.updateClip(c.id, {
    duration: newD,
    ...(c.speedCurve ? { speedCurve: trimSpeedCurveRight(c.speedCurve, c.duration, newD) } : {})
  } as any)
}

// ---------- 背景ぼかし塗り ----------

const DEFAULT_BG_FILL: BgFill = { blur: 40, dim: 0.15 }

function setBgFillEnabled(on: boolean) {
  const c = videoOrImageClip.value
  if (!c) return
  store.setBgFill([c.id], on ? { ...DEFAULT_BG_FILL } : undefined)
}
function updateBgFill(patch: Partial<BgFill>) {
  const c = videoOrImageClip.value
  if (!c?.bgFill) return
  store.setBgFill([c.id], { ...c.bgFill, ...patch })
}
function applyBgFillToAll() {
  const c = videoOrImageClip.value
  if (!c?.bgFill) return
  const ids = store.state.clips.filter(x => x.kind === 'video' || x.kind === 'image').map(x => x.id)
  const n = store.setBgFill(ids, c.bgFill)
  toast.success(t(`${n} 個の クリップに 入れました`, `${n} 件のクリップに適用しました`))
}

// ---------- ダッキング ----------

function setDucking(amount: number | null) {
  const c = selectedClip.value
  if (!c || c.kind !== 'audio') return
  store.updateClip(
    c.id,
    { ducking: amount && amount > 0 ? { amount } : undefined } as any,
    `duck:${c.id}`
  )
}

// ---------- フォント ----------

const fontAssets = computed(() => Object.values(store.assets).filter(a => a.kind === 'font'))
/** 選択中のテキストが、削除済みのフォント素材を指しているか */
const missingFont = computed(() => {
  const c = textClip.value
  if (!c) return false
  const id = assetIdFromFontFamily(c.fontFamily)
  return !!id && !store.assets[id]
})

// ---------- 単語ハイライト字幕 ----------

const KARAOKE_MODES: Array<{ value: KaraokeMode; easy: string; normal: string }> = [
  { value: 'pop', easy: '今の単語を大きく・色付き (TikTok 風)', normal: 'ポップ' },
  { value: 'fill', easy: '左から色が塗られる (カラオケ)', normal: 'フィル' },
  { value: 'color', easy: '読んだ所の色が変わる', normal: 'カラー' },
  { value: 'box', easy: '今の単語に色の箱', normal: 'ボックス' },
  { value: 'reveal', easy: '読んだ所まで表示する', normal: 'リビール' }
]

/** 単語ハイライトの設定を変える (null で解除、{} で既定値を入れて有効化) */
function setKaraoke(patch: Partial<Karaoke> | null) {
  const c = textClip.value
  if (!c) return
  if (patch === null) {
    store.updateClip(c.id, { karaoke: undefined } as any)
    return
  }
  const prev: Karaoke = c.karaoke ?? { mode: 'pop', color: '#ffe14d', lead: 0, tail: 0.2 }
  store.updateClip(c.id, { karaoke: { ...prev, ...patch } } as any, `karaoke:${c.id}`)
}

// ---------- テキストのスタイル集 ----------

const styleWholeTrack = ref(false)

function applyTextStyle(presetId: string) {
  const c = selectedClip.value
  if (!c || c.kind !== 'text') return
  const ids = styleWholeTrack.value
    ? store.state.clips.filter(x => x.kind === 'text' && x.trackId === c.trackId).map(x => x.id)
    : [c.id]
  const n = store.applyTextStyle(ids, presetId)
  if (n > 1) toast.success(t(`${n} 個の 文字に 当てました`, `${n} 件のテキストに適用しました`))
}

// ---------- フリーズフレーム ----------

const freezeHold = ref(2)
const freezing = ref(false)

async function freezeFrame() {
  const c = selectedClip.value
  if (!c || c.kind !== 'video' || freezing.value) return
  const at = store.state.timeline.playhead
  if (at < c.start || at > c.start + c.duration) {
    toast.warn(t('再生位置をこのクリップの上に動かしてください', '再生ヘッドをクリップ内に移動してください'))
    return
  }
  freezing.value = true
  try {
    const url = await store.getAssetURL(c.assetId)
    if (!url) throw new Error('素材が見つかりません')
    const blob = await captureVideoFrame(url, mapClipTimeToSource(c, at))
    const asset = store.getAsset(c.assetId)
    const base = (asset?.name ?? 'frame').replace(/\.[^.]+$/, '')
    const file = new File([blob], `${base}_freeze_${at.toFixed(2)}s.png`, { type: 'image/png' })
    const still = await store.insertFreezeFrame(c.id, at, file, Math.max(0.1, freezeHold.value))
    if (still) {
      selection.selectClip(still.id)
      toast.success(t('止まった画面を入れました', 'フリーズフレームを挿入しました'))
    }
  } catch (e: any) {
    console.error(e)
    toast.error(t('止まった画面を作れませんでした: ', 'フリーズフレームの作成に失敗しました: ') + (e?.message ?? ''))
  } finally {
    freezing.value = false
  }
}

const BLEND_MODES: BlendMode[] = [
  'normal','multiply','screen','overlay','darken','lighten',
  'color-dodge','color-burn','hard-light','soft-light',
  'difference','exclusion','hue','saturation','color','luminosity','add'
]

const TEXT_ANIMS: TextAnimType[] = [
  'none','typewriter','fade-words','slide-chars','bounce','scale-pop','wave'
]

const SHAPE_KINDS: ShapeKind[] = ['rect','ellipse','triangle','star','arrow','line']

function blendLabelJa(m: BlendMode): string {
  const easy: Record<BlendMode, string> = {
    normal: '通常',
    multiply: '乗算 (重ねて暗く)',
    screen: 'スクリーン (重ねて明るく)',
    overlay: 'オーバーレイ (上に重ねる)',
    darken: '比較 (暗)',
    lighten: '比較 (明)',
    'color-dodge': '覆い焼き (明るく)',
    'color-burn': '焼き込み (暗く)',
    'hard-light': 'ハードライト (強い光)',
    'soft-light': 'ソフトライト (柔らかい光)',
    difference: '差の絶対値',
    exclusion: '除外',
    hue: '色相のみ',
    saturation: '彩度のみ',
    color: '色のみ',
    luminosity: '明るさのみ',
    add: '加算',
    subtract: '減算'
  }
  const norm: Record<BlendMode, string> = {
    normal: '通常',
    multiply: '乗算',
    screen: 'スクリーン',
    overlay: 'オーバーレイ',
    darken: '比較 (暗)',
    lighten: '比較 (明)',
    'color-dodge': '覆い焼き',
    'color-burn': '焼き込み',
    'hard-light': 'ハードライト',
    'soft-light': 'ソフトライト',
    difference: '差の絶対値',
    exclusion: '除外',
    hue: '色相',
    saturation: '彩度',
    color: 'カラー',
    luminosity: '輝度',
    add: '加算',
    subtract: '減算'
  }
  return t(easy[m] ?? m, norm[m] ?? m)
}

function animLabelJa(a: TextAnimType): string {
  const easy: Record<TextAnimType, string> = {
    none: 'なし',
    typewriter: 'タイプライター (1文字ずつ)',
    'fade-words': 'フェード (じわっと表示)',
    'slide-chars': 'スライド (下から表示)',
    bounce: 'バウンド (弾む)',
    'scale-pop': 'ポップ (跳び出す)',
    wave: 'ウェーブ (波打つ)'
  }
  const norm: Record<TextAnimType, string> = {
    none: 'なし',
    typewriter: 'タイプライター',
    'fade-words': 'フェード',
    'slide-chars': 'スライド',
    bounce: 'バウンド',
    'scale-pop': 'スケールポップ',
    wave: 'ウェーブ'
  }
  return t(easy[a] ?? a, norm[a] ?? a)
}

function shapeLabelJa(s: ShapeKind): string {
  const easy: Record<ShapeKind, string> = {
    rect: '四角', ellipse: '円', triangle: '三角',
    star: '星', arrow: '矢印', line: '線'
  }
  const norm: Record<ShapeKind, string> = {
    rect: '矩形', ellipse: '楕円', triangle: '三角形',
    star: '星', arrow: '矢印', line: '線'
  }
  return t(easy[s] ?? s, norm[s] ?? s)
}

function kindNameJa(kind: string): string {
  if (kind === 'video') return t('動画', '動画')
  if (kind === 'audio') return t('音声', '音声')
  if (kind === 'image') return t('画像', '画像')
  if (kind === 'text') return t('テキスト', 'テキスト')
  if (kind === 'shape') return t('図形', '図形')
  return kind
}
</script>

<template>
  <div class="panel-title">
    <span>Inspector</span>
  </div>

  <div class="inspector-body">
    <div v-if="!selectedClip" class="empty">
      <div class="empty-icon">◇</div>
      <div class="empty-text">{{ t('クリップを選んでください', 'クリップを選択してください') }}</div>
    </div>

    <template v-else>
      <section class="section">
        <div class="kind-badge" :class="'k-' + selectedClip.kind">
          {{ kindNameJa(selectedClip.kind) }}
        </div>
      </section>

      <!-- 時間プロパティ -->
      <section class="section">
        <div class="section-head">{{ t('時間', '時間') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>{{ t('開始', '開始') }}</span>
            <input
              type="number"
              step="0.01"
              :value="selectedClip.start.toFixed(2)"
              @change="(e) => update({ start: Math.max(0, Number((e.target as HTMLInputElement).value)) })"
            />
          </label>
          <label class="field">
            <span>{{ t('長さ', '長さ') }}</span>
            <input
              type="number"
              step="0.01"
              :value="selectedClip.duration.toFixed(2)"
              @change="(e) => update({ duration: Math.max(0.1, Number((e.target as HTMLInputElement).value)) })"
            />
          </label>
          <label
            v-if="selectedClip.kind === 'video' || selectedClip.kind === 'audio'"
            class="field"
          >
            <span>{{ t('素材の開始位置', '素材内オフセット') }}</span>
            <input
              type="number"
              step="0.01"
              :value="(selectedClip.sourceIn ?? 0).toFixed(2)"
              @change="(e) => update({ sourceIn: Math.max(0, Number((e.target as HTMLInputElement).value)) })"
            />
          </label>
          <div class="field">
            <span>{{ t('終了', '終了') }}</span>
            <div class="value mono">{{ fmtSec(selectedClip.start + selectedClip.duration) }}</div>
          </div>
        </div>
      </section>

      <!-- 不透明度 -->
      <section v-if="hasVisual(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('表示', '表示') }}</span>
          <button
            class="kf-btn"
            :class="{ on: kfExistsAt('opacity') }"
            :disabled="!playheadInClip"
            :title="t('この位置にキーフレームを追加/削除', 'この時刻にキーフレームを追加/削除')"
            @click="toggleKeyframe('opacity')"
          >◆</button>
        </div>
        <label class="field">
          <span>
            {{ t('透明度', '不透明度') }}
            <span class="mono muted">{{ (cv('opacity') * 100).toFixed(0) }}%</span>
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="cv('opacity')"
            @input="(e) => update({ opacity: Number((e.target as HTMLInputElement).value) })"
          />
        </label>
      </section>

      <!-- 配置 -->
      <section v-if="hasVisual(selectedClip)" class="section">
        <div class="section-head">{{ t('配置', '配置') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>
              {{ t('横位置 (中央=0.5)', 'X (中央基準)') }}
              <button
                class="kf-btn inline"
                :class="{ on: kfExistsAt('x') }"
                :disabled="!playheadInClip"
                @click="toggleKeyframe('x')"
              >◆</button>
            </span>
            <input
              type="number"
              step="0.01"
              :value="cv('x').toFixed(3)"
              @change="(e) => update({ x: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>
              {{ t('縦位置 (中央=0.5)', 'Y (中央基準)') }}
              <button
                class="kf-btn inline"
                :class="{ on: kfExistsAt('y') }"
                :disabled="!playheadInClip"
                @click="toggleKeyframe('y')"
              >◆</button>
            </span>
            <input
              type="number"
              step="0.01"
              :value="cv('y').toFixed(3)"
              @change="(e) => update({ y: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
        <div
          v-if="hasRotation(selectedClip)"
          class="grid-2"
        >
          <!-- スケール: 図形は width/height でサイズ管理するため出さない -->
          <label v-if="selectedClip.kind === 'video' || selectedClip.kind === 'image'" class="field">
            <span>
              {{ t('大きさ', 'スケール') }}
              <button
                class="kf-btn inline"
                :class="{ on: kfExistsAt('scale') }"
                :disabled="!playheadInClip"
                @click="toggleKeyframe('scale')"
              >◆</button>
            </span>
            <input
              type="number"
              step="0.01"
              :value="cv('scale').toFixed(2)"
              @change="(e) => update({ scale: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>
              {{ t('回転 (度)', '回転 (度)') }}
              <button
                class="kf-btn inline"
                :class="{ on: kfExistsAt('rotation') }"
                :disabled="!playheadInClip"
                @click="toggleKeyframe('rotation')"
              >◆</button>
            </span>
            <input
              type="number"
              step="1"
              :value="cv('rotation')"
              @change="(e) => update({ rotation: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
      </section>

      <!-- キーフレーム (動き) の一覧と緩急 -->
      <section v-if="animatedProps.length" class="section">
        <div class="section-head">{{ t('キーフレーム (動き)', 'キーフレーム') }}</div>
        <div v-for="ap in animatedProps" :key="ap.path" class="kf-item">
          <div class="kf-line">
            <span class="kf-name">{{ ap.label }}</span>
            <span class="muted mono">◆{{ ap.count }}</span>
            <button class="ghost tiny" :title="t('前のキーフレームへ', '前のキーへ')" @click="jumpToPrevKeyframe(ap.path)">◀</button>
            <button class="ghost tiny" :title="t('次のキーフレームへ', '次のキーへ')" @click="jumpToNextKeyframe(ap.path)">▶</button>
            <button class="ghost tiny" :title="t('この項目のキーフレームを全部消す', 'キーフレームをすべて削除')" @click="clearAllKeyframes(ap.path)">×</button>
          </div>
          <template v-if="kfExistsAt(ap.path)">
            <label class="field">
              <span>{{ t('ここまでの動き方 (緩急)', 'このキーまでの補間') }}</span>
              <select
                :value="currentEasing(ap.path)"
                @change="(e) => setEasing(ap.path, (e.target as HTMLSelectElement).value as Easing)"
              >
                <option v-for="ez in EASINGS" :key="ez.value" :value="ez.value">{{ t(ez.easy, ez.normal) }}</option>
              </select>
            </label>
            <template v-if="currentEasing(ap.path) === 'bezier'">
              <BezierEditor
                :value="currentBezier(ap.path)"
                @change="(v) => setBezier(ap.path, v)"
              />
              <div class="row gap-4 bezier-presets">
                <button
                  v-for="bp in BEZIER_PRESETS"
                  :key="bp.normal"
                  class="ghost tiny"
                  @click="setBezier(ap.path, bp.v)"
                >{{ t(bp.easy, bp.normal) }}</button>
              </div>
            </template>
          </template>
        </div>
        <div class="section-hint">
          {{ t(
            '※ 各項目の ◆ で、今の位置にキーフレームを付けたり消したりできます。キーフレームがある項目を動かすと、今の位置のキーが変わります',
            '※ 各項目の ◆ でキーを追加/削除。キーのある項目を変更すると再生位置のキーが更新されます'
          ) }}
        </div>
      </section>

      <!-- テキスト固有 -->
      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">{{ t('文字のスタイル (ワンタッチ)', 'スタイル') }}</div>
        <div class="style-grid">
          <button
            v-for="p in TEXT_STYLE_PRESETS"
            :key="p.id"
            class="style-chip"
            :title="t(p.labelEasy, p.labelNormal)"
            @click="applyTextStyle(p.id)"
          >
            <span class="style-sample" :style="textStylePreviewCss(p)">Aあ</span>
            <span class="style-name">{{ t(p.labelEasy, p.labelNormal) }}</span>
          </button>
        </div>
        <label class="toggle">
          <input v-model="styleWholeTrack" type="checkbox" />
          <span>{{ t('同じトラックの文字すべてに当てる (字幕向け)', '同じトラックのテキストすべてに適用') }}</span>
        </label>
        <div class="section-hint">
          {{ t('※ 書体・色・ふち・影がまとめて変わります (位置と文字はそのまま)', '※ 書体・色・装飾を置き換えます (位置・内容は維持)') }}
        </div>
      </section>

      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">{{ t('文字', 'テキスト') }}</div>
        <label class="field">
          <span>{{ t('内容', '内容') }}</span>
          <textarea
            rows="3"
            :value="(selectedClip as TextClip).text"
            @input="(e) => update({ text: (e.target as HTMLTextAreaElement).value })"
          />
        </label>
        <label class="field">
          <span>フォント (書体)</span>
          <select
            :value="(selectedClip as TextClip).fontFamily"
            @change="(e) => update({ fontFamily: (e.target as HTMLSelectElement).value })"
          >
            <option value="sans-serif">sans-serif</option>
            <option value="serif">serif</option>
            <option value="'IBM Plex Sans'">IBM Plex Sans</option>
            <option value="'IBM Plex Mono'">IBM Plex Mono</option>
            <option value="'Instrument Serif'">Instrument Serif</option>
            <option value="'Noto Sans JP'">Noto Sans JP</option>
            <option value="'Noto Serif JP'">Noto Serif JP</option>
            <optgroup v-if="fontAssets.length" :label="t('読み込んだフォント', '追加したフォント')">
              <option v-for="fa in fontAssets" :key="fa.id" :value="fontFamilyForAsset(fa.id)">{{ fontDisplayName(fa) }}</option>
            </optgroup>
            <option
              v-if="missingFont"
              :value="(selectedClip as TextClip).fontFamily"
            >{{ t('(消したフォント)', '(削除済みのフォント)') }}</option>
          </select>
          <span class="section-hint">
            {{ t('.ttf / .otf / .woff のフォントを素材に追加すると、ここで選べます', 'フォントファイル (.ttf/.otf/.woff) を素材に追加すると選択肢に出ます') }}
          </span>
        </label>
        <div class="grid-2">
          <AnimSlider :clip="selectedClip" path="fontSize" label="文字の大きさ" />
          <label class="field">
            <span>そろえ方</span>
            <select
              :value="(selectedClip as TextClip).align"
              @change="(e) => update({ align: (e.target as HTMLSelectElement).value as any })"
            >
              <option value="left">左揃え</option>
              <option value="center">中央揃え</option>
              <option value="right">右揃え</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label class="field">
            <span>文字の色</span>
            <input
              type="color"
              :value="(selectedClip as TextClip).color"
              @input="(e) => update({ color: (e.target as HTMLInputElement).value })"
            />
          </label>
          <label class="field">
            <span>背景の色</span>
            <div class="row gap-4">
              <input
                type="color"
                :value="(selectedClip as TextClip).backgroundColor ?? '#000000'"
                @input="(e) => update({ backgroundColor: (e.target as HTMLInputElement).value })"
              />
              <button
                class="ghost"
                @click="update({ backgroundColor: undefined })"
              >なし</button>
            </div>
          </label>
        </div>
        <div class="row gap-4">
          <label class="toggle">
            <input
              type="checkbox"
              :checked="(selectedClip as TextClip).bold"
              @change="(e) => update({ bold: (e.target as HTMLInputElement).checked })"
            />
            <span>太字</span>
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              :checked="(selectedClip as TextClip).italic"
              @change="(e) => update({ italic: (e.target as HTMLInputElement).checked })"
            />
            <span>斜体</span>
          </label>
        </div>
      </section>

      <!-- 音量 -->
      <section v-if="hasVolume(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('音声', '音声') }}</span>
          <button
            class="kf-btn"
            :class="{ on: kfExistsAt('volume') }"
            :disabled="!playheadInClip"
            @click="toggleKeyframe('volume')"
          >◆</button>
        </div>
        <label class="field">
          <span>
            {{ t('音量', '音量') }} <span class="mono muted">{{ (cv('volume') * 100).toFixed(0) }}%</span>
          </span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.01"
            :value="cv('volume')"
            @input="(e) => update({ volume: Number((e.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="!!selectedClip.muted"
            @change="(e) => update({ muted: (e.target as HTMLInputElement).checked })"
          />
          <span>おとを けす</span>
        </label>
        <div class="sub-title">{{ t('音のフェード (だんだん大きく/小さく)', 'オーディオフェード') }}</div>
        <div class="grid-2">
          <EffectSlider
            :label="t('はじめ (秒)', 'フェードイン (秒)')"
            :value="selectedClip.audioFade?.in ?? 0"
            :min="0" :max="Math.min(10, selectedClip.duration / 2)" :step="0.05"
            @change="(v) => updateAudioFade('in', v)"
          />
          <EffectSlider
            :label="t('おわり (秒)', 'フェードアウト (秒)')"
            :value="selectedClip.audioFade?.out ?? 0"
            :min="0" :max="Math.min(10, selectedClip.duration / 2)" :step="0.05"
            @change="(v) => updateAudioFade('out', v)"
          />
        </div>
        <div v-if="selectedClip.kind === 'video'" class="section-hint">
          {{ t(
            '※ 映像のトランジションとは別に、音だけをフェードします',
            '※ 映像のトランジションとは独立して音量だけに掛かります'
          ) }}
        </div>
        <template v-if="selectedClip.kind === 'audio'">
          <label class="toggle duck-toggle">
            <input
              type="checkbox"
              :checked="!!selectedClip.ducking"
              @change="(e) => setDucking((e.target as HTMLInputElement).checked ? 0.7 : null)"
            />
            <span>{{ t('話し声などが鳴る間、自動で小さくする (BGM 向け)', '自動ダッキング (BGM 用)') }}</span>
          </label>
          <template v-if="selectedClip.ducking">
            <EffectSlider
              :label="t('下げる量', '下げる量')"
              :value="selectedClip.ducking.amount"
              :min="0.1" :max="1" :step="0.05"
              @change="(v) => setDucking(v)"
            />
            <div class="section-hint">
              {{ t(
                `※ 他の音が鳴っている間は ${Math.round((1 - selectedClip.ducking.amount) * 100)}% の音量になります`,
                `※ 他のクリップの音 (動画の音声・ナレーション等) が鳴る間、音量を ${Math.round((1 - selectedClip.ducking.amount) * 100)}% に下げます`
              ) }}
            </div>
          </template>
        </template>
      </section>

      <!-- プリセット (ワンタッチ) -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">{{ t('プリセット (ワンタッチ)', 'プリセット') }}</div>
        <div class="preset-grid">
          <button
            v-for="p in EFFECT_PRESETS"
            :key="p.id"
            class="preset-chip"
            @click="applyPreset(p.id)"
          >{{ t(p.labelEasy, p.labelNormal) }}</button>
        </div>
        <div class="section-hint">
          {{ t(
            '※ 選ぶと、下のエフェクト・カラーグレード・特殊効果がまとめて置き換わります',
            '※ 適用するとエフェクト / カラーグレード / ピクセルエフェクトが置き換わります'
          ) }}
        </div>
      </section>

      <!-- エフェクト (映像/画像) -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('効果', 'エフェクト') }}</span>
          <button class="ghost tiny" @click="resetEffects">{{ t('リセット', 'リセット') }}</button>
        </div>
        <AnimSlider :clip="selectedClip" path="effects.brightness" label="明るさ" :min="0" :max="3" :step="0.01" />
        <AnimSlider :clip="selectedClip" path="effects.contrast" label="コントラスト" :min="0" :max="3" :step="0.01" />
        <AnimSlider :clip="selectedClip" path="effects.saturation" :label="t('色の濃さ', '彩度')" :min="0" :max="3" :step="0.01" />
        <AnimSlider :clip="selectedClip" path="effects.blur" label="ぼかし" :min="0" :max="50" :step="0.5" />
        <AnimSlider :clip="selectedClip" path="effects.hueRotate" :label="t('色あい', '色相')" :min="-180" :max="180" :step="1" />
        <AnimSlider :clip="selectedClip" path="effects.grayscale" :label="t('白黒', 'グレースケール')" :min="0" :max="1" :step="0.01" />
        <AnimSlider :clip="selectedClip" path="effects.invert" label="色を反転" :min="0" :max="1" :step="0.01" />
        <AnimSlider :clip="selectedClip" path="effects.sepia" :label="t('セピア (古い写真風)', 'セピア')" :min="0" :max="1" :step="0.01" />
      </section>

      <!-- トランジション -->
      <!-- 音声クリップは「音声」セクションのフェードを使う。
           旧版で設定した音声クリップのフェード (transition) が残っている場合だけ表示して外せるようにする -->
      <section
        v-if="selectedClip.kind !== 'audio' || selectedClip.transitionIn || selectedClip.transitionOut"
        class="section"
      >
        <div class="section-head">
          {{ selectedClip.kind === 'audio'
            ? t('フェード (音量)', 'オーディオフェード')
            : t('トランジション (つなぎ)', 'トランジション') }}
        </div>
        <div class="sub-title">{{ t('入り', '入り') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="selectedClip.transitionIn?.type ?? ''"
              @change="(e) => {
                const t = (e.target as HTMLSelectElement).value
                if (!t) clearTransition('in')
                else setTransition('in', { ...selectedClip!.transitionIn, type: t as TransitionType, duration: selectedClip!.transitionIn?.duration ?? 0.3 })
              }"
            >
              <option value="">なし</option>
              <option value="fade">{{ selectedClip.kind === 'audio' ? 'フェードイン (音が徐々に大きく)' : 'フェードイン (じわっと出る)' }}</option>
              <template v-if="selectedClip.kind !== 'audio'">
                <optgroup v-for="g in TRANSITION_GROUPS" :key="g.label[1]" :label="t(g.label[0], g.label[1])">
                  <option v-for="o in g.options" :key="o.type" :value="o.type">
                    {{ t(o.inLabel[0], o.inLabel[1]) }}
                  </option>
                </optgroup>
              </template>
            </select>
          </label>
          <label class="field">
            <span>長さ (秒)</span>
            <input
              type="number"
              min="0"
              step="0.05"
              :value="selectedClip.transitionIn?.duration ?? 0"
              :disabled="!selectedClip.transitionIn"
              @change="(e) => {
                if (!selectedClip!.transitionIn) return
                setTransition('in', { ...selectedClip!.transitionIn, duration: Math.max(0, Number((e.target as HTMLInputElement).value)) })
              }"
            />
          </label>
        </div>
        <template v-if="selectedClip.kind !== 'audio' && selectedClip.transitionIn">
          <label class="toggle">
            <input
              type="checkbox"
              :checked="!!selectedClip.transitionIn.overlap"
              @change="(e) => setOverlap((e.target as HTMLInputElement).checked)"
            />
            <span>{{ t('前のクリップに重ねてつなぐ', '前のクリップと重ねる (クロス)') }}</span>
          </label>
          <div class="section-hint">
            {{ selectedClip.transitionIn.overlap
              ? t(
                  '※ はじまる少し前から、前のクリップの上に重なって切り替わります',
                  '※ 開始位置の手前から前のクリップに重ねて切り替えます (配置・長さは変わりません)'
                )
              : t(
                  '※ クリップのはじめで、背景から出てきます',
                  '※ クリップ先頭で背景から現れます'
                ) }}
            <template v-if="selectedClip.transitionIn.overlap && !prevAdjacentClip">
              {{ t('(前にくっついたクリップがありません)', '(直前に隣接するクリップがありません)') }}
            </template>
          </div>
        </template>
        <div class="row gap-4" style="margin: 6px 0 8px;">
          <button class="ghost tiny" @click="applyFadePreset('in')">フェードインを設定</button>
          <button
            v-if="selectedClip.kind !== 'audio'"
            class="ghost tiny"
            :disabled="!selectedClip.transitionIn"
            :title="t('同じトラックで、くっついているクリップのつなぎ目すべてに この入り方を入れます', '同じトラックの隣接クリップすべてに、この入りトランジションを設定')"
            @click="applyInToTrack"
          >{{ t('ぜんぶのつなぎ目に入れる', 'トラック全体に適用') }}</button>
        </div>

        <div class="sub-title">{{ t('出', '出') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="selectedClip.transitionOut?.type ?? ''"
              @change="(e) => {
                const t = (e.target as HTMLSelectElement).value
                if (!t) clearTransition('out')
                else setTransition('out', { type: t as TransitionType, duration: selectedClip!.transitionOut?.duration ?? 0.3 })
              }"
            >
              <option value="">なし</option>
              <option value="fade">{{ selectedClip.kind === 'audio' ? 'フェードアウト (音が徐々に小さく)' : 'フェードアウト (じわっと消える)' }}</option>
              <template v-if="selectedClip.kind !== 'audio'">
                <optgroup v-for="g in TRANSITION_GROUPS" :key="g.label[1]" :label="t(g.label[0], g.label[1])">
                  <option v-for="o in g.options" :key="o.type" :value="o.type">
                    {{ t(o.outLabel[0], o.outLabel[1]) }}
                  </option>
                </optgroup>
              </template>
            </select>
          </label>
          <label class="field">
            <span>長さ (秒)</span>
            <input
              type="number"
              min="0"
              step="0.05"
              :value="selectedClip.transitionOut?.duration ?? 0"
              :disabled="!selectedClip.transitionOut"
              @change="(e) => {
                if (!selectedClip!.transitionOut) return
                setTransition('out', { ...selectedClip!.transitionOut, duration: Math.max(0, Number((e.target as HTMLInputElement).value)) })
              }"
            />
          </label>
        </div>
        <div class="row gap-4">
          <button class="ghost tiny" @click="applyFadePreset('out')">フェードアウトを設定</button>
        </div>
      </section>

      <!-- 速度 (実素材を持つ動画・音声のみ。静止画/図形/テキストには無意味) -->
      <section v-if="hasVolume(selectedClip)" class="section">
        <div class="section-head">{{ t('再生', '再生') }}</div>
        <div class="seg">
          <button
            class="seg-btn"
            :class="{ on: !selectedClip.speedCurve }"
            @click="setSpeedCurve(undefined)"
          >{{ t('いつも同じ速さ', '一定') }}</button>
          <button
            class="seg-btn"
            :class="{ on: !!selectedClip.speedCurve }"
            @click="selectedClip.speedCurve || startCustomCurve()"
          >{{ t('速さを変える (カーブ)', '速度カーブ') }}</button>
        </div>
        <label v-if="!selectedClip.speedCurve" class="field">
          <span>速さ (倍) <span class="mono muted">{{ (selectedClip.speed ?? 1).toFixed(2) }}</span></span>
          <input
            type="range"
            min="0.25"
            max="8"
            step="0.05"
            :value="selectedClip.speed ?? 1"
            @input="(e) => setSpeed(Number((e.target as HTMLInputElement).value))"
          />
        </label>
        <template v-else>
          <SpeedCurveEditor
            :points="selectedClip.speedCurve"
            :playhead="playheadInClip ? localPlayhead / selectedClip.duration : -1"
            @change="(pts, dragging) => setSpeedCurve(pts, dragging)"
          />
          <div class="section-hint">
            {{ t(
              '点を上下に動かすと速さが変わります。何もない所をクリックで点を追加、点をダブルクリックで消せます',
              'ドラッグで速度を調整 / 空白クリックで点を追加 / ダブルクリックで削除'
            ) }}
          </div>
        </template>
        <div class="preset-grid speed-presets">
          <button
            v-for="p in SPEED_PRESETS"
            :key="p.id"
            class="preset-chip"
            @click="applySpeedPreset(p)"
          >{{ t(p.easy, p.normal) }}</button>
        </div>
        <div v-if="sourceUsage" class="section-hint">
          {{ t('使う素材の長さ', '素材の使用範囲') }}: {{ sourceUsage.span.toFixed(2) }} s
          <template v-if="sourceUsage.over">
            <span class="warn">
              {{ t('— 素材が足りないので、最後は止まった画になります', '— 素材が不足しています (末尾で停止)') }}
            </span>
          </template>
          <button
            v-if="sourceUsage.remain != null"
            class="ghost tiny fit-btn"
            @click="fitDurationToSource"
          >{{ t('素材を使い切る長さにする', '長さを素材に合わせる') }}</button>
        </div>
        <div class="section-hint">
          {{ t(
            '※ 速さを変えてもクリップの長さは変わらず、再生される素材の範囲が変わります',
            '※ 速度変更でクリップ長は変わらず、消費される素材範囲が変わります'
          ) }}
        </div>
        <template v-if="selectedClip.kind === 'video'">
          <div class="sub-title">{{ t('画面を止める (フリーズ)', 'フリーズフレーム') }}</div>
          <div class="row gap-4">
            <label class="field freeze-hold">
              <span>{{ t('止める長さ (秒)', '長さ (秒)') }}</span>
              <input
                type="number"
                min="0.1" step="0.5"
                :value="freezeHold"
                @change="(e) => freezeHold = Math.max(0.1, Number((e.target as HTMLInputElement).value) || 2)"
              />
            </label>
            <button
              class="ghost freeze-btn"
              :disabled="!playheadInClip || freezing"
              @click="freezeFrame"
            >{{ freezing ? t('作成中…', '作成中…') : t('今の画面で止める', '再生位置で挿入') }}</button>
          </div>
          <div class="section-hint">
            {{ t(
              '※ 再生位置の画面を静止画にして間に入れます。後ろのクリップはその分うしろにずれます',
              '※ 再生ヘッド位置のフレームを静止画として挿入し、以降のクリップを後ろへずらします'
            ) }}
          </div>
        </template>
      </section>

      <section v-if="hasEffects(selectedClip) || selectedClip.kind === 'shape' || selectedClip.kind === 'text'" class="section">
        <div class="section-head">{{ t('合成', '合成') }}</div>
        <label class="field">
          <span>{{ t('ブレンド', 'ブレンドモード') }}</span>
          <select
            :value="selectedClip.blendMode ?? 'normal'"
            @change="(e) => setBlendMode((e.target as HTMLSelectElement).value as BlendMode)"
          >
            <option v-for="m in BLEND_MODES" :key="m" :value="m">{{ blendLabelJa(m) }}</option>
          </select>
        </label>
      </section>

      <!-- 背景ぼかし塗り -->
      <section v-if="videoOrImageClip" class="section">
        <div class="section-head">{{ t('余白をぼかしで埋める', '背景ぼかし') }}</div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="!!videoOrImageClip.bgFill"
            @change="(e) => setBgFillEnabled((e.target as HTMLInputElement).checked)"
          />
          <span>{{ t('黒い余白を 同じ映像のぼかしで埋める', '余白を同じ素材のぼかしで塗る') }}</span>
        </label>
        <template v-if="videoOrImageClip.bgFill">
          <div class="grid-2">
            <AnimSlider :clip="selectedClip" path="bgFill.blur" :label="t('ぼかし', 'ぼかし')" :min="0" :max="100" :step="1" />
            <AnimSlider :clip="selectedClip" path="bgFill.dim" :label="t('暗さ', '暗さ')" :min="0" :max="0.8" :step="0.01" />
          </div>
          <button class="ghost tiny" @click="applyBgFillToAll">
            {{ t('ほかの動画・画像にも同じ設定を入れる', 'すべての動画・画像に適用') }}
          </button>
        </template>
        <div class="section-hint">
          {{ t(
            '※ 横長の動画を縦長の画面に置いたときなど、上下左右の余白に使います',
            '※ 横長素材を縦長キャンバスに置いた場合などの余白を埋めます'
          ) }}
        </div>
      </section>

      <!-- クロップ (切り抜き) -->
      <section v-if="videoOrImageClip" class="section">
        <div class="section-head">
          <span>{{ t('切り抜き (クロップ)', 'クロップ') }}</span>
          <button class="ghost tiny" @click="resetCrop">{{ t('リセット', 'リセット') }}</button>
        </div>
        <div class="grid-2">
          <AnimSlider :clip="selectedClip" path="crop.left" :label="t('左', '左')" :min="0" :max="0.45" :step="0.005" />
          <AnimSlider :clip="selectedClip" path="crop.right" :label="t('右', '右')" :min="0" :max="0.45" :step="0.005" />
          <AnimSlider :clip="selectedClip" path="crop.top" :label="t('上', '上')" :min="0" :max="0.45" :step="0.005" />
          <AnimSlider :clip="selectedClip" path="crop.bottom" :label="t('下', '下')" :min="0" :max="0.45" :step="0.005" />
        </div>
        <div class="section-hint">
          {{ t('※ 端から切り落とす割合です (0.1 = 10%)', '※ 各辺から切り落とす割合 (0.1 = 10%)') }}
        </div>
      </section>

      <!-- マスク -->
      <section v-if="videoOrImageClip" class="section">
        <div class="section-head">{{ t('マスク (形で切り抜く)', 'マスク') }}</div>
        <label class="field">
          <span>{{ t('形', '形状') }}</span>
          <select
            :value="videoOrImageClip.mask?.shape ?? ''"
            @change="(e) => setMaskShape((e.target as HTMLSelectElement).value as MaskShape | '')"
          >
            <option v-for="m in MASK_SHAPES" :key="m.value" :value="m.value">{{ t(m.easy, m.normal) }}</option>
          </select>
        </label>
        <template v-if="videoOrImageClip.mask">
          <div class="grid-2">
            <AnimSlider :clip="selectedClip" path="mask.x" :label="t('横位置', 'X')" :min="0" :max="1" :step="0.01" />
            <AnimSlider :clip="selectedClip" path="mask.y" :label="t('縦位置', 'Y')" :min="0" :max="1" :step="0.01" />
            <template v-if="videoOrImageClip.mask.shape !== 'linear'">
              <AnimSlider :clip="selectedClip" path="mask.width" :label="t('横幅', '幅')" :min="0.02" :max="1.5" :step="0.01" />
              <AnimSlider :clip="selectedClip" path="mask.height" :label="t('高さ', '高さ')" :min="0.02" :max="1.5" :step="0.01" />
            </template>
            <AnimSlider :clip="selectedClip" path="mask.rotation" :label="t('回転 (度)', '回転')" :min="-180" :max="180" :step="1" />
            <AnimSlider :clip="selectedClip" path="mask.feather" :label="t('ふちのぼかし', 'フェザー')" :min="0" :max="1" :step="0.01" />
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              :checked="videoOrImageClip.mask.invert"
              @change="(e) => updateMask({ invert: (e.target as HTMLInputElement).checked })"
            />
            <span>{{ t('内と外を反対にする', '反転') }}</span>
          </label>
        </template>
      </section>

      <!-- カラーグレーディング -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('カラーグレード (色調整)', 'カラーグレード') }}</span>
          <button class="ghost tiny" @click="resetGrade">{{ t('リセット', 'リセット') }}</button>
        </div>
        <div class="sub-title">暗い部分 (シャドウ)</div>
        <div class="grid-3">
          <EffectSlider label="赤" :value="videoOrImageClip?.colorGrade?.lift?.r ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="緑" :value="videoOrImageClip?.colorGrade?.lift?.g ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="青" :value="videoOrImageClip?.colorGrade?.lift?.b ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <div class="sub-title">中間 (ガンマ)</div>
        <div class="grid-3">
          <EffectSlider label="赤" :value="videoOrImageClip?.colorGrade?.gamma?.r ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="緑" :value="videoOrImageClip?.colorGrade?.gamma?.g ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="青" :value="videoOrImageClip?.colorGrade?.gamma?.b ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <div class="sub-title">明るい部分 (ハイライト)</div>
        <div class="grid-3">
          <EffectSlider label="赤" :value="videoOrImageClip?.colorGrade?.gain?.r ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="緑" :value="videoOrImageClip?.colorGrade?.gain?.g ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="青" :value="videoOrImageClip?.colorGrade?.gain?.b ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <AnimSlider :clip="selectedClip" path="colorGrade.temperature" :label="t('暖かさ', '色温度')" :min="-1" :max="1" :step="0.01" />
        <AnimSlider :clip="selectedClip" path="colorGrade.tint" :label="t('緑〜紫', 'ティント')" :min="-1" :max="1" :step="0.01" />
      </section>

      <!-- クロマキー -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('クロマキー (色を透明に)', 'クロマキー') }}</span>
          <button class="ghost tiny" @click="clearChroma">{{ t('解除', '解除') }}</button>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="!!videoOrImageClip?.chromaKey?.enabled"
            @change="(e) => updateChroma({ enabled: (e.target as HTMLInputElement).checked })"
          />
          <span>使う</span>
        </label>
        <div v-if="videoOrImageClip?.chromaKey?.enabled" class="grid-2">
          <label class="field">
            <span>けす いろ</span>
            <input
              type="color"
              :value="videoOrImageClip?.chromaKey.color"
              @input="(e) => updateChroma({ color: (e.target as HTMLInputElement).value })"
            />
          </label>
          <div />
          <EffectSlider :label="t('消す範囲', 'しきい値')" :value="videoOrImageClip?.chromaKey.threshold" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ threshold: v })" />
          <EffectSlider label="ふちの柔らかさ" :value="videoOrImageClip?.chromaKey.softness" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ softness: v })" />
          <EffectSlider label="色残りを減らす" :value="videoOrImageClip?.chromaKey.spillSuppress" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ spillSuppress: v })" />
        </div>
      </section>

      <!-- ピクセルエフェクト (特殊効果) -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('特殊効果', 'ピクセルエフェクト') }}</span>
          <button class="ghost tiny" @click="resetPixelFx">{{ t('リセット', 'リセット') }}</button>
        </div>
        <AnimSlider :clip="selectedClip" path="pixelFx.vignette" :label="t('ビネット (周辺を暗く)', 'ビネット')" :min="0" :max="1" :step="0.01" />
        <EffectSlider
          :label="t('シャープ (くっきり)', 'シャープ')"
          :value="videoOrImageClip?.pixelFx?.sharpen ?? 0" :min="0" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ sharpen: v })" />
        <EffectSlider
          :label="t('バイブランス (自然な鮮やかさ)', 'バイブランス')"
          :value="videoOrImageClip?.pixelFx?.vibrance ?? 0" :min="-1" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ vibrance: v })" />
        <AnimSlider :clip="selectedClip" path="pixelFx.grain" :label="t('フィルムグレイン (ざらつき)', 'フィルムグレイン')" :min="0" :max="1" :step="0.01" />
        <AnimSlider :clip="selectedClip" path="pixelFx.pixelate" :label="t('モザイク', 'モザイク')" :min="0" :max="40" :step="1" />
        <EffectSlider
          :label="t('ポスタライズ (階調を減らす)', 'ポスタライズ')"
          :value="videoOrImageClip?.pixelFx?.posterize ?? 0" :min="0" :max="16" :step="1"
          @change="(v) => updatePixelFx({ posterize: v })" />
        <EffectSlider
          :label="t('二値化 (白黒2階調)', '二値化しきい値')"
          :value="videoOrImageClip?.pixelFx?.threshold ?? 0" :min="0" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ threshold: v })" />
        <EffectSlider
          :label="t('走査線 (横じま)', '走査線')"
          :value="videoOrImageClip?.pixelFx?.scanlines ?? 0" :min="0" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ scanlines: v })" />
        <AnimSlider :clip="selectedClip" path="pixelFx.chromaticAberration" :label="t('色収差 (RGBずれ)', '色収差')" :min="0" :max="10" :step="0.5" />
        <label class="toggle" style="margin-top: 6px;">
          <input
            type="checkbox"
            :checked="!!videoOrImageClip?.pixelFx?.duotone?.enabled"
            @change="(e) => updateDuotone({ enabled: (e.target as HTMLInputElement).checked })"
          />
          <span>{{ t('デュオトーン (2色)', 'デュオトーン') }}</span>
        </label>
        <div v-if="videoOrImageClip?.pixelFx?.duotone?.enabled" class="grid-2">
          <label class="field">
            <span>{{ t('暗い部分の色', '暗部の色') }}</span>
            <input
              type="color"
              :value="videoOrImageClip?.pixelFx?.duotone?.shadow ?? '#1a1a4a'"
              @input="(e) => updateDuotone({ shadow: (e.target as HTMLInputElement).value })"
            />
          </label>
          <label class="field">
            <span>{{ t('明るい部分の色', '明部の色') }}</span>
            <input
              type="color"
              :value="videoOrImageClip?.pixelFx?.duotone?.highlight ?? '#ffd98a'"
              @input="(e) => updateDuotone({ highlight: (e.target as HTMLInputElement).value })"
            />
          </label>
        </div>
      </section>

      <!-- テキスト装飾 / アニメ -->
      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">
          <span>{{ t('文字の飾り', 'テキスト装飾') }}</span>
          <button class="ghost tiny" @click="clearDecor">{{ t('解除', '解除') }}</button>
        </div>
        <div class="grid-2">
          <label class="field">
            <span>影の色</span>
            <input
              type="color"
              :value="textClip?.decor?.shadow?.color ?? '#000000'"
              @input="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 8, offsetX: 2, offsetY: 2, color: '#000000' }), color: (e.target as HTMLInputElement).value } })"
            />
          </label>
          <label class="field">
            <span>影のぼかし</span>
            <input
              type="number"
              min="0" step="1"
              :value="textClip?.decor?.shadow?.blur ?? 0"
              @change="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 0, offsetX: 0, offsetY: 0, color: '#000000' }), blur: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>影 (横)</span>
            <input
              type="number"
              step="1"
              :value="textClip?.decor?.shadow?.offsetX ?? 0"
              @change="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 0, offsetX: 0, offsetY: 0, color: '#000000' }), offsetX: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>影 (縦)</span>
            <input
              type="number"
              step="1"
              :value="textClip?.decor?.shadow?.offsetY ?? 0"
              @change="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 0, offsetX: 0, offsetY: 0, color: '#000000' }), offsetY: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>ふちの色</span>
            <input
              type="color"
              :value="textClip?.decor?.outline?.color ?? '#000000'"
              @input="(e) => updateDecor({ outline: { ...(textClip?.decor?.outline ?? { color: '#000000', width: 0 }), color: (e.target as HTMLInputElement).value } })"
            />
          </label>
          <AnimSlider :clip="selectedClip" path="decor.outline.width" label="ふちの太さ" />
          <AnimSlider :clip="selectedClip" path="decor.letterSpacing" label="字間" />
          <label class="field">
            <span>行間 (倍)</span>
            <input
              type="number"
              min="1" max="3" step="0.05"
              :value="textClip?.decor?.lineHeight ?? 1.3"
              @change="(e) => updateDecor({ lineHeight: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
      </section>

      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">{{ t('文字のアニメーション', 'テキストアニメ') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="textClip?.anim?.type ?? 'none'"
              @change="(e) => setAnim((e.target as HTMLSelectElement).value as TextAnimType, textClip?.anim?.duration ?? 1)"
            >
              <option v-for="a in TEXT_ANIMS" :key="a" :value="a">{{ animLabelJa(a) }}</option>
            </select>
          </label>
          <label class="field">
            <span>長さ (秒)</span>
            <input
              type="number"
              min="0.1" step="0.1"
              :value="textClip?.anim?.duration ?? 1"
              :disabled="!textClip?.anim"
              @change="(e) => setAnim(textClip?.anim?.type ?? 'none', Number((e.target as HTMLInputElement).value))"
            />
          </label>
        </div>
      </section>

      <!-- 単語ハイライト字幕 (カラオケ風) -->
      <section v-if="textClip" class="section">
        <div class="section-head">{{ t('単語を順に光らせる (字幕向け)', '単語ハイライト') }}</div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="!!textClip.karaoke"
            @change="(e) => setKaraoke((e.target as HTMLInputElement).checked ? {} : null)"
          />
          <span>{{ t('しゃべっている単語を強調する', '単語を順にハイライト') }}</span>
        </label>
        <template v-if="textClip.karaoke">
          <div class="grid-2">
            <label class="field">
              <span>{{ t('見せ方', '表現') }}</span>
              <select
                :value="textClip.karaoke.mode"
                @change="(e) => setKaraoke({ mode: (e.target as HTMLSelectElement).value as KaraokeMode })"
              >
                <option v-for="m in KARAOKE_MODES" :key="m.value" :value="m.value">{{ t(m.easy, m.normal) }}</option>
              </select>
            </label>
            <label class="field">
              <span>{{ t('強調の色', '強調色') }}</span>
              <input
                type="color"
                :value="textClip.karaoke.color"
                @input="(e) => setKaraoke({ color: (e.target as HTMLInputElement).value })"
              />
            </label>
            <label v-if="textClip.karaoke.mode === 'box'" class="field">
              <span>{{ t('箱の色', '箱の色') }}</span>
              <input
                type="color"
                :value="textClip.karaoke.boxColor ?? textClip.karaoke.color"
                @input="(e) => setKaraoke({ boxColor: (e.target as HTMLInputElement).value })"
              />
            </label>
          </div>
          <div class="grid-2">
            <EffectSlider :label="t('始まるまで (秒)', '開始の遅れ (秒)')" :value="textClip.karaoke.lead"
              :min="0" :max="Math.max(0.1, textClip.duration - 0.1)" :step="0.05" @change="(v) => setKaraoke({ lead: v })" />
            <EffectSlider :label="t('終わりの余白 (秒)', '終了の余白 (秒)')" :value="textClip.karaoke.tail"
              :min="0" :max="Math.max(0.1, textClip.duration - 0.1)" :step="0.05" @change="(v) => setKaraoke({ tail: v })" />
          </div>
          <div class="section-hint">
            {{ t(
              '※ 文字数に合わせて時間を割り振ります。話し始め・話し終わりに合わせて「始まるまで」「終わりの余白」を調整してください。文字のアニメーションより優先されます',
              '※ 文字数比で時間を配分します。開始の遅れ / 終了の余白で発話に合わせてください (テキストアニメより優先)'
            ) }}
          </div>
        </template>
      </section>

      <!-- 図形 -->
      <section v-if="selectedClip.kind === 'shape'" class="section">
        <div class="section-head">{{ t('図形', '図形') }}</div>
        <label class="field">
          <span>{{ t('図形', '形状') }}</span>
          <select
            :value="shapeClip!.shape"
            @change="(e) => updateShape({ shape: (e.target as HTMLSelectElement).value as ShapeKind })"
          >
            <option v-for="s in SHAPE_KINDS" :key="s" :value="s">{{ shapeLabelJa(s) }}</option>
          </select>
        </label>
        <div class="grid-2">
          <AnimSlider :clip="selectedClip" path="width" label="横幅" />
          <AnimSlider :clip="selectedClip" path="height" label="高さ" />
          <label class="field">
            <span>塗りの色</span>
            <div class="row gap-4">
              <input
                type="color"
                :value="shapeClip!.style.fill ?? '#e8a838'"
                @input="(e) => updateShapeStyle({ fill: (e.target as HTMLInputElement).value })"
              />
              <button class="ghost" @click="updateShapeStyle({ fill: undefined })">なし</button>
            </div>
          </label>
          <label class="field">
            <span>線の色</span>
            <div class="row gap-4">
              <input
                type="color"
                :value="shapeClip!.style.stroke ?? '#ffffff'"
                @input="(e) => updateShapeStyle({ stroke: (e.target as HTMLInputElement).value })"
              />
              <button class="ghost" @click="updateShapeStyle({ stroke: undefined })">なし</button>
            </div>
          </label>
          <AnimSlider :clip="selectedClip" path="style.strokeWidth" label="線の太さ" />
          <AnimSlider v-if="shapeClip!.shape === 'rect'" :clip="selectedClip" path="style.cornerRadius" label="角の丸み" />
        </div>
      </section>

      <!-- EQ (音声/映像) -->
      <section v-if="hasVolume(selectedClip)" class="section">
        <div class="section-head">{{ t('イコライザー (低・中・高音)', 'EQ (3 バンド)') }}</div>
        <div class="grid-3">
          <EffectSlider label="低音" :value="audioLikeClip?.eq?.low ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ low: v })" />
          <EffectSlider label="中音" :value="audioLikeClip?.eq?.mid ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ mid: v })" />
          <EffectSlider label="高音" :value="audioLikeClip?.eq?.high ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ high: v })" />
        </div>
      </section>

      <!-- リンク -->
      <section class="section">
        <div class="row gap-4">
          <button class="ghost tiny" :disabled="selection.selectedClipIds.value.length < 2" @click="linkSelection">🔗 {{ t('リンク', 'リンク') }}</button>
          <button class="ghost tiny" :disabled="!selectedClip.linkGroup" @click="unlinkSelection">🔗 {{ t('リンク解除', '解除') }}</button>
          <span v-if="selectedClip.linkGroup" class="muted mono" style="font-size: 10px">{{ t('リンク中', 'リンク済') }}</span>
        </div>
      </section>

      <!-- 削除 -->
      <section class="section">
        <button class="danger" @click="() => { if (selectedClip) { store.removeClip(selectedClip.id); selection.clearSelection() } }">
          {{ t('このクリップを削除', 'クリップを削除') }}
        </button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.inspector-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px 20px;
  min-height: 0;
}

.empty {
  height: 60%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fg-3);
}
.empty-icon { font-size: 28px; color: var(--line-strong); }
.empty-text { font-size: 11px; }

.section {
  padding: 10px 0;
  border-bottom: 1px dashed var(--line-weak);
}
.section:last-child { border-bottom: none; }

.section-head {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--fg-2);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sub-title {
  font-size: 10px;
  color: var(--fg-2);
  margin: 6px 0 4px;
  letter-spacing: 0.04em;
}

.kind-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #1a1408;
  font-weight: 700;
}
.kind-badge.k-video { background: var(--video); }
.kind-badge.k-audio { background: var(--audio); }
.kind-badge.k-image { background: var(--image); }
.kind-badge.k-text  { background: var(--text); }

.grid-2 {
  display: grid;
  /* minmax(0, 1fr): 中身 (input / range) の最小幅で列が押し広げられてはみ出すのを防ぐ */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}
.grid-3 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 6px;
  margin-bottom: 6px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  min-width: 0;
}
.field input:not([type="checkbox"]),
.field select {
  width: 100%;
  min-width: 0;
}
.field > span {
  color: var(--fg-2);
  display: flex;
  align-items: center;
  gap: 6px;
}
.field .value {
  font-size: 12px;
  padding: 6px 8px;
  background: var(--bg-1);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  color: var(--fg-1);
}
.field input[type="color"] {
  padding: 2px;
  height: 30px;
  width: 100%;
}
.field textarea {
  resize: vertical;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fg-1);
  cursor: pointer;
}
.gap-4 { gap: 8px; }

button.danger {
  color: var(--danger);
  border-color: var(--line);
  width: 100%;
}
button.danger:hover {
  background: rgba(224, 86, 86, 0.1);
  border-color: var(--danger);
}
button.tiny {
  padding: 2px 6px;
  font-size: 10px;
  min-width: 22px;
}

.kf-btn {
  background: none;
  border: 1px solid var(--line);
  color: var(--fg-3);
  padding: 2px 6px;
  font-size: 11px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color 120ms, background 120ms;
}
.kf-btn:hover:not(:disabled) {
  color: var(--fg-0);
  background: var(--bg-2);
}
.kf-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.kf-btn.on {
  color: var(--accent-hi);
  border-color: var(--accent);
  background: rgba(232, 168, 56, 0.1);
}
.kf-btn.inline {
  padding: 0 5px;
  font-size: 10px;
}

.kf-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.kf-row select {
  flex: 1;
  font-size: 11px;
}
.row {
  display: flex;
  align-items: center;
}

.section-hint {
  font-size: 10px;
  color: var(--fg-3);
  line-height: 1.5;
  margin-top: 6px;
}

.kf-item {
  padding: 6px 0;
  border-bottom: 1px dotted var(--line-weak);
}
.kf-item:last-of-type {
  border-bottom: none;
}
.kf-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  margin-bottom: 4px;
}
.kf-name {
  flex: 1;
  color: var(--fg-1);
}
.bezier-presets {
  flex-wrap: wrap;
  justify-content: center;
}

.seg {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.seg-btn {
  flex: 1;
  font-size: 11px;
  padding: 5px 6px;
  background: var(--bg-2);
  border: 1px solid var(--line-weak);
  color: var(--fg-2);
}
.seg-btn.on {
  color: var(--accent-hi);
  border-color: var(--accent);
  background: rgba(232, 168, 56, 0.1);
}
.speed-presets {
  margin-top: 8px;
}
.warn {
  color: var(--danger);
}
.fit-btn {
  margin-left: 6px;
}
.duck-toggle {
  margin-top: 10px;
}

.style-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  margin-bottom: 8px;
}
.style-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 2px 5px;
  background: #2a2a2e;
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.style-chip:hover {
  border-color: var(--accent);
}
.style-sample {
  font-size: 17px;
  line-height: 1.2;
  padding: 0 4px;
  border-radius: 2px;
}
.style-name {
  font-size: 9px;
  color: var(--fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.freeze-hold {
  width: 90px;
  flex-shrink: 0;
}
.freeze-btn {
  flex: 1;
  align-self: flex-end;
}

.preset-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.preset-chip {
  font-size: 11px;
  padding: 6px 8px;
  background: var(--bg-2);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  color: var(--fg-1);
  cursor: pointer;
  text-align: center;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.preset-chip:hover {
  background: var(--bg-3);
  border-color: var(--accent);
  color: var(--accent-hi);
}
</style>
