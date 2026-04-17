import type { Easing, Keyframe, Keyframes, KeyframeableProperty } from '../types/project'

// ============================================================
// キーフレーム補間
// ============================================================

export function easingFn(kind: Easing): (t: number) => number {
  switch (kind) {
    case 'easeIn':
      return t => t * t
    case 'easeOut':
      return t => 1 - (1 - t) * (1 - t)
    case 'easeInOut':
      return t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
    case 'linear':
    default:
      return t => t
  }
}

/**
 * 指定 localTime における keyframes の補間値を返す。
 * - kfs 空 / undefined → baseline
 * - 最初より前 → kfs[0].value
 * - 最後より後 → kfs[last].value
 * - それ以外 → 2点間で easing(kfs[i+1].easing) を使って補間
 */
export function sampleKeyframes(
  kfs: Keyframe[] | undefined,
  localTime: number,
  baseline: number
): number {
  if (!kfs || kfs.length === 0) return baseline
  if (kfs.length === 1) return kfs[0].value

  // 線形探索 (通常 KF は少ない)。順序前提
  const sorted = kfs // 想定: insertKeyframe で常にソート済
  if (localTime <= sorted[0].time) return sorted[0].value
  const last = sorted[sorted.length - 1]
  if (localTime >= last.time) return last.value

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (localTime >= a.time && localTime <= b.time) {
      const span = b.time - a.time
      if (span <= 0) return b.value
      const nt = (localTime - a.time) / span
      const eased = easingFn(b.easing)(nt)
      return a.value + (b.value - a.value) * eased
    }
  }
  return baseline
}

export function insertKeyframe(
  kfs: Keyframe[] | undefined,
  kf: Keyframe,
  eps = 1e-4
): Keyframe[] {
  const arr = kfs ? [...kfs] : []
  // 同時刻 (ほぼ) は置き換え
  const idx = arr.findIndex(k => Math.abs(k.time - kf.time) < eps)
  if (idx >= 0) {
    arr[idx] = { ...arr[idx], ...kf }
  } else {
    arr.push(kf)
    arr.sort((a, b) => a.time - b.time)
  }
  return arr
}

export function removeKeyframeAt(
  kfs: Keyframe[] | undefined,
  time: number,
  eps = 1e-4
): Keyframe[] | undefined {
  if (!kfs) return undefined
  const arr = kfs.filter(k => Math.abs(k.time - time) >= eps)
  return arr.length > 0 ? arr : undefined
}

export function findKeyframeAt(
  kfs: Keyframe[] | undefined,
  time: number,
  eps = 1e-4
): Keyframe | undefined {
  if (!kfs) return undefined
  return kfs.find(k => Math.abs(k.time - time) < eps)
}

/**
 * localTime をまたがる既存 KF の前後値を返す。前/後どちらも無い場合は null。
 * 波形モードなどでの「隣接 KF にジャンプ」機能用。
 */
export function neighborKeyframes(
  kfs: Keyframe[] | undefined,
  localTime: number,
  eps = 1e-4
): { prev: Keyframe | null; next: Keyframe | null } {
  if (!kfs || kfs.length === 0) return { prev: null, next: null }
  let prev: Keyframe | null = null
  let next: Keyframe | null = null
  for (const k of kfs) {
    if (k.time < localTime - eps) prev = k
    else if (k.time > localTime + eps) {
      next = k
      break
    }
  }
  return { prev, next }
}

/**
 * クリップを splitLocal で分割するときの KF 分割ユーティリティ。
 * 左側は <= splitLocal の KF を保持、右側は time -= splitLocal して保持。
 * 分割境界に補間値を挟み込むことで動作を連続させる。
 */
export function splitKeyframes(
  kfs: Keyframe[] | undefined,
  splitLocal: number
): { left: Keyframe[] | undefined; right: Keyframe[] | undefined } {
  if (!kfs || kfs.length === 0) return { left: undefined, right: undefined }
  const leftArr: Keyframe[] = []
  const rightArr: Keyframe[] = []
  // 境界値を計算
  const boundaryValue = sampleKeyframes(kfs, splitLocal, NaN)
  const boundaryEasing: Easing = 'linear'
  let boundaryInLeft = false
  let boundaryInRight = false
  for (const k of kfs) {
    if (k.time < splitLocal - 1e-6) {
      leftArr.push(k)
    } else if (k.time > splitLocal + 1e-6) {
      rightArr.push({ ...k, time: k.time - splitLocal })
    } else {
      // ちょうど境界に既にある
      leftArr.push(k)
      rightArr.push({ ...k, time: 0 })
      boundaryInLeft = true
      boundaryInRight = true
    }
  }
  if (!boundaryInLeft && !Number.isNaN(boundaryValue) && leftArr.length > 0) {
    leftArr.push({ time: splitLocal, value: boundaryValue, easing: boundaryEasing })
  }
  if (!boundaryInRight && !Number.isNaN(boundaryValue) && rightArr.length > 0) {
    rightArr.unshift({ time: 0, value: boundaryValue, easing: boundaryEasing })
  }
  return {
    left: leftArr.length > 0 ? leftArr : undefined,
    right: rightArr.length > 0 ? rightArr : undefined
  }
}

export function splitAllKeyframes(
  kfs: Keyframes | undefined,
  splitLocal: number
): { left: Keyframes | undefined; right: Keyframes | undefined } {
  if (!kfs) return { left: undefined, right: undefined }
  const left: Keyframes = {}
  const right: Keyframes = {}
  let anyLeft = false
  let anyRight = false
  const props = Object.keys(kfs) as KeyframeableProperty[]
  for (const p of props) {
    const { left: l, right: r } = splitKeyframes(kfs[p], splitLocal)
    if (l) {
      left[p] = l
      anyLeft = true
    }
    if (r) {
      right[p] = r
      anyRight = true
    }
  }
  return {
    left: anyLeft ? left : undefined,
    right: anyRight ? right : undefined
  }
}
