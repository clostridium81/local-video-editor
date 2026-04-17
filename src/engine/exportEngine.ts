import type { ProjectState, Clip, VideoClip, AudioClip, ImageClip, TextClip } from '../types/project'
import { getAssetObjectURL, loadAssetBlob } from '../persistence/assetStore'
import { sampleKeyframes } from './keyframes'
import { sampleTransition } from './transitions'
import { buildFilterString } from './previewEngine'
import { AVC_CODECS, AAC_CODEC, VP9_CODEC, OPUS_CODEC, hasWebCodecs } from './capabilities'

// ============================================================
// MP4 / WebM エクスポート (WebCodecs + mp4-muxer / webm-muxer)
// ============================================================
// 実装戦略:
// 1. OffscreenCanvas (fallback: <canvas>) を自前で作る
// 2. 各 VideoClip の素材を専用 <video> 要素にロード
// 3. フレーム毎に t = i/fps で以下を実行:
//    a. 必要な media を seek → seeked を await
//    b. 合成描画
//    c. VideoFrame(canvas, { timestamp })
//    d. encoder.encode(frame)
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
  format: 'mp4' | 'webm'
  width: number
  height: number
  fps: number
  videoBitrate: number
  audioBitrate: number
  includeAudio: boolean
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

// ---------- 1 本の <video> ノードを準備 ----------

async function makeHiddenVideo(url: string): Promise<HTMLVideoElement> {
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
  videoEls: Map<string, HTMLVideoElement> // clipId -> el
  images: Map<string, HTMLImageElement> // assetId -> img
  canvas: OffscreenCanvas | HTMLCanvasElement
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
}

function computeEffective(clip: Clip, t: number) {
  const local = t - clip.start
  const base: any = {
    x: (clip as any).x ?? 0.5,
    y: (clip as any).y ?? 0.5,
    scale: (clip as any).scale ?? 1,
    rotation: (clip as any).rotation ?? 0,
    opacity: clip.opacity ?? 1,
    volume: clip.volume ?? 1
  }
  const kfs = clip.keyframes
  if (kfs) {
    base.x = sampleKeyframes(kfs.x, local, base.x)
    base.y = sampleKeyframes(kfs.y, local, base.y)
    base.scale = sampleKeyframes(kfs.scale, local, base.scale)
    base.rotation = sampleKeyframes(kfs.rotation, local, base.rotation)
    base.opacity = sampleKeyframes(kfs.opacity, local, base.opacity)
    base.volume = sampleKeyframes(kfs.volume, local, base.volume)
  }
  const trans = sampleTransition(clip, t)
  base.x += trans.offsetX
  base.y += trans.offsetY
  base.scale *= trans.scale
  base.opacity *= trans.alpha
  base.volume *= trans.volume
  return { eff: base, trans }
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
    .filter(c => t >= c.start && t < c.start + c.duration)
    .sort((a, b) => (trackOrderMap.get(a.trackId) ?? 0) - (trackOrderMap.get(b.trackId) ?? 0))

  for (const clip of activeClips) {
    const track = state.tracks.find(tr => tr.id === clip.trackId)
    if (track?.kind === 'audio') continue

    const { eff, trans } = computeEffective(clip, t)

    if (clip.kind === 'video') {
      const el = rc.videoEls.get(clip.id)
      if (!el) continue
      drawTransformed(ctx, el as any, el.videoWidth, el.videoHeight, eff, (clip as VideoClip).effects, trans, width, height)
    } else if (clip.kind === 'image') {
      const img = rc.images.get((clip as ImageClip).assetId)
      if (!img) continue
      drawTransformed(ctx, img, img.naturalWidth, img.naturalHeight, eff, (clip as ImageClip).effects, trans, width, height)
    } else if (clip.kind === 'text') {
      drawText(ctx, clip as TextClip, eff, trans, width, height)
    }
  }
}

function drawTransformed(
  ctx: any,
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  eff: any,
  effects: any,
  trans: any,
  width: number,
  height: number
) {
  if (!srcW || !srcH) return
  const fit = Math.min(width / srcW, height / srcH)
  const drawW = srcW * fit * eff.scale
  const drawH = srcH * fit * eff.scale
  const cx = width * eff.x
  const cy = height * eff.y

  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, eff.opacity))
  if (effects) {
    const f = buildFilterString(effects)
    if (f) ctx.filter = f
  }
  if (trans.isWipe) {
    ctx.beginPath()
    ctx.rect(0, 0, width * trans.wipeProgress, height)
    ctx.clip()
  }
  ctx.translate(cx, cy)
  if (eff.rotation) ctx.rotate((eff.rotation * Math.PI) / 180)
  ctx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH)
  ctx.restore()
}

function drawText(ctx: any, clip: TextClip, eff: any, trans: any, width: number, height: number) {
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, eff.opacity))
  const weight = clip.bold ? '700' : '400'
  const style = clip.italic ? 'italic' : 'normal'
  ctx.font = `${style} ${weight} ${clip.fontSize}px ${clip.fontFamily}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = clip.align
  const cx = width * eff.x
  const cy = height * eff.y
  if (trans.isWipe) {
    ctx.beginPath()
    ctx.rect(0, 0, width * trans.wipeProgress, height)
    ctx.clip()
  }
  ctx.translate(cx, cy)
  if (eff.rotation) ctx.rotate((eff.rotation * Math.PI) / 180)
  if (eff.scale !== 1) ctx.scale(eff.scale, eff.scale)
  if (clip.backgroundColor) {
    const m = ctx.measureText(clip.text)
    const w = m.width
    const h = clip.fontSize * 1.3
    ctx.fillStyle = clip.backgroundColor
    const bx = clip.align === 'center' ? -w / 2 : clip.align === 'right' ? -w : 0
    ctx.fillRect(bx - 16, -h / 2, w + 32, h)
  }
  ctx.fillStyle = clip.color
  ctx.fillText(clip.text, 0, 0)
  ctx.restore()
}

// ---------- 音声ミックス (OfflineAudioContext) ----------

async function renderAudioMix(
  state: ProjectState,
  totalDuration: number,
  sampleRate: number,
  signal?: AbortSignal
): Promise<AudioBuffer> {
  const Ctx =
    (globalThis as any).OfflineAudioContext ||
    (globalThis as any).webkitOfflineAudioContext
  if (!Ctx) throw new Error('OfflineAudioContext 未対応')
  const oc = new Ctx(2, Math.ceil(sampleRate * totalDuration), sampleRate)

  // AudioClip と VideoClip (音ありトラック) を集める
  type AClip = { clip: AudioClip | VideoClip; assetId: string }
  const audible: AClip[] = []
  for (const c of state.clips) {
    if (c.kind === 'audio') audible.push({ clip: c, assetId: c.assetId })
    else if (c.kind === 'video') audible.push({ clip: c, assetId: c.assetId })
  }

  // 素材ごとに decodeAudioData (重複排除)
  const decoded = new Map<string, AudioBuffer>()
  for (const a of audible) {
    if (decoded.has(a.assetId)) continue
    checkAbort(signal)
    const blob = await loadAssetBlob(state.meta.id, a.assetId)
    if (!blob) continue
    try {
      const arr = await blob.arrayBuffer()
      // decodeAudioData for OfflineAudioContext
      const buf = await (oc.decodeAudioData(arr) as Promise<AudioBuffer>)
      decoded.set(a.assetId, buf)
    } catch {
      // 無音でスキップ
    }
  }

  for (const a of audible) {
    checkAbort(signal)
    const buf = decoded.get(a.assetId)
    if (!buf) continue
    const c = a.clip
    const track = state.tracks.find(t => t.id === c.trackId)
    if (track?.muted || c.muted) continue

    const src = oc.createBufferSource()
    src.buffer = buf
    const gain = oc.createGain()
    const vol = Math.max(0, Math.min(2, c.volume ?? 1))
    gain.gain.value = vol

    // 音量キーフレームとトランジションを GainNode のオートメーションで
    const keyframes = c.keyframes?.volume
    const transIn = c.transitionIn
    const transOut = c.transitionOut

    if (keyframes && keyframes.length > 0) {
      // サンプリングしてオートメーション適用
      gain.gain.setValueAtTime(vol, c.start)
      const stepSec = 0.05
      for (let lt = 0; lt <= c.duration; lt += stepSec) {
        const v = sampleKeyframes(keyframes, lt, vol)
        gain.gain.linearRampToValueAtTime(v, c.start + lt)
      }
    }
    if (transIn && transIn.type === 'fade' && transIn.duration > 0) {
      gain.gain.setValueAtTime(0, c.start)
      gain.gain.linearRampToValueAtTime(vol, c.start + transIn.duration)
    }
    if (transOut && transOut.type === 'fade' && transOut.duration > 0) {
      const outStart = c.start + c.duration - transOut.duration
      gain.gain.setValueAtTime(vol, outStart)
      gain.gain.linearRampToValueAtTime(0, c.start + c.duration)
    }

    src.connect(gain).connect(oc.destination)
    const offsetInAsset = c.sourceIn ?? 0
    src.start(c.start, offsetInAsset, c.duration)
  }

  return await oc.startRendering()
}

// ---------- メインエクスポート ----------

export async function exportProject(
  state: ProjectState,
  opts: ExportOptions
): Promise<ExportResult> {
  if (!hasWebCodecs) throw new Error('このブラウザは WebCodecs に対応していません')

  const { width, height, fps, videoBitrate, audioBitrate, format, includeAudio, signal } = opts
  // 出力解像度に合わせて state.meta を上書き (描画関数はこれを参照する)
  state = {
    ...state,
    meta: { ...state.meta, width, height, fps }
  }
  const totalDuration = state.timeline.duration
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps))

  notifyProgress(opts, { phase: 'prepare', done: 0, total: 1, message: '準備中…' })

  // ---------- muxer ----------
  let muxer: any
  let mimeType: string
  let videoCodecStr: string
  let audioCodecStr: string

  if (format === 'mp4') {
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer')
    videoCodecStr = AVC_CODECS.high_1080p
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
  const VE = (globalThis as any).VideoEncoder
  const videoEncoder = new VE({
    output: (chunk: any, metadata: any) => muxer.addVideoChunk(chunk, metadata),
    error: (e: any) => {
      console.error('video encoder error', e)
    }
  })
  videoEncoder.configure({
    codec: videoCodecStr,
    width,
    height,
    bitrate: videoBitrate,
    framerate: fps
  })

  // ---------- 素材準備 (video & image) ----------
  const rc: RenderContext = {
    state,
    videoEls: new Map(),
    images: new Map(),
    canvas: (globalThis as any).OffscreenCanvas
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height }),
    ctx: null as any
  }
  rc.ctx = (rc.canvas as any).getContext('2d') as any

  const uniqVideoClips = state.clips.filter(c => c.kind === 'video') as VideoClip[]
  const uniqImageAssetIds = new Set<string>()
  for (const c of state.clips) if (c.kind === 'image') uniqImageAssetIds.add((c as ImageClip).assetId)

  for (const vc of uniqVideoClips) {
    const url = await getAssetObjectURL(state.meta.id, vc.assetId)
    if (!url) continue
    try {
      const el = await makeHiddenVideo(url)
      rc.videoEls.set(vc.id, el)
    } catch (e) {
      console.warn('video load failed', e)
    }
  }
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

  checkAbort(signal)

  // ---------- フレームループ ----------
  notifyProgress(opts, { phase: 'video', done: 0, total: totalFrames, message: '映像エンコード中…' })

  const VFrame = (globalThis as any).VideoFrame
  for (let i = 0; i < totalFrames; i++) {
    checkAbort(signal)
    const t = i / fps

    // 必要な video だけ seek (parallel)
    const needed: HTMLVideoElement[] = []
    const seeks: Promise<void>[] = []
    for (const vc of uniqVideoClips) {
      if (t >= vc.start && t < vc.start + vc.duration) {
        const el = rc.videoEls.get(vc.id)
        if (!el) continue
        const inT = t - vc.start + (vc.sourceIn ?? 0)
        needed.push(el)
        seeks.push(seekVideo(el, inT))
      }
    }
    await Promise.all(seeks)

    drawFrame(rc, t)

    const frame = new VFrame(rc.canvas as any, { timestamp: Math.round((i * 1e6) / fps) })
    const keyFrame = i % Math.max(1, Math.round(fps * 2)) === 0
    videoEncoder.encode(frame, { keyFrame })
    frame.close()

    if (i % 5 === 0 || i === totalFrames - 1) {
      notifyProgress(opts, { phase: 'video', done: i + 1, total: totalFrames })
      // UI thread に譲る
      await new Promise(r => setTimeout(r, 0))
    }
  }

  await videoEncoder.flush()
  videoEncoder.close()

  // ---------- 音声 ----------
  if (includeAudio) {
    checkAbort(signal)
    notifyProgress(opts, { phase: 'audio', done: 0, total: 1, message: '音声をミックス中…' })
    const sampleRate = 48000
    let audioBuf: AudioBuffer | null = null
    try {
      audioBuf = await renderAudioMix(state, totalDuration, sampleRate, signal)
    } catch (e) {
      console.warn('audio mix failed', e)
    }
    if (audioBuf) {
      const AE = (globalThis as any).AudioEncoder
      const AData = (globalThis as any).AudioData
      const audioEncoder = new AE({
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
    }
  }

  // ---------- Mux 完了 ----------
  notifyProgress(opts, { phase: 'mux', done: 0, total: 1, message: '出力中…' })
  muxer.finalize()
  const buf = (muxer.target as any).buffer as ArrayBuffer

  // クリーンアップ
  for (const el of rc.videoEls.values()) {
    el.src = ''
    el.load()
  }

  notifyProgress(opts, { phase: 'done', done: 1, total: 1, message: '完了' })

  const safeName = state.meta.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 64) || 'project'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const ext = format === 'mp4' ? 'mp4' : 'webm'
  return {
    blob: new Blob([buf], { type: mimeType }),
    filename: `${safeName}__${stamp}.${ext}`,
    mime: mimeType
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
