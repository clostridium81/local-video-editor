import type {
  ProjectState,
  VideoClip,
  AudioClip,
  ImageClip
} from '../types/project'
import { getAssetObjectURL, loadAssetBlob } from '../persistence/assetStore'
import { computeEffective, drawClip, LayerBuffer, type VisualSource } from './renderer'
import { PositionedBlobWriter } from './positionedBlob'
import { buildStoredZip } from '../persistence/zipStream'
import {
  avcCodecFor,
  AAC_CODEC,
  VP9_CODEC,
  OPUS_CODEC,
  hasWebCodecs,
  canEncodeVideo,
  canEncodeAudio,
  type CodecConfig
} from './capabilities'
import {
  ExportMediaCache,
  createFrameSourceForClip,
  type FrameSource,
  type VideoFrameRef
} from './frameSource'
import {
  clipSourceSpan,
  clipSourceTimestamps,
  compareDrawOrder,
  sourceAdvance,
  speedAt,
  isClipActiveAt,
  mapClipTimeToSource,
  type SourceKind
} from './frameTiming'
import { ExportProfiler, logProfile } from './exportProfiler'
import {
  buildDuckActivity,
  duckGain,
  hasDucking,
  rmsFromChannels,
  type DuckActivity,
  type RmsTrack
} from './ducking'

// ============================================================
// MP4 / WebM エクスポート (WebCodecs + mp4-muxer / webm-muxer)
// ============================================================
// 実装戦略:
// 1. OffscreenCanvas (fallback: <canvas>) を自前で作る
// 2. 各 VideoClip に FrameSource を用意 (frameSource.ts)。
//    通常は mediabunny + VideoDecoder のシーケンシャルデコード、
//    使えない場合は従来の非表示 <video> + seek にフォールバック
// 3. フレーム毎に t = i/fps で以下を実行:
//    a. アクティブな VideoClip のフレームを FrameSource から取得
//    b. 合成描画
//    c. VideoFrame(canvas, { timestamp })
//    d. encoder.encode(frame) (encodeQueueSize バックプレッシャ付き)
// 4. 音声は OfflineAudioContext で全クリップをミックスし、
//    結果 AudioBuffer を AudioData に区切って encode
// 5. muxer で多重化
// ============================================================

type Progress = {
  phase: 'prepare' | 'video' | 'audio' | 'mux' | 'done'
  done: number
  total: number
  message?: string
}

export interface ExportOptions {
  /**
   * png: startTime の 1 枚 / png-seq: 範囲の全フレームの連番 PNG (ZIP) / wav: 音声のみ
   */
  format: 'mp4' | 'webm' | 'gif' | 'png' | 'png-seq' | 'wav'
  /** png / png-seq で背景色を塗らず透明にする */
  transparent?: boolean
  width: number
  height: number
  fps: number
  videoBitrate: number
  audioBitrate: number
  includeAudio: boolean
  /** 範囲指定 (省略時はプロジェクト全体) */
  startTime?: number
  endTime?: number
  signal?: AbortSignal
  onProgress?: (p: Progress) => void
}

export interface ExportResult {
  blob: Blob
  filename: string
  mime: string
  /** 書き出せたが注意が必要な点 (音声を読めなかった素材など) */
  warnings: string[]
}

function notifyProgress(opts: ExportOptions, p: Progress) {
  opts.onProgress?.(p)
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

// ---------- 画像のロード ----------

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = url
  await new Promise<void>((resolve, reject) => {
    img.addEventListener('load', () => resolve(), { once: true })
    img.addEventListener('error', () => reject(new Error('image load failed')), { once: true })
  })
  return img
}

// ---------- フレーム合成 (exportEngine 専用) ----------

interface RenderContext {
  state: ProjectState
  currentFrames: Map<string, VideoFrameRef> // clipId -> 現フレーム (毎フレーム更新)
  images: Map<string, HTMLImageElement> // assetId -> img
  canvas: OffscreenCanvas | HTMLCanvasElement
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  buffer: LayerBuffer
  bgBuffer: LayerBuffer
}

function drawFrame(rc: RenderContext, t: number, transparent = false) {
  const { state, ctx } = rc
  const { width, height, backgroundColor } = state.meta

  ctx.save()
  ctx.filter = 'none' as any
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (transparent) {
    ctx.clearRect(0, 0, width, height)
  } else {
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, width, height)
  }
  ctx.restore()

  const tracksByOrder = [...state.tracks].sort((a, b) => a.order - b.order)
  const trackOrderMap = new Map(tracksByOrder.map((tr, i) => [tr.id, i]))

  const activeClips = state.clips
    .filter(c => isClipActiveAt(c, t))
    .sort((a, b) => compareDrawOrder(a, b, trackOrderMap))

  const target = { ctx, width, height, buffer: rc.buffer, bgBuffer: rc.bgBuffer }
  for (const clip of activeClips) {
    const track = state.tracks.find(tr => tr.id === clip.trackId)
    if (track?.kind === 'audio') continue

    let source: VisualSource | null = null
    if (clip.kind === 'video') {
      const ref = rc.currentFrames.get(clip.id)
      if (!ref) continue
      source = { src: ref.image, width: ref.width, height: ref.height }
    } else if (clip.kind === 'image') {
      const img = rc.images.get((clip as ImageClip).assetId)
      if (!img) continue
      source = { src: img, width: img.naturalWidth, height: img.naturalHeight }
    }
    drawClip(target, clip, t, source)
  }
}

// ---------- 音声ミックス (OfflineAudioContext) ----------

async function renderAudioMix(
  state: ProjectState,
  totalDuration: number,
  sampleRate: number,
  signal?: AbortSignal,
  rangeOffset = 0,
  warnings: string[] = []
): Promise<AudioBuffer> {
  const Ctx =
    (globalThis as any).OfflineAudioContext ||
    (globalThis as any).webkitOfflineAudioContext
  if (!Ctx) throw new Error('OfflineAudioContext 未対応')
  const oc = new Ctx(2, Math.ceil(sampleRate * totalDuration), sampleRate)

  type AClip = { clip: AudioClip | VideoClip; assetId: string }
  const anySolo = state.tracks.some(t => t.solo)
  const mutedTracks = new Set(state.tracks.filter(t => t.muted).map(t => t.id))
  const soloTracks = new Set(state.tracks.filter(t => t.solo).map(t => t.id))
  // 鳴らさないクリップ (ミュート・ソロ対象外・書き出し範囲外) の素材はデコードしない。
  // 素材ごとの全音声をメモリに展開するので、不要な分まで読むと長い素材でタブが落ちうる。
  // (範囲の少し外はダッキングの戻りに影響するので 1 秒の余裕を持つ)
  const rangeEndAbs = rangeOffset + totalDuration
  const audible: AClip[] = []
  for (const c of state.clips) {
    if (c.kind !== 'audio' && c.kind !== 'video') continue
    if (c.muted || mutedTracks.has(c.trackId)) continue
    if (anySolo && !soloTracks.has(c.trackId)) continue
    if (c.start + c.duration < rangeOffset - 1 || c.start > rangeEndAbs + 1) continue
    audible.push({ clip: c, assetId: c.assetId })
  }

  // 素材ごとに decodeAudioData (重複排除)
  const decoded = new Map<string, AudioBuffer>()
  const failed: string[] = []
  for (const a of audible) {
    if (decoded.has(a.assetId) || failed.includes(a.assetId)) continue
    checkAbort(signal)
    const blob = await loadAssetBlob(state.meta.id, a.assetId)
    if (!blob) {
      failed.push(a.assetId)
      continue
    }
    try {
      const arr = await blob.arrayBuffer()
      const buf = await (oc.decodeAudioData(arr) as Promise<AudioBuffer>)
      decoded.set(a.assetId, buf)
    } catch {
      // 音声トラックの無い動画もここに来る (その場合は無音で正しい)
      failed.push(a.assetId)
    }
  }
  if (failed.length) {
    const names = failed.map(id => state.assets[id]?.name ?? id)
    warnings.push(`音声を読み込めなかった素材があります (音声の無い動画なら問題ありません): ${names.join('、')}`)
  }

  // ダッキング: デコード済みの音声から「他の音が鳴っている度合い」を求める
  let duck: DuckActivity | null = null
  if (hasDucking(state.clips)) {
    const rms = new Map<string, RmsTrack>()
    for (const [assetId, buf] of decoded) {
      const chans: Float32Array[] = []
      for (let ch = 0; ch < buf.numberOfChannels; ch++) chans.push(buf.getChannelData(ch))
      rms.set(assetId, rmsFromChannels(chans, buf.sampleRate))
    }
    duck = buildDuckActivity(state, rms)
  }

  // マスターゲイン
  const masterGain = oc.createGain()
  masterGain.gain.value = state.timeline.masterVolume ?? 1
  masterGain.connect(oc.destination)

  // トラックごとのゲイン
  const trackGains = new Map<string, GainNode>()
  for (const tr of state.tracks) {
    if (tr.kind !== 'audio') continue
    const g = oc.createGain()
    const tv = tr.volume ?? 1
    const muteBySolo = anySolo && !tr.solo
    g.gain.value = tr.muted || muteBySolo ? 0 : tv
    g.connect(masterGain)
    trackGains.set(tr.id, g)
  }
  // video トラックの音声は直接 master へ
  function getDestForTrack(trackId: string): AudioNode {
    return trackGains.get(trackId) ?? masterGain
  }

  for (const a of audible) {
    checkAbort(signal)
    const buf = decoded.get(a.assetId)
    if (!buf) continue
    const c = a.clip
    const track = state.tracks.find(t => t.id === c.trackId)
    if (track?.muted || c.muted) continue
    // ソロ: プレビューと同じく、どれかのトラックがソロなら
    // 非ソロのトラック上のクリップは鳴らさない。
    // (video トラックのクリップは trackGains を通らず master 直結なので
    //  gain だけでは落とせない → クリップ単位でスキップする)
    if (anySolo && !track?.solo) continue

    const src = oc.createBufferSource()
    src.buffer = buf

    const gain = oc.createGain()

    // 出力 OfflineAudioContext の時間軸 = (絶対時刻 - rangeOffset)。
    // src.start も rangeOffset を引いた相対時刻で予約しているので、gain も
    // 同じ時間軸でないと、範囲指定エクスポート時にエンベロープが音源とずれる。
    // 0 未満になる時刻は AudioParam が受け付けないため 0 にクランプする。
    const toOutT = (absT: number) => Math.max(0, absT - rangeOffset)
    // 音量エンベロープ = 音量 (キーフレーム) × トランジションの fade × 音声フェード。
    // プレビューと同じ computeEffective() で評価する
    // ダッキング (他の音が鳴っている間は下げる) もここで掛ける
    const env = (lt: number) =>
      Math.max(
        0,
        Math.min(2, computeEffective(c, c.start + lt).eff.volume * duckGain(duck, c, c.start + lt))
      )
    const hasEnvelope =
      (duck !== null && c.kind === 'audio' && (c.ducking?.amount ?? 0) > 0) ||
      (c.keyframes?.volume?.length ?? 0) > 0 ||
      c.transitionIn?.type === 'fade' ||
      c.transitionOut?.type === 'fade' ||
      (c.audioFade?.in ?? 0) > 0 ||
      (c.audioFade?.out ?? 0) > 0

    if (hasEnvelope) {
      const stepSec = 0.02
      const lt0 = Math.max(0, rangeOffset - c.start)
      gain.gain.setValueAtTime(env(lt0), toOutT(c.start + lt0))
      for (let lt = lt0 + stepSec; lt < c.duration; lt += stepSec) {
        gain.gain.linearRampToValueAtTime(env(lt), toOutT(c.start + lt))
      }
      gain.gain.linearRampToValueAtTime(env(c.duration), toOutT(c.start + c.duration))
    } else {
      gain.gain.value = env(0)
    }

    // EQ 3-band (optional)
    const eq = (c as AudioClip).eq
    let chainHead: AudioNode = src
    if (eq) {
      if (eq.low !== undefined && eq.low !== 0) {
        const f = oc.createBiquadFilter()
        f.type = 'lowshelf'
        f.frequency.value = 200
        f.gain.value = Math.max(-24, Math.min(24, eq.low))
        chainHead.connect(f)
        chainHead = f
      }
      if (eq.mid !== undefined && eq.mid !== 0) {
        const f = oc.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = 1000
        f.Q.value = 1
        f.gain.value = Math.max(-24, Math.min(24, eq.mid))
        chainHead.connect(f)
        chainHead = f
      }
      if (eq.high !== undefined && eq.high !== 0) {
        const f = oc.createBiquadFilter()
        f.type = 'highshelf'
        f.frequency.value = 5000
        f.gain.value = Math.max(-24, Math.min(24, eq.high))
        chainHead.connect(f)
        chainHead = f
      }
    }
    chainHead.connect(gain)
    gain.connect(getDestForTrack(c.trackId))

    const offsetInAsset = c.sourceIn ?? 0
    const startInOutput = c.start - rangeOffset
    if (startInOutput + c.duration <= 0) continue
    const actualStart = Math.max(0, startInOutput)
    const skip = actualStart - startInOutput // 範囲開始で途中再生の場合

    // 再生速度: 速度カーブがあれば playbackRate を時間に沿って変化させる。
    // 素材の進み方 (= 速度の積分) は映像側の mapClipTimeToSource と一致する
    const clampRate = (v: number) => Math.max(0.0625, Math.min(16, v))
    if (c.speedCurve?.length) {
      src.playbackRate.setValueAtTime(clampRate(speedAt(c, skip)), actualStart)
      const stepSec = 0.05
      for (let lt = skip + stepSec; lt < c.duration; lt += stepSec) {
        src.playbackRate.linearRampToValueAtTime(clampRate(speedAt(c, lt)), toOutT(c.start + lt))
      }
      src.playbackRate.linearRampToValueAtTime(clampRate(speedAt(c, c.duration)), toOutT(c.start + c.duration))
    } else {
      src.playbackRate.value = clampRate(c.speed ?? 1)
    }
    const srcOffset = offsetInAsset + sourceAdvance(c, skip)
    src.start(actualStart, srcOffset, Math.max(0, clipSourceSpan(c) - sourceAdvance(c, skip)))
  }

  return await oc.startRendering()
}

// ---------- クリップ → FrameSource の解決 ----------

interface SourceEntry {
  source: FrameSource
  kind: SourceKind
  /** クリップの終了時刻 (これを過ぎたら close) */
  end: number
}

/**
 * エクスポートループの各フレームで、アクティブな VideoClip のフレームを
 * FrameSource から取得して RenderContext.currentFrames に流し込む。
 * ソースはクリップが最初にアクティブになった時に生成し、終わったら即解放。
 */
class VideoFrameResolver {
  // null = 生成失敗 (以後このクリップはスキップ)
  private sources = new Map<string, SourceEntry | null>()
  private decoderCount = 0
  /** ソース種別の使用実績 (ログ用) */
  kinds = { decoder: 0, element: 0 }

  constructor(
    private projectId: string,
    private videoClips: VideoClip[],
    private cache: ExportMediaCache,
    private rangeStart: number,
    private fps: number,
    private totalFrames: number
  ) {}

  async resolveFrames(t: number, out: Map<string, VideoFrameRef>): Promise<void> {
    out.clear()
    for (const [id, entry] of [...this.sources]) {
      if (entry && t >= entry.end) {
        entry.source.close()
        if (entry.kind === 'decoder') this.decoderCount--
        this.sources.delete(id)
      }
    }
    const waits: Promise<void>[] = []
    for (const vc of this.videoClips) {
      if (!isClipActiveAt(vc, t)) continue
      let entry = this.sources.get(vc.id)
      if (entry === undefined) {
        entry = await this.createFor(vc)
        this.sources.set(vc.id, entry)
      }
      if (!entry) continue
      waits.push(
        entry.source.getFrameAt(Math.max(0, mapClipTimeToSource(vc, t))).then(ref => {
          if (ref) out.set(vc.id, ref)
        })
      )
    }
    await Promise.all(waits)
  }

  private async createFor(vc: VideoClip): Promise<SourceEntry | null> {
    const plan = clipSourceTimestamps(vc, this.rangeStart, this.fps, this.totalFrames)
    if (!plan) return null
    const created = await createFrameSourceForClip({
      projectId: this.projectId,
      assetId: vc.assetId,
      speed: vc.speedCurve?.length ? Math.min(...vc.speedCurve.map(p => p.speed)) : vc.speed ?? 1,
      timestamps: plan.timestamps,
      cache: this.cache,
      activeDecoders: this.decoderCount
    })
    if (!created) return null
    if (created.kind === 'decoder') this.decoderCount++
    this.kinds[created.kind]++
    return { source: created.source, kind: created.kind, end: vc.start + vc.duration }
  }

  closeAll() {
    for (const entry of this.sources.values()) {
      try {
        entry?.source.close()
      } catch {
        // ignore
      }
    }
    this.sources.clear()
    this.decoderCount = 0
  }
}

// ---------- VideoEncoder 設定 ----------

/** HW アクセラレーション優先 → 指定なしの順で通る設定を選ぶ */
async function pickVideoEncoderConfig(base: CodecConfig): Promise<CodecConfig> {
  const candidates: CodecConfig[] = [
    { ...base, hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality' },
    { ...base, latencyMode: 'quality' },
    base
  ]
  for (const cfg of candidates) {
    if (await canEncodeVideo(cfg)) return cfg
  }
  return base
}

/** エンコードキューが溜まりすぎたら掃けるまで待つ (メモリ抑制) */
const MAX_ENCODE_QUEUE = 8

/**
 * エンコーダの状態監視: エラーコールバックを記録し、待ちの途中でも
 * キャンセル・エラーで抜けられるようにする (固まったまま閉じられなくなるのを防ぐ)
 */
class EncoderWatch {
  error: Error | null = null
  private waiters = new Set<(e: Error) => void>()
  fail(e: any) {
    this.error = e instanceof Error ? e : new Error(String(e?.message ?? e))
    for (const w of this.waiters) w(this.error)
    this.waiters.clear()
  }
  check(signal?: AbortSignal) {
    checkAbort(signal)
    if (this.error) throw this.error
  }
  /** p の完了を待つ。キャンセル・エンコーダエラー・時間切れで例外にする */
  async guard<T>(p: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, what: string): Promise<T> {
    this.check(signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    let waiter: ((e: Error) => void) | undefined
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what}が応答しません (時間切れ)`)), timeoutMs)
          onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          signal?.addEventListener('abort', onAbort, { once: true })
          waiter = reject
          this.waiters.add(waiter)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      if (waiter) this.waiters.delete(waiter)
    }
  }
}

/** エンコーダの処理待ちの上限 (これを超えて進まなければ固まったとみなす) */
const ENCODER_STALL_MS = 60_000

async function waitEncoderQueue(
  encoder: any,
  watch: EncoderWatch,
  signal?: AbortSignal,
  profiler?: ExportProfiler
): Promise<void> {
  if (!(encoder.encodeQueueSize > MAX_ENCODE_QUEUE)) return
  profiler?.begin('encodeWait')
  const startedAt = Date.now()
  let lastSize = encoder.encodeQueueSize
  let lastProgress = startedAt
  while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
    watch.check(signal)
    if (encoder.encodeQueueSize < lastSize) {
      lastSize = encoder.encodeQueueSize
      lastProgress = Date.now()
    } else if (Date.now() - lastProgress > ENCODER_STALL_MS) {
      throw new Error('映像エンコーダが応答しません (時間切れ)')
    }
    // dequeue イベント非対応環境向けにタイムアウトとの併用
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 50)
      if (typeof encoder.addEventListener === 'function') {
        encoder.addEventListener(
          'dequeue',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true }
        )
      }
    })
  }
  profiler?.end('encodeWait')
}

// ---------- メインエクスポート ----------

export async function exportProject(
  state: ProjectState,
  opts: ExportOptions
): Promise<ExportResult> {
  const { width, height, fps, videoBitrate, audioBitrate, format, includeAudio, signal } = opts
  state = {
    ...state,
    meta: { ...state.meta, width, height, fps }
  }
  const rangeStart = Math.max(0, opts.startTime ?? 0)
  // 範囲未指定 (「ぜんぶ」) のときはコンテンツの末尾までにする。
  // timeline.duration は伸びる一方 (初期値 60s) なので、そのまま使うと
  // 中身のない黒い尾が出力されてしまう。
  const contentEnd =
    state.clips.length > 0
      ? Math.max(...state.clips.map(c => c.start + c.duration))
      : state.timeline.duration
  const defaultEnd = Math.max(rangeStart + 0.01, contentEnd)
  const rangeEnd = Math.min(state.timeline.duration, opts.endTime ?? defaultEnd)
  const rangeDur = Math.max(0.01, rangeEnd - rangeStart)
  const totalFrames = Math.max(1, Math.ceil(rangeDur * fps))

  const warnings: string[] = []

  // 静止画 / 連番 PNG / 音声のみは専用パス
  if (format === 'png' || format === 'png-seq') {
    return await exportImages(state, { ...opts, startTime: rangeStart, endTime: rangeEnd })
  }
  if (format === 'wav') {
    return await exportWav(state, { ...opts, startTime: rangeStart, endTime: rangeEnd })
  }

  // ここから先 (MP4 / WebM / GIF) は WebCodecs が必要
  if (!hasWebCodecs && format !== 'gif') throw new Error('このブラウザでは動画の書き出しができません')

  // GIF 出力は専用パス
  if (format === 'gif') {
    return await exportGIF(state, { ...opts, startTime: rangeStart, endTime: rangeEnd })
  }

  notifyProgress(opts, { phase: 'prepare', done: 0, total: 1, message: '準備中…' })
  // Web フォント・読み込んだフォントの準備が終わってから描く (文字だけ別書体になるのを防ぐ)
  await waitFontsReady()

  // ---------- muxer ----------
  let muxer: any
  let mimeType: string
  let videoCodecStr: string
  let audioCodecStr: string

  // 出力は位置指定の書き込みを順次 Blob に確定していく (全体を 1 つの ArrayBuffer に
  // 持たない)。長い書き出しでも出力サイズの数倍のメモリを使わない
  const writer = new PositionedBlobWriter()
  // mp4-muxer は整数の frameRate しか受け付けない (復元した作品の 29.97 等でも失敗させない)
  const muxFrameRate = Math.max(1, Math.round(fps))
  if (format === 'mp4') {
    const { Muxer, StreamTarget } = await import('mp4-muxer')
    // 解像度・fps に見合う Level を選ぶ (縦長や 21:9 は 1080p30 の Level 4.0 を超える)
    videoCodecStr = avcCodecFor(width, height, fps)
    audioCodecStr = AAC_CODEC
    muxer = new (Muxer as any)({
      target: new StreamTarget({
        onData: (data: Uint8Array, position: number) => writer.write(data, position),
        chunked: true,
        chunkSize: 8 * 1024 * 1024
      }),
      video: { codec: 'avc', width, height, frameRate: muxFrameRate },
      audio: includeAudio
        ? { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 }
        : undefined,
      // 'in-memory' は全データを最後まで保持するため使わない (moov は末尾になる)
      fastStart: false,
      firstTimestampBehavior: 'offset'
    })
    mimeType = 'video/mp4'
  } else {
    const { Muxer, StreamTarget } = await import('webm-muxer')
    videoCodecStr = VP9_CODEC
    audioCodecStr = OPUS_CODEC
    muxer = new (Muxer as any)({
      target: new StreamTarget({
        onData: (data: Uint8Array, position: number) => writer.write(data, position),
        chunked: true,
        chunkSize: 8 * 1024 * 1024
      }),
      video: { codec: 'V_VP9', width, height, frameRate: muxFrameRate },
      audio: includeAudio
        ? { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: 48000 }
        : undefined,
      firstTimestampBehavior: 'offset'
    })
    mimeType = 'video/webm'
  }

  // ---------- VideoEncoder ----------
  const profiler = new ExportProfiler()
  const VE = (globalThis as any).VideoEncoder
  const baseConfig = {
    codec: videoCodecStr,
    width,
    height,
    bitrate: videoBitrate,
    framerate: fps
  }
  // 選んだ設定で本当にエンコードできるかを先に確かめる (途中で不明なエラーにしない)
  if (!(await canEncodeVideo(baseConfig))) {
    throw new Error(
      `このブラウザでは ${format.toUpperCase()} ${width}×${height} ${fps}fps の書き出しに対応していません。` +
        '形式・画面サイズ・フレームレートを変えてください'
    )
  }
  if (includeAudio) {
    const audioOk = await canEncodeAudio({
      codec: audioCodecStr,
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: audioBitrate
    })
    if (!audioOk) {
      throw new Error(
        `このブラウザでは ${format.toUpperCase()} の音声を作れません。形式を変えるか「音声を含める」を外してください`
      )
    }
  }
  const encoderConfig = await pickVideoEncoderConfig(baseConfig)
  const watch = new EncoderWatch()
  const videoEncoder = new VE({
    output: (chunk: any, metadata: any) => {
      try {
        muxer.addVideoChunk(chunk, metadata)
      } catch (e) {
        watch.fail(e)
      }
    },
    error: (e: any) => {
      console.error('video encoder error', e)
      watch.fail(e)
    }
  })
  videoEncoder.configure(encoderConfig)

  // ---------- 素材準備 ----------
  const rc: RenderContext = {
    state,
    currentFrames: new Map(),
    images: new Map(),
    canvas: (globalThis as any).OffscreenCanvas
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height }),
    ctx: null as any,
    buffer: new LayerBuffer(),
    bgBuffer: new LayerBuffer()
  }
  rc.ctx = (rc.canvas as any).getContext('2d') as any

  const videoClips = state.clips.filter(c => c.kind === 'video') as VideoClip[]
  const mediaCache = new ExportMediaCache(state.meta.id)
  const resolver = new VideoFrameResolver(
    state.meta.id,
    videoClips,
    mediaCache,
    rangeStart,
    fps,
    totalFrames
  )
  let audioEncoder: any = null

  try {
    profiler.begin('prepare')
    const uniqImageAssetIds = new Set<string>()
    for (const c of state.clips) if (c.kind === 'image') uniqImageAssetIds.add((c as ImageClip).assetId)
    for (const aid of uniqImageAssetIds) {
      const url = await getAssetObjectURL(state.meta.id, aid)
      if (!url) continue
      try {
        const img = await loadImage(url)
        rc.images.set(aid, img)
      } catch (e) {
        console.warn('image load failed', e)
      }
    }
    profiler.end('prepare')

    checkAbort(signal)

    notifyProgress(opts, { phase: 'video', done: 0, total: totalFrames, message: '映像エンコード中…' })

    const VFrame = (globalThis as any).VideoFrame
    const frameDurationUs = Math.round(1e6 / fps)
    for (let i = 0; i < totalFrames; i++) {
      checkAbort(signal)
      const t = rangeStart + i / fps

      profiler.begin('frameWait')
      await resolver.resolveFrames(t, rc.currentFrames)
      profiler.end('frameWait')

      profiler.begin('draw')
      drawFrame(rc, t)
      profiler.end('draw')

      await waitEncoderQueue(videoEncoder, watch, signal, profiler)
      watch.check(signal)
      const frame = new VFrame(rc.canvas as any, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: frameDurationUs
      })
      const keyFrame = i % Math.max(1, Math.round(fps * 2)) === 0
      videoEncoder.encode(frame, { keyFrame })
      frame.close()

      if (i % 5 === 0 || i === totalFrames - 1) {
        notifyProgress(opts, { phase: 'video', done: i + 1, total: totalFrames })
        // UI thread に譲る
        await new Promise(r => setTimeout(r, 0))
      }
    }

    profiler.begin('encodeFlush')
    await watch.guard(videoEncoder.flush(), signal, ENCODER_STALL_MS * 2, '映像エンコーダ')
    profiler.end('encodeFlush')
    videoEncoder.close()

    // ---------- 音声 ----------
    if (includeAudio) {
      checkAbort(signal)
      notifyProgress(opts, { phase: 'audio', done: 0, total: 1, message: '音声をミックス中…' })
      const sampleRate = 48000
      let audioBuf: AudioBuffer | null = null
      profiler.begin('audioMix')
      try {
        audioBuf = await renderAudioMix(state, rangeDur, sampleRate, signal, rangeStart, warnings)
      } catch (e: any) {
        // キャンセルはそのまま中止。それ以外も「音声なしのファイル」を黙って作らず失敗にする
        if (e?.name === 'AbortError') throw e
        console.error('audio mix failed', e)
        throw new Error(
          '音声の合成に失敗しました。「音声を含める」を外すと映像だけ書き出せます' +
            (e?.message ? ` (${e.message})` : '')
        )
      }
      profiler.end('audioMix')
      if (audioBuf) {
        const AE = (globalThis as any).AudioEncoder
        const AData = (globalThis as any).AudioData
        audioEncoder = new AE({
          output: (chunk: any, metadata: any) => {
            try {
              muxer.addAudioChunk(chunk, metadata)
            } catch (e) {
              watch.fail(e)
            }
          },
          error: (e: any) => {
            console.error('audio encoder error', e)
            watch.fail(e)
          }
        })
        audioEncoder.configure({
          codec: audioCodecStr,
          sampleRate,
          numberOfChannels: 2,
          bitrate: audioBitrate
        })

        // ブロック単位で AudioData を生成 (interleaved f32)
        profiler.begin('audioEncode')
        const frameCount = audioBuf.length
        const blockSize = 1024
        const chL = audioBuf.getChannelData(0)
        const chR = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : chL
        const totalBlocks = Math.ceil(frameCount / blockSize)

        for (let b = 0; b < totalBlocks; b++) {
          watch.check(signal)
          await waitEncoderQueue(audioEncoder, watch, signal)
          const off = b * blockSize
          const end = Math.min(off + blockSize, frameCount)
          const n = end - off
          const data = new Float32Array(n * 2)
          for (let i = 0; i < n; i++) {
            data[i * 2] = chL[off + i]
            data[i * 2 + 1] = chR[off + i]
          }
          const ts = Math.round((off * 1e6) / sampleRate)
          const ad = new AData({
            format: 'f32',
            sampleRate,
            numberOfFrames: n,
            numberOfChannels: 2,
            timestamp: ts,
            data
          })
          audioEncoder.encode(ad)
          ad.close()
          if (b % 50 === 0) {
            notifyProgress(opts, { phase: 'audio', done: b + 1, total: totalBlocks })
            await new Promise(r => setTimeout(r, 0))
          }
        }
        await watch.guard(audioEncoder.flush(), signal, ENCODER_STALL_MS * 2, '音声エンコーダ')
        audioEncoder.close()
        profiler.end('audioEncode')
      }
    }

    // ---------- Mux 完了 ----------
    // キャンセル・エンコーダエラーの後に不完全なファイルを完成扱いにしない
    watch.check(signal)
    notifyProgress(opts, { phase: 'mux', done: 0, total: 1, message: '出力中…' })
    muxer.finalize()

    notifyProgress(opts, { phase: 'done', done: 1, total: 1, message: '完了' })
    logProfile(
      profiler,
      `${format} ${width}x${height}@${fps} ${totalFrames}f ` +
        `(decoder:${resolver.kinds.decoder} / element:${resolver.kinds.element}, ` +
        `hw:${encoderConfig.hardwareAcceleration ?? 'no-preference'})`
    )

    const safeName = state.meta.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 64) || 'project'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const ext = format === 'mp4' ? 'mp4' : 'webm'
    return {
      blob: writer.toBlob(mimeType),
      filename: `${safeName}__${stamp}.${ext}`,
      mime: mimeType,
      warnings
    }
  } finally {
    // 中断・エラー時もフレームソース / デコーダ / エンコーダを確実に解放する
    resolver.closeAll()
    void mediaCache.closeAll()
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close()
    } catch {
      // ignore
    }
    try {
      if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close()
    } catch {
      // ignore
    }
  }
}

// ============================================================
// PNG (1 枚) / 連番 PNG (ZIP) / WAV
// ============================================================

function outputName(state: ProjectState, ext: string): string {
  const safeName = state.meta.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 64) || 'project'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${safeName}__${stamp}.${ext}`
}

async function canvasToPng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if ('convertToBlob' in canvas) return await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/png' })
  return await new Promise<Blob>((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob(b => (b ? resolve(b) : reject(new Error('PNG に変換できませんでした'))), 'image/png')
  )
}

/**
 * png: startTime の 1 枚を PNG に。png-seq: 範囲の全フレームを連番 PNG にして無圧縮 ZIP に。
 * transparent なら背景色を塗らない (透明な素材として他のソフトで重ねられる)。
 */
async function exportImages(state: ProjectState, opts: ExportOptions): Promise<ExportResult> {
  await waitFontsReady()
  const { width, height, signal } = opts
  const single = opts.format === 'png'
  const fps = Math.max(1, opts.fps)
  const rangeStart = opts.startTime ?? 0
  const rangeEnd = opts.endTime ?? state.timeline.duration
  const totalFrames = single ? 1 : Math.max(1, Math.ceil((rangeEnd - rangeStart) * fps))

  notifyProgress(opts, { phase: 'prepare', done: 0, total: 1, message: '準備中…' })
  const rc: RenderContext = {
    state,
    currentFrames: new Map(),
    images: new Map(),
    canvas: (globalThis as any).OffscreenCanvas
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height }),
    ctx: null as any,
    buffer: new LayerBuffer(),
    bgBuffer: new LayerBuffer()
  }
  rc.ctx = (rc.canvas as any).getContext('2d') as any
  const videoClips = state.clips.filter(c => c.kind === 'video') as VideoClip[]
  const mediaCache = new ExportMediaCache(state.meta.id)
  const resolver = new VideoFrameResolver(state.meta.id, videoClips, mediaCache, rangeStart, fps, totalFrames)
  try {
    for (const c of state.clips) {
      if (c.kind !== 'image' || rc.images.has(c.assetId)) continue
      const url = await getAssetObjectURL(state.meta.id, c.assetId)
      if (url) rc.images.set(c.assetId, await loadImage(url).catch(() => null as any))
    }
    const entries: Array<{ name: string; data: Blob }> = []
    const digits = String(totalFrames).length
    notifyProgress(opts, { phase: 'video', done: 0, total: totalFrames, message: '画像を作成中…' })
    for (let i = 0; i < totalFrames; i++) {
      checkAbort(signal)
      const t = rangeStart + i / fps
      await resolver.resolveFrames(t, rc.currentFrames)
      drawFrame(rc, t, !!opts.transparent)
      const png = await canvasToPng(rc.canvas)
      if (single) {
        notifyProgress(opts, { phase: 'done', done: 1, total: 1, message: '完了' })
        return { blob: png, filename: outputName(state, 'png'), mime: 'image/png', warnings: [] }
      }
      entries.push({ name: `frame_${String(i).padStart(Math.max(5, digits), '0')}.png`, data: png })
      if (i % 3 === 0 || i === totalFrames - 1) {
        notifyProgress(opts, { phase: 'video', done: i + 1, total: totalFrames })
        await new Promise(r => setTimeout(r, 0))
      }
    }
    checkAbort(signal)
    notifyProgress(opts, { phase: 'mux', done: 0, total: 1, message: '出力中…' })
    const zip = await buildStoredZip(entries)
    notifyProgress(opts, { phase: 'done', done: 1, total: 1, message: '完了' })
    return { blob: zip, filename: outputName(state, 'png.zip'), mime: 'application/zip', warnings: [] }
  } finally {
    resolver.closeAll()
    void mediaCache.closeAll()
  }
}

/** 音声だけを 48kHz / 16bit / ステレオの WAV にする */
async function exportWav(state: ProjectState, opts: ExportOptions): Promise<ExportResult> {
  const rangeStart = opts.startTime ?? 0
  const rangeEnd = opts.endTime ?? state.timeline.duration
  const rangeDur = Math.max(0.01, rangeEnd - rangeStart)
  const warnings: string[] = []
  notifyProgress(opts, { phase: 'audio', done: 0, total: 1, message: '音声をミックス中…' })
  const sampleRate = 48000
  const buf = await renderAudioMix(state, rangeDur, sampleRate, opts.signal, rangeStart, warnings)
  checkAbort(opts.signal)
  notifyProgress(opts, { phase: 'mux', done: 0, total: 1, message: '出力中…' })
  const blob = encodeWav(buf)
  notifyProgress(opts, { phase: 'done', done: 1, total: 1, message: '完了' })
  return { blob, filename: outputName(state, 'wav'), mime: 'audio/wav', warnings }
}

/**
 * AudioBuffer → 16bit PCM ステレオ WAV。長い音声でも 1 つの巨大な配列を作らないよう、
 * 一定の長さごとに区切って Blob の部品にする。
 */
export function encodeWav(buf: { length: number; sampleRate: number; numberOfChannels: number; getChannelData(c: number): Float32Array }): Blob {
  const ch = 2
  const frames = buf.length
  const L = buf.getChannelData(0)
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L
  const dataBytes = frames * ch * 2
  const header = new DataView(new ArrayBuffer(44))
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) header.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); header.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE')
  str(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, ch, true)
  header.setUint32(24, buf.sampleRate, true); header.setUint32(28, buf.sampleRate * ch * 2, true)
  header.setUint16(32, ch * 2, true); header.setUint16(34, 16, true)
  str(36, 'data'); header.setUint32(40, dataBytes, true)
  const parts: BlobPart[] = [header.buffer]
  const CHUNK = 1 << 18 // 262144 フレームごと (約 1MB)
  for (let off = 0; off < frames; off += CHUNK) {
    const n = Math.min(CHUNK, frames - off)
    const pcm = new Int16Array(n * 2)
    for (let i = 0; i < n; i++) {
      const l = Math.max(-1, Math.min(1, L[off + i]))
      const r = Math.max(-1, Math.min(1, R[off + i]))
      pcm[i * 2] = l < 0 ? l * 0x8000 : l * 0x7fff
      pcm[i * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff
    }
    parts.push(pcm.buffer)
  }
  return new Blob(parts, { type: 'audio/wav' })
}

async function waitFontsReady() {
  const fonts = (globalThis as any).document?.fonts
  if (!fonts?.ready) return
  await Promise.race([fonts.ready, new Promise(r => setTimeout(r, 5000))])
}

export async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 大きなファイルでもダウンロード開始まで URL を生かしておく
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ============================================================
// GIF エクスポート
// ============================================================

async function exportGIF(state: ProjectState, opts: ExportOptions): Promise<ExportResult> {
  await waitFontsReady()
  const { width, height } = opts
  const fps = Math.max(2, Math.min(30, opts.fps))
  const rangeStart = opts.startTime ?? 0
  const rangeEnd = opts.endTime ?? state.timeline.duration
  const rangeDur = Math.max(0.1, rangeEnd - rangeStart)
  const totalFrames = Math.max(1, Math.ceil(rangeDur * fps))
  const delayMs = Math.round(1000 / fps)

  notifyProgress(opts, { phase: 'prepare', done: 0, total: 1, message: '準備中…' })

  const gifenc = await import('gifenc')
  const { GIFEncoder, quantize, applyPalette } = gifenc as any

  const rc: RenderContext = {
    state,
    currentFrames: new Map(),
    images: new Map(),
    canvas: (globalThis as any).OffscreenCanvas
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height }),
    ctx: null as any,
    buffer: new LayerBuffer(),
    bgBuffer: new LayerBuffer()
  }
  rc.ctx = (rc.canvas as any).getContext('2d', { willReadFrequently: true }) as any

  const videoClips = state.clips.filter(c => c.kind === 'video') as VideoClip[]
  const mediaCache = new ExportMediaCache(state.meta.id)
  const resolver = new VideoFrameResolver(
    state.meta.id,
    videoClips,
    mediaCache,
    rangeStart,
    fps,
    totalFrames
  )

  try {
    const uniqImageAssetIds = new Set<string>()
    for (const c of state.clips) if (c.kind === 'image') uniqImageAssetIds.add((c as ImageClip).assetId)
    for (const aid of uniqImageAssetIds) {
      const url = await getAssetObjectURL(state.meta.id, aid)
      if (!url) continue
      try {
        rc.images.set(aid, await loadImage(url))
      } catch {}
    }

    notifyProgress(opts, { phase: 'video', done: 0, total: totalFrames, message: 'GIF を合成中…' })

    const gif = GIFEncoder()

    for (let i = 0; i < totalFrames; i++) {
      checkAbort(opts.signal)
      const t = rangeStart + i / fps

      await resolver.resolveFrames(t, rc.currentFrames)

      drawFrame(rc, t)
      const img = (rc.ctx as CanvasRenderingContext2D).getImageData(0, 0, width, height)
      const palette = quantize(img.data, 256)
      const indexed = applyPalette(img.data, palette)
      gif.writeFrame(indexed, width, height, { palette, delay: delayMs })

      if (i % 3 === 0 || i === totalFrames - 1) {
        notifyProgress(opts, { phase: 'video', done: i + 1, total: totalFrames })
        await new Promise(r => setTimeout(r, 0))
      }
    }
    gif.finish()
    const buf = gif.bytes()

    notifyProgress(opts, { phase: 'done', done: 1, total: 1, message: '完了' })

    const safeName = state.meta.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 64) || 'project'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return {
      blob: new Blob([buf], { type: 'image/gif' }),
      filename: `${safeName}__${stamp}.gif`,
      mime: 'image/gif',
      warnings: []
    }
  } finally {
    resolver.closeAll()
    void mediaCache.closeAll()
  }
}
