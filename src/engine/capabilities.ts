// ============================================================
// ブラウザ機能検出
// ============================================================

export const hasWebCodecs =
  typeof (globalThis as any).VideoEncoder !== 'undefined' &&
  typeof (globalThis as any).AudioEncoder !== 'undefined' &&
  typeof (globalThis as any).VideoFrame !== 'undefined' &&
  typeof (globalThis as any).AudioData !== 'undefined'

export const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined'

/** エクスポートのシーケンシャルデコード (frameSource.ts) に使う */
export const hasVideoDecoder = typeof (globalThis as any).VideoDecoder !== 'undefined'

export interface CodecConfig {
  codec: string
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software' | 'no-preference'
  latencyMode?: 'quality' | 'realtime'
  bitrate?: number
  width?: number
  height?: number
  framerate?: number
  sampleRate?: number
  numberOfChannels?: number
}

export async function canEncodeVideo(cfg: CodecConfig): Promise<boolean> {
  if (!hasWebCodecs) return false
  try {
    const res = await (globalThis as any).VideoEncoder.isConfigSupported(cfg)
    return !!res?.supported
  } catch {
    return false
  }
}

export async function canEncodeAudio(cfg: CodecConfig): Promise<boolean> {
  if (!hasWebCodecs) return false
  try {
    const res = await (globalThis as any).AudioEncoder.isConfigSupported(cfg)
    return !!res?.supported
  } catch {
    return false
  }
}

export const AVC_CODECS = {
  // H.264 Baseline L3.1 (720p30) / L4.0 (1080p30) / L4.2 (1080p60)
  baseline_1080p: 'avc1.42E028',
  main_1080p: 'avc1.4D0028',
  high_1080p: 'avc1.640028',
  high_1080p60: 'avc1.64002A'
}

/**
 * 解像度と fps から H.264 High Profile の Level を選ぶ。
 * Level ごとの上限 (1 フレームのマクロブロック数 / 毎秒のマクロブロック数) を
 * 満たす最小の Level を返す。縦長 (1080×1920) や 21:9 (2560×1080) 向け。
 */
export function avcCodecFor(width: number, height: number, fps: number): string {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16)
  const mbps = frameMbs * fps
  const levels: Array<[string, number, number]> = [
    ['28', 8192, 245760], // 4.0
    ['2A', 8704, 522240], // 4.2
    ['32', 22080, 589824], // 5.0
    ['33', 36864, 983040], // 5.1
    ['34', 36864, 2073600] // 5.2
  ]
  for (const [hex, maxFs, maxMbps] of levels) {
    if (frameMbs <= maxFs && mbps <= maxMbps) return `avc1.6400${hex}`
  }
  return 'avc1.640034'
}

export const AAC_CODEC = 'mp4a.40.2'
export const VP9_CODEC = 'vp09.00.10.08'
export const OPUS_CODEC = 'opus'
