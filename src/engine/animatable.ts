import type { Clip, ClipKind, Keyframe } from '../types/project'
import { sampleKeyframes } from './keyframes'

// ============================================================
// キーフレームで動かせる項目 (アニメーション可能なプロパティ)
// ============================================================
// 基本の 6 項目 (x / y / scale / rotation / opacity / volume) は computeEffective で
// 扱う。それ以外はクリップ内の数値をドット区切りのパスで指定し、描画の直前に
// applyAnimatedProps() でその時刻の値を入れたクリップを作って描く。
// ============================================================

export const CORE_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'] as const

export interface AnimatableDef {
  path: string
  easy: string
  normal: string
  kinds: ClipKind[]
  min: number
  max: number
  step: number
  /** 値が未設定のときの値 (効果なしの値) */
  base: number
}

const VISUAL: ClipKind[] = ['video', 'image']
const WITH_EFFECTS: ClipKind[] = ['video', 'image', 'shape']

export const ANIMATABLE: AnimatableDef[] = [
  // 基本
  { path: 'x', easy: '横位置', normal: 'X', kinds: ['video', 'image', 'text', 'shape'], min: -1, max: 2, step: 0.001, base: 0.5 },
  { path: 'y', easy: '縦位置', normal: 'Y', kinds: ['video', 'image', 'text', 'shape'], min: -1, max: 2, step: 0.001, base: 0.5 },
  { path: 'scale', easy: '大きさ', normal: 'スケール', kinds: ['video', 'image', 'text', 'shape'], min: 0, max: 10, step: 0.01, base: 1 },
  { path: 'rotation', easy: '回転', normal: '回転', kinds: ['video', 'image', 'text', 'shape'], min: -720, max: 720, step: 1, base: 0 },
  { path: 'opacity', easy: '透明度', normal: '不透明度', kinds: ['video', 'image', 'text', 'shape'], min: 0, max: 1, step: 0.01, base: 1 },
  { path: 'volume', easy: '音量', normal: '音量', kinds: ['video', 'audio'], min: 0, max: 2, step: 0.01, base: 1 },
  // エフェクト
  { path: 'effects.brightness', easy: '明るさ', normal: '明るさ', kinds: WITH_EFFECTS, min: 0, max: 3, step: 0.01, base: 1 },
  { path: 'effects.contrast', easy: 'コントラスト', normal: 'コントラスト', kinds: WITH_EFFECTS, min: 0, max: 3, step: 0.01, base: 1 },
  { path: 'effects.saturation', easy: '色の濃さ', normal: '彩度', kinds: WITH_EFFECTS, min: 0, max: 3, step: 0.01, base: 1 },
  { path: 'effects.blur', easy: 'ぼかし', normal: 'ぼかし', kinds: WITH_EFFECTS, min: 0, max: 50, step: 0.5, base: 0 },
  { path: 'effects.hueRotate', easy: '色あい', normal: '色相', kinds: WITH_EFFECTS, min: -180, max: 180, step: 1, base: 0 },
  { path: 'effects.grayscale', easy: '白黒', normal: 'グレースケール', kinds: WITH_EFFECTS, min: 0, max: 1, step: 0.01, base: 0 },
  { path: 'effects.invert', easy: '色を反転', normal: '反転', kinds: WITH_EFFECTS, min: 0, max: 1, step: 0.01, base: 0 },
  { path: 'effects.sepia', easy: 'セピア', normal: 'セピア', kinds: WITH_EFFECTS, min: 0, max: 1, step: 0.01, base: 0 },
  // クロップ
  { path: 'crop.left', easy: '切り抜き (左)', normal: 'クロップ左', kinds: VISUAL, min: 0, max: 0.45, step: 0.005, base: 0 },
  { path: 'crop.right', easy: '切り抜き (右)', normal: 'クロップ右', kinds: VISUAL, min: 0, max: 0.45, step: 0.005, base: 0 },
  { path: 'crop.top', easy: '切り抜き (上)', normal: 'クロップ上', kinds: VISUAL, min: 0, max: 0.45, step: 0.005, base: 0 },
  { path: 'crop.bottom', easy: '切り抜き (下)', normal: 'クロップ下', kinds: VISUAL, min: 0, max: 0.45, step: 0.005, base: 0 },
  // マスク
  { path: 'mask.x', easy: 'マスク 横位置', normal: 'マスク X', kinds: VISUAL, min: 0, max: 1, step: 0.01, base: 0.5 },
  { path: 'mask.y', easy: 'マスク 縦位置', normal: 'マスク Y', kinds: VISUAL, min: 0, max: 1, step: 0.01, base: 0.5 },
  { path: 'mask.width', easy: 'マスク 横幅', normal: 'マスク幅', kinds: VISUAL, min: 0.02, max: 1.5, step: 0.01, base: 0.6 },
  { path: 'mask.height', easy: 'マスク 高さ', normal: 'マスク高さ', kinds: VISUAL, min: 0.02, max: 1.5, step: 0.01, base: 0.6 },
  { path: 'mask.rotation', easy: 'マスク 回転', normal: 'マスク回転', kinds: VISUAL, min: -180, max: 180, step: 1, base: 0 },
  { path: 'mask.feather', easy: 'マスク ふちのぼかし', normal: 'マスクフェザー', kinds: VISUAL, min: 0, max: 1, step: 0.01, base: 0.1 },
  // 背景ぼかし・色
  { path: 'bgFill.blur', easy: '余白のぼかし', normal: '背景ぼかし', kinds: VISUAL, min: 0, max: 100, step: 1, base: 40 },
  { path: 'bgFill.dim', easy: '余白の暗さ', normal: '背景の暗さ', kinds: VISUAL, min: 0, max: 0.8, step: 0.01, base: 0.15 },
  { path: 'colorGrade.temperature', easy: '暖かさ', normal: '色温度', kinds: VISUAL, min: -1, max: 1, step: 0.01, base: 0 },
  { path: 'colorGrade.tint', easy: '緑〜紫', normal: 'ティント', kinds: VISUAL, min: -1, max: 1, step: 0.01, base: 0 },
  { path: 'pixelFx.vignette', easy: 'ビネット', normal: 'ビネット', kinds: VISUAL, min: 0, max: 1, step: 0.01, base: 0 },
  { path: 'pixelFx.grain', easy: 'ざらつき', normal: 'フィルムグレイン', kinds: VISUAL, min: 0, max: 1, step: 0.01, base: 0 },
  { path: 'pixelFx.pixelate', easy: 'モザイク', normal: 'モザイク', kinds: VISUAL, min: 0, max: 40, step: 1, base: 0 },
  { path: 'pixelFx.chromaticAberration', easy: '色収差', normal: '色収差', kinds: VISUAL, min: 0, max: 10, step: 0.5, base: 0 },
  // テキスト
  { path: 'fontSize', easy: '文字の大きさ', normal: '文字サイズ', kinds: ['text'], min: 8, max: 400, step: 1, base: 72 },
  { path: 'decor.letterSpacing', easy: '字間', normal: '字間', kinds: ['text'], min: -10, max: 80, step: 0.5, base: 0 },
  { path: 'decor.outline.width', easy: 'ふちの太さ', normal: '縁取り幅', kinds: ['text'], min: 0, max: 40, step: 0.5, base: 0 },
  // 図形
  { path: 'width', easy: '横幅', normal: '幅', kinds: ['shape'], min: 0.01, max: 2, step: 0.01, base: 0.3 },
  { path: 'height', easy: '高さ', normal: '高さ', kinds: ['shape'], min: 0.01, max: 2, step: 0.01, base: 0.3 },
  { path: 'style.strokeWidth', easy: '線の太さ', normal: '線幅', kinds: ['shape'], min: 0, max: 60, step: 1, base: 0 },
  { path: 'style.cornerRadius', easy: '角の丸み', normal: '角丸', kinds: ['shape'], min: 0, max: 400, step: 1, base: 0 }
]

const DEF_BY_PATH = new Map(ANIMATABLE.map(d => [d.path, d]))

export function animatableDef(path: string): AnimatableDef | undefined {
  return DEF_BY_PATH.get(path)
}

/**
 * パスの親オブジェクトが無いときに補ってよい既定値。
 * ここに無い親 (mask / bgFill など) は「その機能が有効なときだけ」動かす。
 * (マスクを外した後に古いキーフレームだけが残っても、壊れたマスクを作らない)
 */
const PARENT_DEFAULTS: Record<string, () => Record<string, unknown>> = {
  effects: () => ({}),
  crop: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
  decor: () => ({}),
  'decor.outline': () => ({ color: '#000000', width: 0 }),
  colorGrade: () => ({}),
  pixelFx: () => ({}),
  style: () => ({})
}

export function getPath(obj: unknown, path: string): number | undefined {
  let cur: any = obj
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined
}

/**
 * path に value を入れた「新しい」オブジェクトを返す (元は変えない)。
 * 途中の親が無く、補ってよい既定値も無いときは null (設定できない)。
 */
export function setPath<T extends object>(obj: T, path: string, value: number): T | null {
  const keys = path.split('.')
  const root: any = { ...obj }
  let cur = root
  for (let i = 0; i < keys.length - 1; i++) {
    const parentPath = keys.slice(0, i + 1).join('.')
    const next = cur[keys[i]]
    if (next == null || typeof next !== 'object') {
      const make = PARENT_DEFAULTS[parentPath]
      if (!make) return null
      cur[keys[i]] = make()
    } else {
      cur[keys[i]] = Array.isArray(next) ? [...next] : { ...next }
    }
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
  return root
}

/** クリップの path の、キーフレームを使わない基準の値 */
export function baseValue(clip: Clip, path: string): number {
  return getPath(clip, path) ?? animatableDef(path)?.base ?? 0
}

/** 時刻 localT (クリップ先頭からの秒) における path の値 (キーフレーム適用後) */
export function valueAt(clip: Clip, path: string, localT: number): number {
  return sampleKeyframes(clip.keyframes?.[path], localT, baseValue(clip, path))
}

export function isAnimated(clip: Clip, path: string): boolean {
  return (clip.keyframes?.[path]?.length ?? 0) > 0
}

/**
 * 基本 6 項目以外のキーフレームを、時刻 localT の値として埋め込んだクリップを返す。
 * キーフレームが無ければ元のクリップをそのまま返す (毎フレームの複製を避ける)。
 */
export function applyAnimatedProps(clip: Clip, localT: number): Clip {
  const kfs = clip.keyframes
  if (!kfs) return clip
  let out: Clip | null = null
  for (const path of Object.keys(kfs)) {
    if ((CORE_PROPS as readonly string[]).includes(path)) continue
    const list: Keyframe[] | undefined = kfs[path]
    if (!list?.length) continue
    const def = animatableDef(path)
    if (def && !def.kinds.includes(clip.kind)) continue
    let v = sampleKeyframes(list, localT, baseValue(clip, path))
    if (def) v = Math.max(def.min, Math.min(def.max, v))
    const next: Clip | null = setPath<Clip>(out ?? clip, path, v)
    if (next) out = next
  }
  return out ?? clip
}

/** この種類のクリップで動かせる項目 */
export function animatablesFor(kind: ClipKind): AnimatableDef[] {
  return ANIMATABLE.filter(d => d.kinds.includes(kind))
}
