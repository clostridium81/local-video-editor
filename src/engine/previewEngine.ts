import type {
  Clip,
  ClipEffects,
  ProjectState,
  VideoClip,
  ImageClip,
  AudioClip,
  TextClip
} from '../types/project'
import { getAssetObjectURL } from '../persistence/assetStore'
import { sampleKeyframes } from './keyframes'
import { sampleTransition, type TransitionSample } from './transitions'

// ============================================================
// プレビューエンジン
// ============================================================
// 設計方針:
// - ピクセル合成は 2D Canvas でシンプルに始める
// - 動画/音声要素は <video>/<audio> を隠しDOMに作って WebブラウザのH.264/AAC等
//   デコードをそのまま使う (FFmpeg.wasm に頼らない)
// - 再生は requestAnimationFrame で毎フレーム
//   - 各クリップの媒体要素を現在のプレイヘッドに同期
//   - その後 Canvas に z順(トラック順)で描画
// - キーフレーム, トランジション, エフェクトを描画時に適用
// ============================================================

interface VideoMediaNode {
  el: HTMLVideoElement
  loaded: boolean
}
interface AudioMediaNode {
  el: HTMLAudioElement
  loaded: boolean
}

export interface EffectiveTransform {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
  volume: number
}

export class PreviewEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private state: ProjectState

  private videoNodes = new Map<string, VideoMediaNode>()
  private audioNodes = new Map<string, AudioMediaNode>()
  private imageCache = new Map<string, HTMLImageElement>()

  private playing = false
  private lastWallClock = 0
  private rafId: number | null = null

  private onFrame?: (playhead: number) => void
  private onError?: (msg: string) => void

  constructor(canvas: HTMLCanvasElement, state: ProjectState) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2Dコンテキストが取得できません')
    this.ctx = ctx
    this.state = state
    this.resizeCanvas()
  }

  setState(state: ProjectState) {
    this.state = state
    this.resizeCanvas()
    this.pruneNodes()
  }

  setOnFrame(cb: (playhead: number) => void) {
    this.onFrame = cb
  }

  setOnError(cb: (msg: string) => void) {
    this.onError = cb
  }

  private resizeCanvas() {
    this.canvas.width = this.state.meta.width
    this.canvas.height = this.state.meta.height
  }

  private pruneNodes() {
    const liveIds = new Set(this.state.clips.map(c => c.id))
    for (const [id, node] of this.videoNodes) {
      if (!liveIds.has(id)) {
        node.el.pause()
        node.el.src = ''
        this.videoNodes.delete(id)
      }
    }
    for (const [id, node] of this.audioNodes) {
      if (!liveIds.has(id)) {
        node.el.pause()
        node.el.src = ''
        this.audioNodes.delete(id)
      }
    }
  }

  // ---------- 再生制御 ----------

  play() {
    if (this.playing) return
    this.playing = true
    this.lastWallClock = performance.now()
    this.loop()
  }

  pause() {
    this.playing = false
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
    for (const n of this.videoNodes.values()) n.el.pause()
    for (const n of this.audioNodes.values()) n.el.pause()
  }

  isPlaying() {
    return this.playing
  }

  private loop = () => {
    if (!this.playing) return
    const now = performance.now()
    const dt = (now - this.lastWallClock) / 1000
    this.lastWallClock = now

    let t = this.state.timeline.playhead + dt
    if (t >= this.state.timeline.duration) {
      t = this.state.timeline.duration
      this.state.timeline.playhead = t
      this.renderAt(t, true).catch(console.error)
      this.onFrame?.(t)
      this.pause()
      return
    }
    this.state.timeline.playhead = t
    this.renderAt(t, true).catch(console.error)
    this.onFrame?.(t)

    this.rafId = requestAnimationFrame(this.loop)
  }

  async renderCurrent() {
    await this.renderAt(this.state.timeline.playhead, false)
  }

  // ---------- 描画本体 ----------

  private async renderAt(t: number, driveMedia: boolean) {
    const { ctx } = this
    const { width, height, backgroundColor } = this.state.meta

    ctx.save()
    ctx.filter = 'none'
    ctx.globalAlpha = 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, width, height)
    ctx.restore()

    const tracksByOrder = [...this.state.tracks].sort((a, b) => a.order - b.order)
    const trackOrderMap = new Map(tracksByOrder.map((tr, i) => [tr.id, i]))

    const activeClips = this.state.clips
      .filter(c => t >= c.start && t < c.start + c.duration)
      .sort((a, b) => {
        const oa = trackOrderMap.get(a.trackId) ?? 0
        const ob = trackOrderMap.get(b.trackId) ?? 0
        return oa - ob
      })

    if (driveMedia) {
      await this.syncMedia(activeClips, t)
    } else {
      await this.seekOnly(activeClips, t)
    }

    for (const clip of activeClips) {
      const track = this.state.tracks.find(tr => tr.id === clip.trackId)
      if (track?.kind === 'audio') continue
      await this.drawClip(clip, t)
    }
  }

  /**
   * クリップの有効 transform (キーフレーム + transition) を計算。
   */
  private computeEffective(
    clip: Clip,
    t: number,
    transition: TransitionSample
  ): EffectiveTransform {
    const local = t - clip.start
    const base: EffectiveTransform = {
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
    // transition 合成
    base.x += transition.offsetX
    base.y += transition.offsetY
    base.scale *= transition.scale
    base.opacity *= transition.alpha
    base.volume *= transition.volume
    return base
  }

  private async syncMedia(activeClips: Clip[], t: number) {
    const activeIds = new Set(activeClips.map(c => c.id))
    for (const [id, node] of this.videoNodes) {
      if (!activeIds.has(id)) node.el.pause()
    }
    for (const [id, node] of this.audioNodes) {
      if (!activeIds.has(id)) node.el.pause()
    }

    for (const clip of activeClips) {
      const tr = this.state.tracks.find(x => x.id === clip.trackId)
      const trans = sampleTransition(clip, t)
      const eff = this.computeEffective(clip, t, trans)
      if (clip.kind === 'video') {
        const node = await this.ensureVideoNode(clip)
        if (!node) continue
        const inClipTime = t - clip.start + (clip.sourceIn ?? 0)
        if (Math.abs(node.el.currentTime - inClipTime) > 0.2) {
          node.el.currentTime = inClipTime
        }
        node.el.muted = !!(clip.muted || tr?.muted)
        node.el.volume = Math.max(0, Math.min(1, eff.volume))
        if (this.playing && node.el.paused) {
          node.el.play().catch(() => {})
        }
      } else if (clip.kind === 'audio') {
        const node = await this.ensureAudioNode(clip)
        if (!node) continue
        const inClipTime = t - clip.start + (clip.sourceIn ?? 0)
        if (Math.abs(node.el.currentTime - inClipTime) > 0.2) {
          node.el.currentTime = inClipTime
        }
        node.el.muted = !!(clip.muted || tr?.muted)
        node.el.volume = Math.max(0, Math.min(1, eff.volume))
        if (this.playing && node.el.paused) {
          node.el.play().catch(() => {})
        }
      }
    }
  }

  private async seekOnly(activeClips: Clip[], t: number) {
    for (const clip of activeClips) {
      if (clip.kind === 'video') {
        const node = await this.ensureVideoNode(clip)
        if (!node) continue
        node.el.pause()
        const inClipTime = t - clip.start + (clip.sourceIn ?? 0)
        node.el.currentTime = inClipTime
      } else if (clip.kind === 'audio') {
        const node = await this.ensureAudioNode(clip)
        if (!node) continue
        node.el.pause()
      }
    }
    const activeIds = new Set(activeClips.map(c => c.id))
    for (const [id, node] of this.videoNodes) {
      if (!activeIds.has(id)) node.el.pause()
    }
    for (const [id, node] of this.audioNodes) {
      if (!activeIds.has(id)) node.el.pause()
    }
  }

  // ---------- メディアノードの用意 ----------

  private async ensureVideoNode(clip: VideoClip): Promise<VideoMediaNode | null> {
    let node = this.videoNodes.get(clip.id)
    if (node) return node
    const url = await getAssetObjectURL(this.state.meta.id, clip.assetId)
    if (!url) return null
    const el = document.createElement('video')
    el.src = url
    el.crossOrigin = 'anonymous'
    el.playsInline = true
    el.preload = 'auto'
    el.addEventListener('error', () => {
      this.onError?.(`動画の読み込みに失敗しました`)
    })
    node = { el, loaded: false }
    this.videoNodes.set(clip.id, node)
    await waitEvent(el, 'loadeddata').catch(() => {})
    node.loaded = true
    return node
  }

  private async ensureAudioNode(clip: AudioClip): Promise<AudioMediaNode | null> {
    let node = this.audioNodes.get(clip.id)
    if (node) return node
    const url = await getAssetObjectURL(this.state.meta.id, clip.assetId)
    if (!url) return null
    const el = document.createElement('audio')
    el.src = url
    el.preload = 'auto'
    el.addEventListener('error', () => {
      this.onError?.(`音声の読み込みに失敗しました`)
    })
    node = { el, loaded: false }
    this.audioNodes.set(clip.id, node)
    await waitEvent(el, 'loadeddata').catch(() => {})
    node.loaded = true
    return node
  }

  private async ensureImage(assetId: string): Promise<HTMLImageElement | null> {
    const cached = this.imageCache.get(assetId)
    if (cached && cached.complete) return cached
    const url = await getAssetObjectURL(this.state.meta.id, assetId)
    if (!url) return null
    const img = new Image()
    img.src = url
    this.imageCache.set(assetId, img)
    await waitEvent(img, 'load').catch(() => {})
    return img
  }

  // ---------- 個別クリップの描画 ----------

  private async drawClip(clip: Clip, t: number) {
    const trans = sampleTransition(clip, t)
    const eff = this.computeEffective(clip, t, trans)
    if (clip.kind === 'video') {
      const node = this.videoNodes.get(clip.id)
      if (!node || !node.loaded) return
      this.drawTransformed(
        node.el,
        node.el.videoWidth,
        node.el.videoHeight,
        eff,
        clip.effects,
        trans
      )
    } else if (clip.kind === 'image') {
      const img = await this.ensureImage((clip as ImageClip).assetId)
      if (!img || !img.complete) return
      this.drawTransformed(
        img,
        img.naturalWidth,
        img.naturalHeight,
        eff,
        clip.effects,
        trans
      )
    } else if (clip.kind === 'text') {
      this.drawText(clip as TextClip, eff, trans)
    }
  }

  private drawTransformed(
    src: CanvasImageSource,
    srcW: number,
    srcH: number,
    eff: EffectiveTransform,
    effects: ClipEffects | undefined,
    trans: TransitionSample
  ) {
    const { ctx } = this
    const { width, height } = this.state.meta

    if (!srcW || !srcH) return

    const fit = Math.min(width / srcW, height / srcH)
    const drawW = srcW * fit * eff.scale
    const drawH = srcH * fit * eff.scale
    const cx = width * eff.x
    const cy = height * eff.y

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, eff.opacity))
    if (effects) {
      const filter = buildFilterString(effects)
      if (filter) ctx.filter = filter
    }
    if (trans.isWipe) {
      // 左→右に wipe
      const wipeW = width * trans.wipeProgress
      ctx.beginPath()
      ctx.rect(0, 0, wipeW, height)
      ctx.clip()
    }
    ctx.translate(cx, cy)
    if (eff.rotation) ctx.rotate((eff.rotation * Math.PI) / 180)
    ctx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH)
    ctx.restore()
  }

  private drawText(
    clip: TextClip,
    eff: EffectiveTransform,
    trans: TransitionSample
  ) {
    const { ctx } = this
    const { width, height } = this.state.meta
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
      const metrics = ctx.measureText(clip.text)
      const w = metrics.width
      const h = clip.fontSize * 1.3
      ctx.fillStyle = clip.backgroundColor
      const bx = clip.align === 'center' ? -w / 2 : clip.align === 'right' ? -w : 0
      ctx.fillRect(bx - 16, -h / 2, w + 32, h)
    }

    ctx.fillStyle = clip.color
    ctx.fillText(clip.text, 0, 0)
    ctx.restore()
  }

  dispose() {
    this.pause()
    for (const n of this.videoNodes.values()) {
      n.el.pause()
      n.el.src = ''
    }
    this.videoNodes.clear()
    for (const n of this.audioNodes.values()) {
      n.el.pause()
      n.el.src = ''
    }
    this.audioNodes.clear()
    this.imageCache.clear()
  }
}

export function buildFilterString(effects: ClipEffects): string {
  const parts: string[] = []
  if (effects.brightness !== undefined && effects.brightness !== 1)
    parts.push(`brightness(${clampNum(effects.brightness, 0, 4)})`)
  if (effects.contrast !== undefined && effects.contrast !== 1)
    parts.push(`contrast(${clampNum(effects.contrast, 0, 4)})`)
  if (effects.saturation !== undefined && effects.saturation !== 1)
    parts.push(`saturate(${clampNum(effects.saturation, 0, 4)})`)
  if (effects.blur !== undefined && effects.blur > 0)
    parts.push(`blur(${clampNum(effects.blur, 0, 100)}px)`)
  if (effects.hueRotate !== undefined && effects.hueRotate !== 0)
    parts.push(`hue-rotate(${clampNum(effects.hueRotate, -360, 360)}deg)`)
  if (effects.grayscale !== undefined && effects.grayscale > 0)
    parts.push(`grayscale(${clampNum(effects.grayscale, 0, 1)})`)
  if (effects.invert !== undefined && effects.invert > 0)
    parts.push(`invert(${clampNum(effects.invert, 0, 1)})`)
  if (effects.sepia !== undefined && effects.sepia > 0)
    parts.push(`sepia(${clampNum(effects.sepia, 0, 1)})`)
  return parts.join(' ')
}

function clampNum(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function waitEvent(el: EventTarget, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onErr = () => {
      cleanup()
      reject(new Error(`${name} failed`))
    }
    const cleanup = () => {
      el.removeEventListener(name, onOk)
      el.removeEventListener('error', onErr)
    }
    el.addEventListener(name, onOk, { once: true })
    el.addEventListener('error', onErr, { once: true })
  })
}

