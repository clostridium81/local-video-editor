// ============================================================
// ブラウザ機能検出
// ============================================================

export const hasWebCodecs =
  typeof (globalThis as any).VideoEncoder !== 'undefined' &&
  typeof (globalThis as any).AudioEncoder !== 'undefined' &&
  typeof (globalThis as any).VideoFrame !== 'undefined' &&
  typeof (globalThis as any).AudioData !== 'undefined'

export const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined'

export interface CodecConfig {
  codec: string
  hardwareAcceleration?: 'prefer-hardware' | 'prefer-software' | 'no-preference'
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
  // H.264 Baseline L3.1 (720p30) / L4.0 (1080p30)
  baseline_1080p: 'avc1.42E028',
  main_1080p: 'avc1.4D0028',
  high_1080p: 'avc1.640028'
}

export const AAC_CODEC = 'mp4a.40.2'
export const VP9_CODEC = 'vp09.00.10.08'
export const OPUS_CODEC = 'opus'
