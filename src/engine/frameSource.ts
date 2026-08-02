// ============================================================
// エクスポート用フレーム供給 (FrameSource)
// ============================================================
// クリップごとに「素材内時刻 → 描画可能なフレーム」を返す抽象。
//
// - DecoderFrameSource: mediabunny (純TS demuxer) + WebCodecs VideoDecoder。
//   必要フレームの素材内時刻を事前に列挙して samplesAtTimestamps() に渡し、
//   シーケンシャルにデコードする。<video> シーク待ちが無くなるので速い。
// - VideoElementFrameSource: 従来の非表示 <video> + seek。デコーダが
//   使えない環境・コーデック・逆再生クリップ用のフォールバック。
//
// 呼び出し規約: getFrameAt() はエクスポートループから、クリップが
// アクティブな出力フレームごとに 1 回だけ、フレーム順に呼ばれる
// (clipSourceTimestamps() が生成した時刻列と 1:1 対応)。
// ============================================================

import type { VideoSample, Input, InputVideoTrack } from 'mediabunny'
import { loadAssetBlob, getAssetObjectURL } from '../persistence/assetStore'
import { hasVideoDecoder } from './capabilities'
import { selectSourceKind, type SourceKind } from './frameTiming'

export interface VideoFrameRef {
  image: CanvasImageSource
  /** 表示ピクセル寸法 (videoWidth / videoHeight 相当。回転・PAR 補正後) */
  width: number
  height: number
}

export interface FrameSource {
  /**
   * 素材内時刻 sourceTime のフレームを返す。返り値は次回の getFrameAt()
   * または close() まで有効。フレームが得られない場合は null。
   */
  getFrameAt(sourceTime: number): Promise<VideoFrameRef | null>
  close(): void
}

/** 同時に動かす VideoDecoder の上限。超過分は <video> フォールバック */
export const MAX_CONCURRENT_DECODERS = 4

/** デコーダ 1 フレームの取得がこれを超えたら <video> に切り替える */
const DECODE_TIMEOUT_MS = 2000

// ---------- <video> 要素ベース (フォールバック) ----------

export async function makeHiddenVideo(url: string): Promise<HTMLVideoElement> {
  const el = document.createElement('video')
  el.src = url
  el.crossOrigin = 'anonymous'
  el.playsInline = true
  el.preload = 'auto'
  el.muted = true
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      el.removeEventListener('loadeddata', done)
      el.removeEventListener('error', err)
      resolve()
    }
    const err = () => {
      el.removeEventListener('loadeddata', done)
      el.removeEventListener('error', err)
      reject(new Error('video load failed'))
    }
    el.addEventListener('loadeddata', done, { once: true })
    el.addEventListener('error', err, { once: true })
  })
  return el
}

function seekVideo(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(el.currentTime - t) < 0.003) {
      resolve()
      return
    }
    const onSeeked = () => {
      el.removeEventListener('seeked', onSeeked)
      resolve()
    }
    el.addEventListener('seeked', onSeeked, { once: true })
    try {
      el.currentTime = Math.max(0, t)
    } catch {
      resolve()
    }
    // タイムアウト保険 (1s)
    setTimeout(() => {
      el.removeEventListener('seeked', onSeeked)
      resolve()
    }, 1000)
  })
}

export class VideoElementFrameSource implements FrameSource {
  constructor(private el: HTMLVideoElement) {}

  async getFrameAt(sourceTime: number): Promise<VideoFrameRef | null> {
    await seekVideo(this.el, sourceTime)
    if (!this.el.videoWidth || !this.el.videoHeight) return null
    return { image: this.el, width: this.el.videoWidth, height: this.el.videoHeight }
  }

  close() {
    this.el.src = ''
    this.el.load()
  }
}

// ---------- mediabunny (demux + VideoDecoder) ----------

type Mediabunny = typeof import('./mediabunnyLoader')
let mbPromise: Promise<Mediabunny> | null = null
function loadMediabunny(): Promise<Mediabunny> {
  return (mbPromise ??= import('./mediabunnyLoader'))
}

export interface AssetVideoInfo {
  input: Input
  track: InputVideoTrack
  /** トラック先頭のタイムスタンプ (これより前を要求すると null になるためクランプに使う) */
  firstTimestamp: number
  canDecode: boolean
}

/**
 * 1 回のエクスポート内で素材 (assetId) ごとの mediabunny Input を共有する
 * キャッシュ。エクスポート終了時に closeAll() で全て破棄する。
 */
export class ExportMediaCache {
  private entries = new Map<string, Promise<AssetVideoInfo | null>>()

  constructor(private projectId: string) {}

  getVideoInfo(assetId: string): Promise<AssetVideoInfo | null> {
    let p = this.entries.get(assetId)
    if (!p) {
      p = this.open(assetId)
      this.entries.set(assetId, p)
    }
    return p
  }

  private async open(assetId: string): Promise<AssetVideoInfo | null> {
    try {
      const blob = await loadAssetBlob(this.projectId, assetId)
      if (!blob) return null
      const mb = await loadMediabunny()
      const input = new mb.Input({
        formats: [mb.MP4, mb.QTFF, mb.WEBM, mb.MATROSKA],
        source: new mb.BlobSource(blob)
      })
      const track = await input.getPrimaryVideoTrack()
      if (!track) {
        input.dispose()
        return null
      }
      const canDecode = await track.canDecode()
      const firstTimestamp = canDecode ? await track.getFirstTimestamp() : 0
      return { input, track, firstTimestamp, canDecode }
    } catch (e) {
      console.warn('mediabunny: 素材のパースに失敗 (<video> フォールバック)', e)
      return null
    }
  }

  async closeAll() {
    for (const p of this.entries.values()) {
      const info = await p.catch(() => null)
      try {
        info?.input.dispose()
      } catch {
        // ignore
      }
    }
    this.entries.clear()
  }
}

class DecoderFrameSource implements FrameSource {
  private iterator: AsyncGenerator<VideoSample | null, void, unknown>
  private currentSample: VideoSample | null = null
  private currentFrame: VideoFrame | null = null
  private currentRef: VideoFrameRef | null = null
  private rotCanvas: OffscreenCanvas | null = null
  private rotCtx: OffscreenCanvasRenderingContext2D | null = null

  private constructor(
    iterator: AsyncGenerator<VideoSample | null, void, unknown>,
    private rotated: boolean
  ) {
    this.iterator = iterator
  }

  /**
   * timestamps: このクリップがアクティブな各出力フレームで必要な素材内時刻
   * (フレーム順・単調非減少)。getFrameAt() は 1 要素につき 1 回呼ばれる。
   */
  static async create(info: AssetVideoInfo, timestamps: number[]): Promise<DecoderFrameSource> {
    const mb = await loadMediabunny()
    const sink = new mb.VideoSampleSink(info.track)
    // トラック開始前の時刻を要求すると null が返るのでクランプする
    const clamped =
      info.firstTimestamp > 0
        ? timestamps.map(t => Math.max(info.firstTimestamp, t))
        : timestamps
    const rotated = (info.track.rotation ?? 0) !== 0
    return new DecoderFrameSource(sink.samplesAtTimestamps(clamped), rotated)
  }

  async getFrameAt(_sourceTime: number): Promise<VideoFrameRef | null> {
    const res = await this.iterator.next()
    const sample = res.done ? null : res.value
    // null = この時刻のフレームが無い (トラック先頭前など) → 直前のフレームを維持
    if (sample) this.setCurrent(sample)
    return this.currentRef
  }

  private setCurrent(sample: VideoSample) {
    this.releaseCurrent()
    const w = sample.displayWidth
    const h = sample.displayHeight
    if (this.rotated) {
      // 回転メタデータ付き (iPhone .mov 等) は rotation を反映した
      // 描画 API (draw) でキャンバスに焼いてから使う
      if (!this.rotCanvas || this.rotCanvas.width !== w || this.rotCanvas.height !== h) {
        this.rotCanvas = new OffscreenCanvas(w, h)
        this.rotCtx = this.rotCanvas.getContext('2d')!
      }
      sample.draw(this.rotCtx!, 0, 0, w, h)
      sample.close()
      this.currentRef = { image: this.rotCanvas, width: w, height: h }
    } else {
      this.currentSample = sample
      this.currentFrame = sample.toVideoFrame()
      this.currentRef = { image: this.currentFrame, width: w, height: h }
    }
  }

  private releaseCurrent() {
    try {
      this.currentFrame?.close()
    } catch {
      // ignore
    }
    this.currentFrame = null
    try {
      this.currentSample?.close()
    } catch {
      // ignore
    }
    this.currentSample = null
    this.currentRef = null
  }

  close() {
    // ポンプを止めてキュー内サンプルとデコーダを解放する
    void this.iterator.return(undefined).catch(() => {})
    this.releaseCurrent()
    this.rotCanvas = null
    this.rotCtx = null
  }
}

// ---------- 実行時フォールバック付きラッパー ----------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`frame decode timeout (${ms}ms)`)), ms)
    p.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * デコーダ経路の実行時エラー / タイムアウトを捕捉し、<video> シークに
 * 差し替えて書き出しを続行するラッパー。書き出し全体は絶対に落とさない。
 */
class GuardedFrameSource implements FrameSource {
  private active: FrameSource
  private failedOver = false
  private dead = false

  constructor(
    primary: FrameSource,
    private makeFallback: () => Promise<FrameSource | null>
  ) {
    this.active = primary
  }

  async getFrameAt(sourceTime: number): Promise<VideoFrameRef | null> {
    if (this.dead) return null
    if (this.failedOver) {
      return this.active.getFrameAt(sourceTime).catch(() => null)
    }
    try {
      return await withTimeout(this.active.getFrameAt(sourceTime), DECODE_TIMEOUT_MS)
    } catch (e) {
      console.warn('デコードに失敗したため <video> シークに切り替えます', e)
      try {
        this.active.close()
      } catch {
        // ignore
      }
      this.failedOver = true
      const fb = await this.makeFallback().catch(() => null)
      if (!fb) {
        this.dead = true
        return null
      }
      this.active = fb
      return this.active.getFrameAt(sourceTime).catch(() => null)
    }
  }

  close() {
    if (this.dead) return
    try {
      this.active.close()
    } catch {
      // ignore
    }
  }
}

// ---------- クリップごとの FrameSource 生成 ----------

export interface CreateFrameSourceOptions {
  projectId: string
  assetId: string
  /** クリップの再生速度 (selectSourceKind の判定に使用) */
  speed: number
  /** クリップがアクティブな各出力フレームの素材内時刻 (clipSourceTimestamps の結果) */
  timestamps: number[]
  cache: ExportMediaCache
  /** 現在アクティブな decoder ソース数 (上限制御) */
  activeDecoders: number
}

export interface CreatedFrameSource {
  source: FrameSource
  kind: SourceKind
}

export async function createFrameSourceForClip(
  opts: CreateFrameSourceOptions
): Promise<CreatedFrameSource | null> {
  const makeElement = async (): Promise<FrameSource | null> => {
    const url = await getAssetObjectURL(opts.projectId, opts.assetId)
    if (!url) return null
    try {
      return new VideoElementFrameSource(await makeHiddenVideo(url))
    } catch (e) {
      console.warn('video load failed', e)
      return null
    }
  }

  let info: AssetVideoInfo | null = null
  if (hasVideoDecoder) {
    info = await opts.cache.getVideoInfo(opts.assetId).catch(() => null)
  }
  const kind = selectSourceKind({
    hasDecoder: hasVideoDecoder,
    parsedOk: !!info,
    canDecode: !!info?.canDecode,
    speed: opts.speed,
    activeDecoders: opts.activeDecoders,
    maxDecoders: MAX_CONCURRENT_DECODERS
  })

  if (kind === 'decoder') {
    try {
      const src = await DecoderFrameSource.create(info!, opts.timestamps)
      return { source: new GuardedFrameSource(src, makeElement), kind }
    } catch (e) {
      console.warn('デコーダの初期化に失敗 (<video> フォールバック)', e)
    }
  }
  const el = await makeElement()
  return el ? { source: el, kind: 'element' } : null
}
