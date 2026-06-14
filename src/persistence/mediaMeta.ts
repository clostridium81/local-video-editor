import type { AssetKind } from '../types/project'

// ============================================================
// File から AssetKind / メタデータを推測
// ============================================================

export function detectAssetKind(file: File): AssetKind | null {
  const t = file.type
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('audio/')) return 'audio'
  // 拡張子フォールバック (type が空のこともある)
  const name = file.name.toLowerCase()
  if (/\.(mp4|webm|mov|mkv|m4v)$/.test(name)) return 'video'
  if (/\.(png|jpg|jpeg|gif|webp|bmp|avif)$/.test(name)) return 'image'
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(name)) return 'audio'
  return null
}

interface MediaMeta {
  duration?: number
  width?: number
  height?: number
}

export async function extractMediaMeta(
  file: File,
  kind: AssetKind
): Promise<MediaMeta> {
  const url = URL.createObjectURL(file)
  try {
    if (kind === 'image') return await extractImageMeta(url)
    if (kind === 'video') return await extractVideoMeta(url)
    if (kind === 'audio') return await extractAudioMeta(url)
    return {}
  } finally {
    URL.revokeObjectURL(url)
  }
}

function extractImageMeta(url: string): Promise<MediaMeta> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました'))
    img.src = url
  })
}

/**
 * MediaRecorder 由来の WebM 等は loadedmetadata 時点で duration が
 * Infinity のことがある。末尾へ仮シークすると durationchange で
 * 実時間が確定するので、それを待つ (上限 3 秒)。
 */
function resolveDuration(
  el: HTMLVideoElement | HTMLAudioElement
): Promise<number | undefined> {
  if (isFinite(el.duration)) return Promise.resolve(el.duration)
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      el.ondurationchange = null
      resolve(undefined)
    }, 3000)
    el.ondurationchange = () => {
      if (isFinite(el.duration) && el.duration > 0) {
        window.clearTimeout(timeout)
        el.ondurationchange = null
        resolve(el.duration)
      }
    }
    el.currentTime = 1e101
  })
}

function extractVideoMeta(url: string): Promise<MediaMeta> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = async () => {
      const duration = await resolveDuration(v)
      resolve({
        duration,
        width: v.videoWidth,
        height: v.videoHeight
      })
    }
    v.onerror = () => reject(new Error('動画のメタデータ取得に失敗しました'))
    v.src = url
  })
}

function extractAudioMeta(url: string): Promise<MediaMeta> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    a.onloadedmetadata = async () => {
      const duration = await resolveDuration(a)
      resolve({ duration })
    }
    a.onerror = () => reject(new Error('音声のメタデータ取得に失敗しました'))
    a.src = url
  })
}
