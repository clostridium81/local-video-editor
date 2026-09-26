// ============================================================
// 解析用の音声デコード (波形表示・ダッキング共通)
// ============================================================
// 表示・音量解析には高い音質は要らないので、8kHz に落としてデコードする
// (48kHz のままより約 1/6 のメモリ)。長い素材や多数の素材で同時にデコードが走り
// タブが落ちないよう、1 件ずつ順番に処理する。巨大なファイルは解析しない。
// (書き出しの音声ミックスは音質が必要なので別経路 = exportEngine)
// ============================================================

/** 解析用デコードの対象にする最大ファイルサイズ */
export const MAX_ANALYSIS_BYTES = 1024 * 1024 * 1024 // 1GB
export const ANALYSIS_SAMPLE_RATE = 8000

let queue: Promise<unknown> = Promise.resolve()

/** 直列化: 前の処理が終わってから fn を実行する (失敗しても後続は止めない) */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

export class TooLargeForAnalysisError extends Error {
  constructor(size: number) {
    super(`解析するには大きすぎるファイルです (${Math.round(size / 1024 / 1024)}MB)`)
    this.name = 'TooLargeForAnalysisError'
  }
}

/**
 * 解析用に音声をデコードする (低サンプルレート・1 件ずつ)。
 * 大きすぎるファイルは TooLargeForAnalysisError、音声が無い素材は decode の例外になる。
 */
export function decodeForAnalysis(blob: Blob): Promise<AudioBuffer> {
  if (blob.size > MAX_ANALYSIS_BYTES) return Promise.reject(new TooLargeForAnalysisError(blob.size))
  return serial(async () => {
    const Offline =
      (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext
    const bytes = await blob.arrayBuffer()
    if (Offline) {
      // decodeAudioData はコンテキストのサンプルレートに変換して返す。
      // OfflineAudioContext は音声デバイスを使わず、ユーザー操作も要らない
      const ctx = new Offline(1, 1, ANALYSIS_SAMPLE_RATE)
      return (await ctx.decodeAudioData(bytes)) as AudioBuffer
    }
    const Ctx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext
    if (!Ctx) throw new Error('AudioContext 未対応')
    const ctx = new Ctx()
    try {
      return (await ctx.decodeAudioData(bytes)) as AudioBuffer
    } finally {
      ctx.close().catch(() => {})
    }
  })
}
