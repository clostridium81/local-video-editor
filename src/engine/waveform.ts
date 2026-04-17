// ============================================================
// 音声波形ピーク生成 + 描画
// ============================================================
// - AudioContext.decodeAudioData でデコード
// - 指定 peaksPerSecond で min/max ピーク配列を生成
// - モジュール内にキャッシュを持つ (assetId ベース)
// ============================================================

export interface Peaks {
  /** 各バケット内の最小値 (-1..1) */
  min: Float32Array
  /** 各バケット内の最大値 (-1..1) */
  max: Float32Array
  /** 1 秒あたりの peak 数 */
  peaksPerSecond: number
  /** 元の再生時間 (秒) */
  duration: number
}

export async function generatePeaks(
  blob: Blob,
  peaksPerSecond = 120
): Promise<Peaks> {
  const arrayBuf = await blob.arrayBuffer()
  // 既存の AudioContext を作り直すコストはあるが、ユーザ操作(ユーザ gesture)が
  // 必要な resume を避けるため、decodeAudioData のために OfflineAudioContext は使わず
  // AudioContext を使って decodeAudioData してすぐ close する
  const Ctx =
    (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext
  if (!Ctx) throw new Error('AudioContext 未対応')
  const ctx = new Ctx()
  let audioBuf: AudioBuffer
  try {
    audioBuf = await ctx.decodeAudioData(arrayBuf)
  } finally {
    try {
      await ctx.close()
    } catch {
      /* noop */
    }
  }
  const duration = audioBuf.duration
  const totalBuckets = Math.max(1, Math.ceil(duration * peaksPerSecond))
  const samplesPerBucket = Math.max(1, Math.floor(audioBuf.length / totalBuckets))
  const min = new Float32Array(totalBuckets)
  const max = new Float32Array(totalBuckets)

  // 全チャンネル合成 (ステレオ→モノラル相当)
  const chans: Float32Array[] = []
  for (let c = 0; c < audioBuf.numberOfChannels; c++) {
    chans.push(audioBuf.getChannelData(c))
  }

  for (let b = 0; b < totalBuckets; b++) {
    const startS = b * samplesPerBucket
    const endS = Math.min(audioBuf.length, startS + samplesPerBucket)
    let mn = Infinity
    let mx = -Infinity
    for (let i = startS; i < endS; i++) {
      let sum = 0
      for (const ch of chans) sum += ch[i]
      const v = sum / chans.length
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    if (!Number.isFinite(mn)) mn = 0
    if (!Number.isFinite(mx)) mx = 0
    min[b] = mn
    max[b] = mx
  }

  return { min, max, peaksPerSecond, duration }
}

// ---------- キャッシュ ----------

interface CacheEntry {
  peaks?: Peaks
  error?: Error
  promise?: Promise<Peaks>
}

const cache = new Map<string, CacheEntry>()

/**
 * 非同期にピークを取得 (キャッシュ付き)。
 * blobLoader は必要時のみ呼ばれる。
 */
export function getOrGeneratePeaks(
  assetId: string,
  blobLoader: () => Promise<Blob | null>,
  peaksPerSecond = 120
): Promise<Peaks | null> {
  const existing = cache.get(assetId)
  if (existing?.peaks) return Promise.resolve(existing.peaks)
  if (existing?.promise) return existing.promise.catch(() => null)
  const entry: CacheEntry = {}
  const p = (async () => {
    const blob = await blobLoader()
    if (!blob) throw new Error('blob missing')
    const peaks = await generatePeaks(blob, peaksPerSecond)
    entry.peaks = peaks
    return peaks
  })()
  entry.promise = p
  cache.set(assetId, entry)
  return p.catch(err => {
    entry.error = err as Error
    return null
  })
}

export function clearWaveformCache(assetId?: string) {
  if (assetId) cache.delete(assetId)
  else cache.clear()
}

// ---------- 描画 ----------

/**
 * Peaks を指定矩形に描画。startSec/endSec はクリップ内の表示時間範囲 (sourceIn 込み)。
 */
export function drawPeaks(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  peaks: Peaks,
  startSec: number,
  endSec: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
) {
  if (w <= 0 || h <= 0) return
  const midY = y + h / 2
  const halfH = h / 2
  ctx.save()
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.beginPath()
  const bucketCount = peaks.min.length
  const clampedEnd = Math.min(endSec, peaks.duration)
  const clampedStart = Math.max(0, Math.min(startSec, clampedEnd))
  const span = Math.max(1e-6, clampedEnd - clampedStart)
  for (let px = 0; px < w; px++) {
    const t0 = clampedStart + (px / w) * span
    const t1 = clampedStart + ((px + 1) / w) * span
    const b0 = Math.max(0, Math.min(bucketCount - 1, Math.floor(t0 * peaks.peaksPerSecond)))
    const b1 = Math.max(b0, Math.min(bucketCount - 1, Math.floor(t1 * peaks.peaksPerSecond)))
    let mn = 0
    let mx = 0
    for (let b = b0; b <= b1; b++) {
      if (peaks.min[b] < mn) mn = peaks.min[b]
      if (peaks.max[b] > mx) mx = peaks.max[b]
    }
    const yTop = midY + mn * halfH
    const yBot = midY + mx * halfH
    if (Math.abs(yBot - yTop) < 1) {
      ctx.fillRect(x + px, midY - 0.5, 1, 1)
    } else {
      ctx.fillRect(x + px, yTop, 1, yBot - yTop)
    }
  }
  ctx.restore()
}
