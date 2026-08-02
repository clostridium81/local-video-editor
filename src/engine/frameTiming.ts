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
  start: number
  duration: number
  sourceIn?: number
  speed?: number
}

/** タイムライン時刻 t (絶対秒) → 素材内時刻 (秒) */
export function mapClipTimeToSource(clip: ClipTiming, t: number): number {
  const speed = clip.speed ?? 1
  return (t - clip.start) * speed + (clip.sourceIn ?? 0)
}

/** エクスポートループと同一の条件: フレーム時刻 t でクリップが描画対象か */
export function isClipActiveAt(clip: ClipTiming, t: number): boolean {
  return t >= clip.start && t < clip.start + clip.duration
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
