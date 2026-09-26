// ============================================================
// 書き出しフレームスケジュールの純ロジック (DOM / WebCodecs 非依存)
// ============================================================
// エクスポートのメインループは i = 0..totalFrames-1 に対して
// t = rangeStart + i / fps を評価する。クリップがそのフレームで
// アクティブかどうか・素材内のどの時刻が必要かはここで一元的に計算し、
// exportEngine のループと DecoderFrameSource の事前タイムスタンプ列が
// 完全に同じ値 (同じ浮動小数点演算) を共有する。
// ============================================================

export interface ClipTiming {
  kind?: string
  start: number
  duration: number
  sourceIn?: number
  speed?: number
  speedCurve?: Array<{ x: number; speed: number }>
  transitionIn?: { duration: number; overlap?: boolean }
}

// ---------- 速度カーブ ----------

export const MIN_CURVE_SPEED = 0.1
export const MAX_CURVE_SPEED = 10

/**
 * 速度カーブを「クリップ先頭からの秒 → 速度」の折れ線に直す。
 * x で並べ替え、範囲外は丸め、両端 (0 と duration) が必ず含まれるようにする。
 * カーブが無ければ null。
 */
function curveKnots(clip: ClipTiming): Array<{ t: number; s: number }> | null {
  const pts = clip.speedCurve
  if (!pts || pts.length === 0) return null
  const d = Math.max(0, clip.duration)
  const clampS = (v: number) =>
    Number.isFinite(v) ? Math.max(MIN_CURVE_SPEED, Math.min(MAX_CURVE_SPEED, v)) : 1
  const sorted = pts
    .map(p => ({ x: Math.max(0, Math.min(1, Number.isFinite(p.x) ? p.x : 0)), s: clampS(p.speed) }))
    .sort((a, b) => a.x - b.x)
  const knots = sorted.map(p => ({ t: p.x * d, s: p.s }))
  if (knots[0].t > 0) knots.unshift({ t: 0, s: knots[0].s })
  if (knots[knots.length - 1].t < d) knots.push({ t: d, s: knots[knots.length - 1].s })
  return knots
}

/** クリップ先頭から local 秒の位置の再生速度 */
export function speedAt(clip: ClipTiming, local: number): number {
  const knots = curveKnots(clip)
  if (!knots) return clip.speed ?? 1
  if (local <= knots[0].t) return knots[0].s
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1]
    const b = knots[i]
    if (local <= b.t) {
      const span = b.t - a.t
      return span <= 0 ? b.s : a.s + ((b.s - a.s) * (local - a.t)) / span
    }
  }
  return knots[knots.length - 1].s
}

/**
 * クリップ先頭から local 秒の間に進む素材の秒数 (= 速度の積分)。
 * 範囲外 (local < 0 や duration 超え) は端の速度で延長する。
 */
export function sourceAdvance(clip: ClipTiming, local: number): number {
  const knots = curveKnots(clip)
  if (!knots) return local * (clip.speed ?? 1)
  if (local <= 0) return local * knots[0].s
  let acc = 0
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1]
    const b = knots[i]
    if (local <= b.t) {
      const sl = speedAt(clip, local)
      return acc + ((local - a.t) * (a.s + sl)) / 2
    }
    acc += ((b.t - a.t) * (a.s + b.s)) / 2
  }
  const last = knots[knots.length - 1]
  return acc + (local - last.t) * last.s
}

/** クリップ全体で消費する素材の秒数 */
export function clipSourceSpan(clip: ClipTiming): number {
  return sourceAdvance(clip, clip.duration)
}

/**
 * 速度カーブを位置 f (0..1) で 2 つに分ける (クリップ分割用)。
 * 左右それぞれ 0..1 に正規化し直し、境界の速度を補間して両側に入れる。
 */
export function splitSpeedCurve(
  curve: Array<{ x: number; speed: number }> | undefined,
  f: number
): { left?: Array<{ x: number; speed: number }>; right?: Array<{ x: number; speed: number }> } {
  if (!curve || curve.length === 0 || f <= 0 || f >= 1) return { left: curve, right: curve }
  const probe: ClipTiming = { start: 0, duration: 1, speedCurve: curve }
  const mid = speedAt(probe, f)
  const sorted = [...curve].sort((a, b) => a.x - b.x)
  const left = [
    ...sorted.filter(p => p.x < f).map(p => ({ x: p.x / f, speed: p.speed })),
    { x: 1, speed: mid }
  ]
  const right = [
    { x: 0, speed: mid },
    ...sorted.filter(p => p.x > f).map(p => ({ x: (p.x - f) / (1 - f), speed: p.speed }))
  ]
  if (left[0].x > 0) left.unshift({ x: 0, speed: speedAt(probe, 0) })
  if (right[right.length - 1].x < 1) right.push({ x: 1, speed: speedAt(probe, 1) })
  return { left, right }
}

/**
 * 重ねる入りトランジション (transitionIn.overlap) で、開始位置より前に
 * 描き始める秒数。音声クリップは映像を持たないので 0。
 */
export function preRoll(clip: ClipTiming): number {
  const tr = clip.transitionIn
  if (!tr?.overlap || clip.kind === 'audio') return 0
  return Math.max(0, tr.duration)
}

/** 画面に描き始める時刻 (重ねるトランジションの分だけ start より前) */
export function visualStart(clip: ClipTiming): number {
  return clip.start - preRoll(clip)
}

type Curve = Array<{ x: number; speed: number }>

/**
 * 左端を delta 秒トリムしたときの速度カーブ (delta > 0 で短く、< 0 で延長)。
 * 残る部分の速度は元のまま (切り取る)。延長分は先頭の速度で一定にする。
 */
export function trimSpeedCurveLeft(curve: Curve | undefined, duration: number, delta: number): Curve | undefined {
  if (!curve || curve.length === 0 || delta === 0 || duration <= 0) return curve
  const newD = duration - delta
  if (newD <= 0) return curve
  if (delta > 0) return splitSpeedCurve(curve, delta / duration).right
  const s0 = speedAt({ start: 0, duration: 1, speedCurve: curve }, 0)
  const shifted = curve.map(p => ({ x: (p.x * duration - delta) / newD, speed: p.speed }))
  return [{ x: 0, speed: s0 }, ...shifted]
}

/** 右端を動かして長さを newDuration にしたときの速度カーブ (延長分は末尾の速度で一定) */
export function trimSpeedCurveRight(curve: Curve | undefined, duration: number, newDuration: number): Curve | undefined {
  if (!curve || curve.length === 0 || newDuration === duration || duration <= 0 || newDuration <= 0) return curve
  if (newDuration < duration) return splitSpeedCurve(curve, newDuration / duration).left
  const sEnd = speedAt({ start: 0, duration: 1, speedCurve: curve }, 1)
  const scaled = curve.map(p => ({ x: (p.x * duration) / newDuration, speed: p.speed }))
  return [...scaled, { x: 1, speed: sEnd }]
}

/**
 * 素材を span 秒ぶん使い切るクリップの長さ (右端トリムの上限用)。
 * 長さを変えてもカーブは切り取り/末尾延長 (trimSpeedCurveRight) で扱う前提。
 */
export function durationForSourceSpan(clip: ClipTiming, span: number): number {
  if (!clip.speedCurve?.length) return span / Math.max(1e-4, clip.speed ?? 1)
  const full = clipSourceSpan(clip)
  if (span >= full) return clip.duration + (span - full) / Math.max(1e-4, speedAt(clip, clip.duration))
  // sourceAdvance は単調増加なので二分探索
  let lo = 0
  let hi = clip.duration
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (sourceAdvance(clip, mid) < span) lo = mid
    else hi = mid
  }
  return lo
}

/** タイムライン時刻 t (絶対秒) → 素材内時刻 (秒) */
export function mapClipTimeToSource(clip: ClipTiming, t: number): number {
  return sourceAdvance(clip, t - clip.start) + (clip.sourceIn ?? 0)
}

/**
 * フレーム時刻 t でクリップが描画対象か (プレビュー・書き出し共通)。
 * 重ねるトランジションの前倒し分も含む。
 */
export function isClipActiveAt(clip: ClipTiming, t: number): boolean {
  return t >= visualStart(clip) && t < clip.start + clip.duration
}

/**
 * 描画順: トラック順 (奥→手前) で並べ、同じトラック内では開始が遅いものを
 * 手前にする (重ねるトランジションで次のクリップが前のクリップの上に来る)。
 */
export function compareDrawOrder(
  a: ClipTiming & { trackId: string },
  b: ClipTiming & { trackId: string },
  trackOrder: Map<string, number>
): number {
  return (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0) || a.start - b.start
}

export interface ClipFramePlan {
  /** クリップが最初にアクティブになる出力フレーム番号 */
  firstFrameIndex: number
  /** アクティブな各出力フレームで必要な素材内時刻 (フレーム順) */
  timestamps: number[]
}

/**
 * クリップがアクティブになる全出力フレームの素材内時刻を事前計算する。
 * speed > 0 なら timestamps は単調非減少になり、シーケンシャルデコードの
 * 前提が成立する。1 フレームもアクティブでなければ null。
 */
export function clipSourceTimestamps(
  clip: ClipTiming,
  rangeStart: number,
  fps: number,
  totalFrames: number
): ClipFramePlan | null {
  let firstFrameIndex = -1
  const timestamps: number[] = []
  for (let i = 0; i < totalFrames; i++) {
    const t = rangeStart + i / fps
    if (!isClipActiveAt(clip, t)) {
      // アクティブ区間は連続なので、一度入って抜けたら以降は現れない
      if (firstFrameIndex >= 0) break
      continue
    }
    if (firstFrameIndex < 0) firstFrameIndex = i
    timestamps.push(Math.max(0, mapClipTimeToSource(clip, t)))
  }
  if (firstFrameIndex < 0) return null
  return { firstFrameIndex, timestamps }
}

// ---------- フレーム供給元の選定 ----------

export type SourceKind = 'decoder' | 'element'

export interface SelectSourceInput {
  /** VideoDecoder API が存在するか */
  hasDecoder: boolean
  /** mediabunny がコンテナをパースできたか */
  parsedOk: boolean
  /** トラックのコーデックをこの環境でデコードできるか */
  canDecode: boolean
  /** クリップの再生速度 (負値 = 逆再生はシーケンシャルデコード不可) */
  speed: number
  /** 現在アクティブな DecoderFrameSource の数 */
  activeDecoders: number
  /** 同時デコーダ数の上限 */
  maxDecoders: number
}

/** デコーダパスを使えるか判定。使えない場合は <video> シークにフォールバック */
export function selectSourceKind(input: SelectSourceInput): SourceKind {
  if (!input.hasDecoder || !input.parsedOk || !input.canDecode) return 'element'
  if (!(input.speed > 0)) return 'element'
  if (input.activeDecoders >= input.maxDecoders) return 'element'
  return 'decoder'
}
