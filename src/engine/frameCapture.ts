// ============================================================
// 動画素材の 1 コマを静止画 (PNG) として取り出す
// ============================================================
// フリーズフレーム用。エフェクト等は掛けない素の画 (クリップ側の設定を
// 静止画クリップへ引き継いで同じ見た目にする)。

export async function captureVideoFrame(url: string, time: number): Promise<Blob> {
  const el = document.createElement('video')
  el.muted = true
  el.playsInline = true
  el.preload = 'auto'
  try {
    el.src = url
    await once(el, 'loadeddata')
    const dur = Number.isFinite(el.duration) ? el.duration : time
    // 末尾ちょうどはデコードできない環境があるので少し手前にする
    const target = Math.max(0, Math.min(time, Math.max(0, dur - 0.001)))
    if (Math.abs(el.currentTime - target) > 1e-4) {
      const seeked = once(el, 'seeked')
      el.currentTime = target
      await seeked
    }
    const w = el.videoWidth
    const h = el.videoHeight
    if (!w || !h) throw new Error('動画の画を読み取れませんでした')
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D コンテキストが取得できません')
    ctx.drawImage(el, 0, 0, w, h)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('画像に変換できませんでした'))), 'image/png')
    )
  } finally {
    el.removeAttribute('src')
    el.load()
  }
}

/** イベントを待つ。応答が無いまま止まらないよう timeoutMs で失敗にする */
function once(el: HTMLMediaElement, name: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('動画の読み込みに時間がかかりすぎています'))
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      el.removeEventListener(name, ok)
      el.removeEventListener('error', ng)
    }
    const ok = () => {
      cleanup()
      resolve()
    }
    const ng = () => {
      cleanup()
      reject(new Error('動画を読み込めませんでした'))
    }
    el.addEventListener(name, ok)
    el.addEventListener('error', ng)
  })
}
