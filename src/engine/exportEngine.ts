import type {
  ProjectState,
  Clip,
  VideoClip,
  AudioClip,
  ImageClip,
  TextClip,
  ShapeClip
} from '../types/project'
import { getAssetObjectURL, loadAssetBlob } from '../persistence/assetStore'
import { sampleKeyframes } from './keyframes'
import { sampleTransition } from './transitions'
import {
  buildFilterString,
  blendToCanvas,
  applyColorGrade,
  applyChromaKey
} from './previewEngine'
import { applyPixelEffects, hasPixelEffects } from './pixelEffects'
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
  // キーフレーム/テキストアニメはタイムライン経過秒 (speed 非依存) で評価。
  // previewEngine.computeEffective および renderAudioMix の音量エンベロープと同軸。
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
  return { eff: base, trans, localT: local }
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

    const { eff, trans, localT } = computeEffective(clip, t)
    const blendMode = clip.blendMode ?? 'normal'

    ctx.save()
    if (blendMode !== 'normal') ctx.globalCompositeOperation = blendToCanvas(blendMode)

    if (clip.kind === 'video') {
      const el = rc.videoEls.get(clip.id)
      if (!el) {
        ctx.restore()
        continue
      }
      drawVisualSource(
        ctx,
        rc,
        el as any,
        el.videoWidth,
        el.videoHeight,
        eff,
        (clip as VideoClip).effects,
        (clip as VideoClip).colorGrade,
        (clip as VideoClip).chromaKey,
        (clip as VideoClip).pixelFx,
        trans,
        width,
        height
      )
    } else if (clip.kind === 'image') {
      const img = rc.images.get((clip as ImageClip).assetId)
      if (!img) {
        ctx.restore()
        continue
      }
      drawVisualSource(
        ctx,
        rc,
        img,
        img.naturalWidth,
        img.naturalHeight,
        eff,
        (clip as ImageClip).effects,
        (clip as ImageClip).colorGrade,
        (clip as ImageClip).chromaKey,
        (clip as ImageClip).pixelFx,
        trans,
        width,
        height
      )
    } else if (clip.kind === 'text') {
      drawText(ctx, clip as TextClip, eff, trans, width, height, localT)
    } else if (clip.kind === 'shape') {
      drawShape(ctx, clip as ShapeClip, eff, trans, width, height)
    }
    ctx.restore()
  }
}

function drawVisualSource(
  ctx: any,
  rc: RenderContext,
  src: CanvasImageSource,
  srcW: number,
  srcH: number,
  eff: any,
  effects: any,
  grade: any,
  chroma: any,
  pixelFx: any,
  trans: any,
  width: number,
  height: number
) {
  if (!srcW || !srcH) return
  const needsPixelPass = !!(
    (grade && (grade.lift || grade.gamma || grade.gain || grade.temperature || grade.tint)) ||
    chroma?.enabled ||
    hasPixelEffects(pixelFx)
  )
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

  if (!needsPixelPass) {
    ctx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH)
  } else {
    const pbufW = Math.max(1, Math.round(Math.abs(drawW)))
    const pbufH = Math.max(1, Math.round(Math.abs(drawH)))
    const pbuf = getPixelBuf(rc, pbufW, pbufH)
    const pctx = pbuf.ctx
    pctx.save()
    pctx.filter = effects ? buildFilterString(effects) : 'none'
    pctx.globalCompositeOperation = 'source-over'
    pctx.globalAlpha = 1
    pctx.clearRect(0, 0, pbufW, pbufH)
    pctx.drawImage(src, 0, 0, pbufW, pbufH)
    pctx.restore()
    try {
      const img = pctx.getImageData(0, 0, pbufW, pbufH)
      if (chroma?.enabled) applyChromaKey(img, chroma)
      if (grade) applyColorGrade(img, grade)
      if (hasPixelEffects(pixelFx)) applyPixelEffects(img, pixelFx)
      pctx.putImageData(img, 0, 0)
    } catch {
      // ignore
    }
    ctx.drawImage(pbuf.canvas, -drawW / 2, -drawH / 2, drawW, drawH)
  }
  ctx.restore()
}

interface PixelBuf {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}
function getPixelBuf(rc: RenderContext, w: number, h: number): PixelBuf {
  if (!(rc as any)._pbuf) {
    const c = document.createElement('canvas')
    const cx = c.getContext('2d', { willReadFrequently: true })!
    ;(rc as any)._pbuf = { canvas: c, ctx: cx }
  }
  const pb = (rc as any)._pbuf as PixelBuf
  if (pb.canvas.width !== w) pb.canvas.width = w
  if (pb.canvas.height !== h) pb.canvas.height = h
  return pb
}

function drawShape(
  ctx: any,
  clip: ShapeClip,
  eff: any,
  trans: any,
  width: number,
  height: number
) {
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, eff.opacity))
  if (clip.effects) {
    const f = buildFilterString(clip.effects)
    if (f) ctx.filter = f
  }
  if (trans.isWipe) {
    ctx.beginPath()
    ctx.rect(0, 0, width * trans.wipeProgress, height)
    ctx.clip()
  }
  const cx = width * eff.x
  const cy = height * eff.y
  // previewEngine と同じ: 短辺基準で図形を正規化する
  const ref = Math.min(width, height)
  const w = ref * clip.width * eff.scale
  const h = ref * clip.height * eff.scale
  ctx.translate(cx, cy)
  if (eff.rotation) ctx.rotate((eff.rotation * Math.PI) / 180)
  ctx.fillStyle = clip.style.fill ?? 'transparent'
  ctx.strokeStyle = clip.style.stroke ?? 'transparent'
  ctx.lineWidth = clip.style.strokeWidth ?? 0
  shapePath(ctx, clip, w, h)
  if (clip.style.fill) ctx.fill()
  if (clip.style.stroke && (clip.style.strokeWidth ?? 0) > 0) ctx.stroke()
  ctx.restore()
}

function shapePath(ctx: any, clip: ShapeClip, w: number, h: number) {
  ctx.beginPath()
  const { shape, style } = clip
  if (shape === 'rect') {
    const r = style.cornerRadius ?? 0
    if (r > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(r, Math.min(w, h) / 2))
    } else {
      ctx.rect(-w / 2, -h / 2, w, h)
    }
  } else if (shape === 'ellipse') {
    ctx.ellipse(0, 0, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2)
  } else if (shape === 'line') {
    ctx.moveTo(-w / 2, 0)
    ctx.lineTo(w / 2, 0)
  } else if (shape === 'triangle') {
    ctx.moveTo(0, -h / 2)
    ctx.lineTo(-w / 2, h / 2)
    ctx.lineTo(w / 2, h / 2)
    ctx.closePath()
  } else if (shape === 'arrow') {
    const head = Math.min(w * 0.3, h)
    ctx.moveTo(-w / 2, -h / 6)
    ctx.lineTo(w / 2 - head, -h / 6)
    ctx.lineTo(w / 2 - head, -h / 2)
    ctx.lineTo(w / 2, 0)
    ctx.lineTo(w / 2 - head, h / 2)
    ctx.lineTo(w / 2 - head, h / 6)
    ctx.lineTo(-w / 2, h / 6)
    ctx.closePath()
  } else if (shape === 'star') {
    const n = 5
    const inner = Math.min(w, h) / 4
    const outer = Math.min(w, h) / 2
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? outer : inner
      const a = (Math.PI / n) * i - Math.PI / 2
      const px = Math.cos(a) * r
      const py = Math.sin(a) * r
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
  }
}

function drawText(
  ctx: any,
  clip: TextClip,
  eff: any,
  trans: any,
  width: number,
  height: number,
  localT: number
) {
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

  const decor = clip.decor
  const letterSpacing = decor?.letterSpacing ?? 0
  const anim = clip.anim
  const animProgress = anim && anim.duration > 0
    ? Math.max(0, Math.min(1, localT / anim.duration))
    : 1

  if (clip.backgroundColor) {
    const m = ctx.measureText(clip.text)
    const w = m.width + letterSpacing * Math.max(0, clip.text.length - 1)
    const h = clip.fontSize * (decor?.lineHeight ?? 1.3)
    ctx.fillStyle = clip.backgroundColor
    const bx = clip.align === 'center' ? -w / 2 : clip.align === 'right' ? -w : 0
    ctx.fillRect(bx - 16, -h / 2, w + 32, h)
  }

  if (decor?.shadow) {
    ctx.save()
    ctx.shadowColor = decor.shadow.color
    ctx.shadowBlur = decor.shadow.blur
    ctx.shadowOffsetX = decor.shadow.offsetX
    ctx.shadowOffsetY = decor.shadow.offsetY
    drawTextAnim(ctx, clip, animProgress, letterSpacing, false)
    ctx.restore()
  }
  if (decor?.outline && decor.outline.width > 0) {
    ctx.save()
    ctx.strokeStyle = decor.outline.color
    ctx.lineWidth = decor.outline.width
    ctx.lineJoin = 'round'
    drawTextAnim(ctx, clip, animProgress, letterSpacing, true)
    ctx.restore()
  }
  ctx.fillStyle = clip.color
  drawTextAnim(ctx, clip, animProgress, letterSpacing, false)
  ctx.restore()
}

function drawTextAnim(
  ctx: any,
  clip: TextClip,
  progress: number,
  letterSpacing: number,
  strokeOnly: boolean
) {
  const type = clip.anim?.type ?? 'none'
  const text = clip.text
  if (type === 'none' && letterSpacing === 0) {
    if (strokeOnly) ctx.strokeText(text, 0, 0)
    else ctx.fillText(text, 0, 0)
    return
  }
  const chars = Array.from(text)
  const widths = chars.map((ch: string) => ctx.measureText(ch).width)
  const totalW = widths.reduce((a: number, b: number) => a + b, 0) + letterSpacing * Math.max(0, chars.length - 1)
  let startX = 0
  if (clip.align === 'center') startX = -totalW / 2
  else if (clip.align === 'right') startX = -totalW
  const prevAlign = ctx.textAlign
  ctx.textAlign = 'left'
  for (let i = 0; i < chars.length; i++) {
    const cp = charProgress(type, progress, i, chars.length)
    if (cp <= 0) {
      startX += widths[i] + letterSpacing
      continue
    }
    ctx.save()
    switch (type) {
      case 'fade-words':
        ctx.globalAlpha = ctx.globalAlpha * cp
        break
      case 'slide-chars':
        ctx.translate(0, (1 - cp) * 40)
        ctx.globalAlpha = ctx.globalAlpha * cp
        break
      case 'bounce':
        ctx.translate(0, (1 - cp) * -30 * Math.sin(cp * Math.PI))
        break
      case 'scale-pop': {
        const s = 0.6 + cp * 0.4
        ctx.scale(s, s)
        ctx.globalAlpha = ctx.globalAlpha * cp
        break
      }
      case 'wave':
        ctx.translate(0, Math.sin(progress * Math.PI * 2 + i * 0.4) * 10)
        break
    }
    if (strokeOnly) ctx.strokeText(chars[i], startX, 0)
    else ctx.fillText(chars[i], startX, 0)
    ctx.restore()
    startX += widths[i] + letterSpacing
  }
  ctx.textAlign = prevAlign
}

function charProgress(type: string, progress: number, idx: number, total: number): number {
  if (type === 'typewriter') return progress >= (idx + 1) / total ? 1 : 0
  if (type === 'fade-words' || type === 'slide-chars' || type === 'scale-pop') {
    const spread = 0.7
    const perChar = spread / Math.max(1, total)
    const start = perChar * idx
    const end = start + (1 - spread)
    if (progress <= start) return 0
    if (progress >= end) return 1
    return (progress - start) / (end - start)
  }
  if (type === 'bounce') {
    const spread = 0.5
    const perChar = spread / Math.max(1, total)
    const start = perChar * idx
    const end = Math.min(1, start + 0.5)
    if (progress <= start) return 0
    if (progress >= end) return 1
    return (progress - start) / (end - start)
  }
  return 1
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

    let srcBuf: AudioBuffer = buf
    if (c.reversed) {
      srcBuf = oc.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate)
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const s = buf.getChannelData(ch)
        const d = srcBuf.getChannelData(ch)
        for (let i = 0; i < s.length; i++) d[i] = s[s.length - 1 - i]
      }
    }

    const src = oc.createBufferSource()
    src.buffer = srcBuf
    const speed = Math.max(0.0625, Math.min(16, c.speed ?? 1))
    src.playbackRate.value = speed

    const gain = oc.createGain()
    const vol = Math.max(0, Math.min(2, c.volume ?? 1))
    gain.gain.value = vol

    const keyframes = c.keyframes?.volume
    const transIn = c.transitionIn
    const transOut = c.transitionOut

    // 出力 OfflineAudioContext の時間軸 = (絶対時刻 - rangeOffset)。
    // src.start も rangeOffset を引いた相対時刻で予約しているので、gain も
    // 同じ時間軸でないと、範囲指定エクスポート時にエンベロープが音源とずれる。
    // 0 未満になる時刻は AudioParam が受け付けないため 0 にクランプする。
    const toOutT = (absT: number) => Math.max(0, absT - rangeOffset)

    if (keyframes && keyframes.length > 0) {
      gain.gain.setValueAtTime(vol, toOutT(c.start))
      const stepSec = 0.05
      for (let lt = 0; lt <= c.duration; lt += stepSec) {
        const v = sampleKeyframes(keyframes, lt, vol)
        gain.gain.linearRampToValueAtTime(v, toOutT(c.start + lt))
      }
    }
    if (transIn && transIn.type === 'fade' && transIn.duration > 0) {
      gain.gain.setValueAtTime(0, toOutT(c.start))
      gain.gain.linearRampToValueAtTime(vol, toOutT(c.start + transIn.duration))
    }
    if (transOut && transOut.type === 'fade' && transOut.duration > 0) {
      const outStart = c.start + c.duration - transOut.duration
      gain.gain.setValueAtTime(vol, toOutT(outStart))
      gain.gain.linearRampToValueAtTime(0, toOutT(c.start + c.duration))
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
    const clipDurAtSourceRate = c.duration * speed
    // 逆再生時はバッファ全体を反転済みなので、元素材の区間
    // [sourceIn, sourceIn + 区間長] は反転バッファ内では
    // [bufDur - sourceIn - 区間長, bufDur - sourceIn] に対応する
    const baseOffset = c.reversed
      ? Math.max(0, srcBuf.duration - offsetInAsset - clipDurAtSourceRate)
      : offsetInAsset
    const startInOutput = c.start - rangeOffset
    if (startInOutput + c.duration <= 0) continue
    const actualStart = Math.max(0, startInOutput)
    const skip = actualStart - startInOutput // 範囲開始で途中再生の場合
    src.start(
      actualStart,
      baseOffset + skip * speed,
      Math.max(0, clipDurAtSourceRate - skip * speed)
    )
  }

  return await oc.startRendering()
}

// ---------- メインエクスポート ----------

export async function exportProject(
  state: ProjectState,
  opts: ExportOptions
): Promise<ExportResult> {
  if (!hasWebCodecs) throw new Error('この ブラウザでは どうがの かきだしが できないよ')

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
    // H.264 Level 4.0 は 1080p30 まで。60fps や 1080p 超は Level 4.2 を使う
    videoCodecStr =
      fps > 30 || height > 1080 ? AVC_CODECS.high_1080p60 : AVC_CODECS.high_1080p
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

  notifyProgress(opts, { phase: 'video', done: 0, total: totalFrames, message: '映像エンコード中…' })

  const VFrame = (globalThis as any).VideoFrame
  for (let i = 0; i < totalFrames; i++) {
    checkAbort(signal)
    const t = rangeStart + i / fps

    const needed: HTMLVideoElement[] = []
    const seeks: Promise<void>[] = []
    for (const vc of uniqVideoClips) {
      if (t >= vc.start && t < vc.start + vc.duration) {
        const el = rc.videoEls.get(vc.id)
        if (!el) continue
        const speed = vc.speed ?? 1
        const local = (t - vc.start) * speed
        let inT: number
        if (vc.reversed) {
          // クリップが指す素材区間の終端基準で逆再生
          // (素材ファイル全長 el.duration ではない)
          const segmentEnd = (vc.sourceIn ?? 0) + vc.duration * speed
          inT = Math.max(0, segmentEnd - local)
        } else {
          inT = local + (vc.sourceIn ?? 0)
        }
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
      audioBuf = await renderAudioMix(state, rangeDur, sampleRate, signal, rangeStart)
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
    videoEls: new Map(),
    images: new Map(),
    canvas: (globalThis as any).OffscreenCanvas
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height }),
    ctx: null as any
  }
  rc.ctx = (rc.canvas as any).getContext('2d', { willReadFrequently: true }) as any

  const uniqVideoClips = state.clips.filter(c => c.kind === 'video') as VideoClip[]
  const uniqImageAssetIds = new Set<string>()
  for (const c of state.clips) if (c.kind === 'image') uniqImageAssetIds.add((c as ImageClip).assetId)

  for (const vc of uniqVideoClips) {
    const url = await getAssetObjectURL(state.meta.id, vc.assetId)
    if (!url) continue
    try {
      const el = await makeHiddenVideo(url)
      rc.videoEls.set(vc.id, el)
    } catch {}
  }
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

    const seeks: Promise<void>[] = []
    for (const vc of uniqVideoClips) {
      if (t >= vc.start && t < vc.start + vc.duration) {
        const el = rc.videoEls.get(vc.id)
        if (!el) continue
        const speed = vc.speed ?? 1
        const local = (t - vc.start) * speed
        const inT = vc.reversed
          ? Math.max(0, (vc.sourceIn ?? 0) + vc.duration * speed - local)
          : local + (vc.sourceIn ?? 0)
        seeks.push(seekVideo(el, inT))
      }
    }
    await Promise.all(seeks)

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

  for (const el of rc.videoEls.values()) {
    el.src = ''
    el.load()
  }

  notifyProgress(opts, { phase: 'done', done: 1, total: 1, message: '完了' })

  const safeName = state.meta.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 64) || 'project'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    blob: new Blob([buf], { type: 'image/gif' }),
    filename: `${safeName}__${stamp}.gif`,
    mime: 'image/gif'
  }
}
