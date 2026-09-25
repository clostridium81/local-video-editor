import type {
  ProjectState,
  VideoClip,
  AudioClip,
  ImageClip
} from '../types/project'
import { getAssetObjectURL, loadAssetBlob } from '../persistence/assetStore'
import { computeEffective, drawClip, LayerBuffer, type VisualSource } from './renderer'
import {
  avcCodecFor,
  AAC_CODEC,
  VP9_CODEC,
  OPUS_CODEC,
  hasWebCodecs,
  canEncodeVideo,
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
  format: 'mp4' | 'webm' | 'gif'
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

function drawFrame(rc: RenderContext, t: number) {
  const { state, ctx } = rc
  const { width, height, backgroundColor } = state.meta

  ctx.save()
  ctx.filter = 'none' as any
  ctx.globalAlpha = 1
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = backgroundColor
  ctx.fillRect(0, 0, width, height)
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
  rangeOffset = 0
): Promise<AudioBuffer> {
  const Ctx =
    (globalThis as any).OfflineAudioContext ||
    (globalThis as any).webkitOfflineAudioContext
  if (!Ctx) throw new Error('OfflineAudioContext 未対応')
  const oc = new Ctx(2, Math.ceil(sampleRate * totalDuration), sampleRate)

  type AClip = { clip: AudioClip | VideoClip; assetId: string }
  const audible: AClip[] = []
  for (const c of state.clips) {
    if (c.kind === 'audio') audible.push({ clip: c, assetId: c.assetId })
    else if (c.kind === 'video') audible.push({ clip: c, assetId: c.assetId })
  }

  const anySolo = state.tracks.some(t => t.solo)

  // 素材ごとに decodeAudioData (重複排除)
  const decoded = new Map<string, AudioBuffer>()
  for (const a of audible) {
    if (decoded.has(a.assetId)) continue
    checkAbort(signal)
    const blob = await loadAssetBlob(state.meta.id, a.assetId)
    if (!blob) continue
    try {
      const arr = await blob.arrayBuffer()
      const buf = await (oc.decodeAudioData(arr) as Promise<AudioBuffer>)
      decoded.set(a.assetId, buf)
    } catch {
      // 無音スキップ
    }
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

async function waitEncoderQueue(encoder: any, profiler?: ExportProfiler): Promise<void> {
  if (!(encoder.encodeQueueSize > MAX_ENCODE_QUEUE)) return
  profiler?.begin('encodeWait')
  while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
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
  if (!hasWebCodecs) throw new Error('このブラウザでは動画の書き出しができません')

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

  // GIF 出力は専用パス
  if (format === 'gif') {
    return await exportGIF(state, { ...opts, startTime: rangeStart, endTime: rangeEnd })
  }

  notifyProgress(opts, { phase: 'prepare', done: 0, total: 1, message: '準備中…' })

  // ---------- muxer ----------
  let muxer: any
  let mimeType: string
  let videoCodecStr: string
  let audioCodecStr: string

  if (format === 'mp4') {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')
    // 解像度・fps に見合う Level を選ぶ (縦長や 21:9 は 1080p30 の Level 4.0 を超える)
    videoCodecStr = avcCodecFor(width, height, fps)
    audioCodecStr = AAC_CODEC
    muxer = new (Muxer as any)({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height, frameRate: fps },
      audio: includeAudio
        ? { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 }
        : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset'
    })
    mimeType = 'video/mp4'
  } else {
    const { Muxer, ArrayBufferTarget } = await import('webm-muxer')
    videoCodecStr = VP9_CODEC
    audioCodecStr = OPUS_CODEC
    muxer = new (Muxer as any)({
      target: new ArrayBufferTarget(),
      video: { codec: 'V_VP9', width, height, frameRate: fps },
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
  const encoderConfig = await pickVideoEncoderConfig({
    codec: videoCodecStr,
    width,
    height,
    bitrate: videoBitrate,
    framerate: fps
  })
  const videoEncoder = new VE({
    output: (chunk: any, metadata: any) => muxer.addVideoChunk(chunk, metadata),
    error: (e: any) => {
      console.error('video encoder error', e)
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

      await waitEncoderQueue(videoEncoder, profiler)
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
    await videoEncoder.flush()
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
        audioBuf = await renderAudioMix(state, rangeDur, sampleRate, signal, rangeStart)
      } catch (e) {
        console.warn('audio mix failed', e)
      }
      profiler.end('audioMix')
      if (audioBuf) {
        const AE = (globalThis as any).AudioEncoder
        const AData = (globalThis as any).AudioData
        audioEncoder = new AE({
          output: (chunk: any, metadata: any) => muxer.addAudioChunk(chunk, metadata),
          error: (e: any) => console.error('audio encoder error', e)
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
          checkAbort(signal)
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
        await audioEncoder.flush()
        audioEncoder.close()
        profiler.end('audioEncode')
      }
    }

    // ---------- Mux 完了 ----------
    notifyProgress(opts, { phase: 'mux', done: 0, total: 1, message: '出力中…' })
    muxer.finalize()
    const buf = (muxer.target as any).buffer as ArrayBuffer

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
      blob: new Blob([buf], { type: mimeType }),
      filename: `${safeName}__${stamp}.${ext}`,
      mime: mimeType
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

export async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// ============================================================
// GIF エクスポート
// ============================================================

async function exportGIF(state: ProjectState, opts: ExportOptions): Promise<ExportResult> {
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
      mime: 'image/gif'
    }
  } finally {
    resolver.closeAll()
    void mediaCache.closeAll()
  }
}
