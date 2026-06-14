import type {
  Clip,
  ClipEffects,
  ProjectState,
  VideoClip,
  ImageClip,
  AudioClip,
  TextClip,
  ShapeClip,
  ColorGrade,
  ChromaKey,
  PixelEffects,
  BlendMode,
  TextAnim,
  TextDecor
} from '../types/project'
import { getAssetObjectURL } from '../persistence/assetStore'
import { sampleKeyframes } from './keyframes'
import { sampleTransition, type TransitionSample } from './transitions'
import { applyPixelEffects, hasPixelEffects } from './pixelEffects'

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

// Re-usable offscreen buffer for color-grade / chroma-key pixel passes
class PixelBuffer {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 1
    this.canvas.height = 1
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2D ctx (offscreen) failed')
    this.ctx = ctx
  }
  resize(w: number, h: number) {
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
  }
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
  private pixelBuf = new PixelBuffer()

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
    // canvas.width への代入は同値でもキャンバスをクリアするため、変化時のみ。
    // (再生中は毎フレーム setState が呼ばれるので、無条件代入だと点滅する)
    const w = this.state.meta.width
    const h = this.state.meta.height
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
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

    // 範囲再生: out 点が設定されていれば in 点へ戻ってループ。
    // out 点なしで末尾に達した場合は停止。
    const tl = this.state.timeline
    let t = tl.playhead + dt
    const rangeEnd = tl.outPoint ?? tl.duration
    if (t >= rangeEnd) {
      if (tl.outPoint != null) {
        t = tl.inPoint ?? 0
        tl.playhead = t
        this.renderAt(t, true).catch(console.error)
        this.onFrame?.(t)
        this.rafId = requestAnimationFrame(this.loop)
        return
      }
      t = rangeEnd
      tl.playhead = t
      this.renderAt(t, true).catch(console.error)
      this.onFrame?.(t)
      this.pause()
      return
    }
    tl.playhead = t
    this.renderAt(t, true).catch(console.error)
    this.onFrame?.(t)

    this.rafId = requestAnimationFrame(this.loop)
  }

  async renderCurrent() {
    await this.renderAt(this.state.timeline.playhead, false)
  }

  private async renderAt(t: number, driveMedia: boolean) {
    const { ctx } = this
    const { width, height, backgroundColor } = this.state.meta

    ctx.save()
    ctx.filter = 'none'
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
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

  private computeEffective(
    clip: Clip,
    t: number,
    transition: TransitionSample
  ): EffectiveTransform {
    // キーフレームはタイムライン上の経過秒 (speed 非依存) でサンプリングする。
    // UI (Inspector のキーフレーム追加・タイムラインのドット表示) や
    // エクスポートの音量エンベロープと同じ時間軸に揃える。
    // speed 換算 (localTime) はメディアのシーク位置にのみ使う。
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
    base.x += transition.offsetX
    base.y += transition.offsetY
    base.scale *= transition.scale
    base.opacity *= transition.alpha
    base.volume *= transition.volume
    return base
  }

  /** クリップのローカル時刻 (speed を考慮) */
  private localTime(clip: Clip, t: number): number {
    const raw = t - clip.start
    const speed = (clip as any).speed ?? 1
    return raw * speed
  }

  private async syncMedia(activeClips: Clip[], t: number) {
    const activeIds = new Set(activeClips.map(c => c.id))
    for (const [id, node] of this.videoNodes) {
      if (!activeIds.has(id)) node.el.pause()
    }
    for (const [id, node] of this.audioNodes) {
      if (!activeIds.has(id)) node.el.pause()
    }

    const masterVol = this.state.timeline.masterVolume ?? 1
    const anySolo = this.state.tracks.some(t => t.solo)

    for (const clip of activeClips) {
      const tr = this.state.tracks.find(x => x.id === clip.trackId)
      const trans = sampleTransition(clip, t)
      const eff = this.computeEffective(clip, t, trans)
      const trackVol = tr?.volume ?? 1
      const muteBySolo = anySolo && tr?.kind === 'audio' && !tr.solo
      const effVol = Math.max(0, Math.min(1, eff.volume * masterVol * trackVol))

      if (clip.kind === 'video') {
        const node = await this.ensureVideoNode(clip)
        if (!node) continue
        const speed = clip.speed ?? 1
        const local = this.localTime(clip, t)
        // reverse: クリップが指す素材区間の「終端」から逆方向へ。
        // 素材ファイル全長 (node.el.duration) ではなく、クリップが使う
        // 区間長 (clip.duration * speed) を基準にする。
        let inClipTime: number
        if (clip.reversed) {
          const segmentEnd = (clip.sourceIn ?? 0) + clip.duration * speed
          inClipTime = Math.max(0, segmentEnd - local)
        } else {
          inClipTime = local + (clip.sourceIn ?? 0)
        }
        try {
          node.el.playbackRate = Math.max(0.0625, Math.min(16, speed))
        } catch {}
        if (Math.abs(node.el.currentTime - inClipTime) > 0.2) {
          node.el.currentTime = inClipTime
        }
        node.el.muted = !!(clip.muted || tr?.muted || muteBySolo)
        node.el.volume = effVol
        if (this.playing && node.el.paused && !clip.reversed) {
          node.el.play().catch(() => {})
        }
        // reverse 再生は <video> 要素では不可能なため、renderAt 側で seek しつつ描画
        if (clip.reversed) node.el.pause()
      } else if (clip.kind === 'audio') {
        const node = await this.ensureAudioNode(clip)
        if (!node) continue
        const speed = clip.speed ?? 1
        const local = this.localTime(clip, t)
        let inClipTime: number
        if (clip.reversed) {
          const segmentEnd = (clip.sourceIn ?? 0) + clip.duration * speed
          inClipTime = Math.max(0, segmentEnd - local)
        } else {
          inClipTime = local + (clip.sourceIn ?? 0)
        }
        try {
          node.el.playbackRate = Math.max(0.0625, Math.min(16, speed))
        } catch {}
        if (Math.abs(node.el.currentTime - inClipTime) > 0.2) {
          node.el.currentTime = inClipTime
        }
        node.el.muted = !!(clip.muted || tr?.muted || muteBySolo)
        node.el.volume = effVol
        if (this.playing && node.el.paused && !clip.reversed) {
          node.el.play().catch(() => {})
        }
        if (clip.reversed) node.el.pause()
      }
    }
  }

  private async seekOnly(activeClips: Clip[], t: number) {
    for (const clip of activeClips) {
      if (clip.kind === 'video') {
        const node = await this.ensureVideoNode(clip)
        if (!node) continue
        node.el.pause()
        const speed = clip.speed ?? 1
        const local = this.localTime(clip, t)
        let inClipTime: number
        if (clip.reversed) {
          const segmentEnd = (clip.sourceIn ?? 0) + clip.duration * speed
          inClipTime = Math.max(0, segmentEnd - local)
        } else {
          inClipTime = local + (clip.sourceIn ?? 0)
        }
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
      this.onError?.(`どうがを よみこめなかったよ`)
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
      this.onError?.(`おとを よみこめなかったよ`)
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

  private async drawClip(clip: Clip, t: number) {
    const trans = sampleTransition(clip, t)
    const eff = this.computeEffective(clip, t, trans)
    const blend = (clip.blendMode ?? 'normal') as BlendMode
    this.ctx.save()
    if (blend !== 'normal') this.ctx.globalCompositeOperation = blendToCanvas(blend)

    if (clip.kind === 'video') {
      const node = this.videoNodes.get(clip.id)
      if (!node || !node.loaded) {
        this.ctx.restore()
        return
      }
      this.drawVisualSource(
        node.el,
        node.el.videoWidth,
        node.el.videoHeight,
        eff,
        clip.effects,
        clip.colorGrade,
        clip.chromaKey,
        clip.pixelFx,
        trans
      )
    } else if (clip.kind === 'image') {
      const img = await this.ensureImage((clip as ImageClip).assetId)
      if (!img || !img.complete) {
        this.ctx.restore()
        return
      }
      this.drawVisualSource(
        img,
        img.naturalWidth,
        img.naturalHeight,
        eff,
        clip.effects,
        clip.colorGrade,
        clip.chromaKey,
        clip.pixelFx,
        trans
      )
    } else if (clip.kind === 'text') {
      this.drawText(clip as TextClip, eff, trans, t - clip.start)
    } else if (clip.kind === 'shape') {
      this.drawShape(clip as ShapeClip, eff, trans)
    }
    this.ctx.restore()
  }

  /**
   * 画像/映像を 2 段階で描画:
   *  1. 最終 ctx にそのまま drawImage (filter/transform 込み)
   *  2. colorGrade / chromaKey が必要なら、オフスクリーンで合成してから描画
   */
  private drawVisualSource(
    src: CanvasImageSource,
    srcW: number,
    srcH: number,
    eff: EffectiveTransform,
    effects: ClipEffects | undefined,
    grade: ColorGrade | undefined,
    chroma: ChromaKey | undefined,
    pixelFx: PixelEffects | undefined,
    trans: TransitionSample
  ) {
    const { ctx } = this
    const { width, height } = this.state.meta
    if (!srcW || !srcH) return

    const needsPixelPass = !!(
      (grade &&
        (grade.lift || grade.gamma || grade.gain || grade.temperature || grade.tint)) ||
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
      const filter = buildFilterString(effects)
      if (filter) ctx.filter = filter
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
      // オフスクリーンに filter 適用後のピクセルを得て、grade/chroma を掛ける
      const pbufW = Math.max(1, Math.round(Math.abs(drawW)))
      const pbufH = Math.max(1, Math.round(Math.abs(drawH)))
      this.pixelBuf.resize(pbufW, pbufH)
      const pctx = this.pixelBuf.ctx
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
      } catch (e) {
        // tainted canvas 等で失敗した場合は、フィルタ済みだけを描く
      }
      ctx.drawImage(this.pixelBuf.canvas, -drawW / 2, -drawH / 2, drawW, drawH)
    }

    ctx.restore()
  }

  private drawShape(clip: ShapeClip, eff: EffectiveTransform, trans: TransitionSample) {
    const { ctx } = this
    const { width, height } = this.state.meta
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
    // 図形のサイズはキャンバスの短辺を基準に正規化する。
    // 例: 1920x1080 で width=0.3, height=0.3 → 324x324 の正方形になる。
    const ref = Math.min(width, height)
    const w = ref * clip.width * eff.scale
    const h = ref * clip.height * eff.scale
    ctx.translate(cx, cy)
    if (eff.rotation) ctx.rotate((eff.rotation * Math.PI) / 180)
    ctx.fillStyle = clip.style.fill ?? 'transparent'
    ctx.strokeStyle = clip.style.stroke ?? 'transparent'
    ctx.lineWidth = clip.style.strokeWidth ?? 0
    drawShapePrimitive(ctx, clip, w, h)
    if (clip.style.fill) ctx.fill()
    if (clip.style.stroke && (clip.style.strokeWidth ?? 0) > 0) ctx.stroke()
    ctx.restore()
  }

  private drawText(
    clip: TextClip,
    eff: EffectiveTransform,
    trans: TransitionSample,
    localT: number
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

    const anim = clip.anim
    const animProgress = anim && anim.duration > 0
      ? Math.max(0, Math.min(1, localT / anim.duration))
      : 1

    // letter spacing 非対応ブラウザでも動くように手動描画
    const decor = clip.decor
    const letterSpacing = decor?.letterSpacing ?? 0

    // 背景
    if (clip.backgroundColor) {
      const m = ctx.measureText(clip.text)
      const w = m.width + letterSpacing * Math.max(0, clip.text.length - 1)
      const h = clip.fontSize * (decor?.lineHeight ?? 1.3)
      ctx.fillStyle = clip.backgroundColor
      const bx = clip.align === 'center' ? -w / 2 : clip.align === 'right' ? -w : 0
      ctx.fillRect(bx - 16, -h / 2, w + 32, h)
    }

    // shadow
    if (decor?.shadow) {
      ctx.save()
      ctx.shadowColor = decor.shadow.color
      ctx.shadowBlur = decor.shadow.blur
      ctx.shadowOffsetX = decor.shadow.offsetX
      ctx.shadowOffsetY = decor.shadow.offsetY
      drawTextWithAnim(ctx, clip, animProgress, letterSpacing, true)
      ctx.restore()
    }

    // outline
    if (decor?.outline && decor.outline.width > 0) {
      ctx.save()
      ctx.strokeStyle = decor.outline.color
      ctx.lineWidth = decor.outline.width
      ctx.lineJoin = 'round'
      drawTextWithAnim(ctx, clip, animProgress, letterSpacing, true, true)
      ctx.restore()
    }

    ctx.fillStyle = clip.color
    drawTextWithAnim(ctx, clip, animProgress, letterSpacing, false)
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

// ============================================================
// フィルタ文字列
// ============================================================

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

// ============================================================
// ブレンドモード → CanvasCompositeOperation
// ============================================================

export function blendToCanvas(mode: BlendMode): GlobalCompositeOperation {
  switch (mode) {
    case 'multiply': return 'multiply'
    case 'screen': return 'screen'
    case 'overlay': return 'overlay'
    case 'darken': return 'darken'
    case 'lighten': return 'lighten'
    case 'color-dodge': return 'color-dodge'
    case 'color-burn': return 'color-burn'
    case 'hard-light': return 'hard-light'
    case 'soft-light': return 'soft-light'
    case 'difference': return 'difference'
    case 'exclusion': return 'exclusion'
    case 'hue': return 'hue'
    case 'saturation': return 'saturation'
    case 'color': return 'color'
    case 'luminosity': return 'luminosity'
    case 'add': return 'lighter'
    case 'subtract': return 'difference'
    default: return 'source-over'
  }
}

// ============================================================
// カラーグレーディング (ピクセルマニピュレーション)
// ============================================================

export function applyColorGrade(img: ImageData, g: ColorGrade) {
  const d = img.data
  const lift = g.lift
  const gamma = g.gamma
  const gain = g.gain
  const temp = g.temperature ?? 0 // -1..1
  const tint = g.tint ?? 0 // -1..1
  const gammaR = 1 / Math.max(0.05, 1 + (gamma?.r ?? 0))
  const gammaG = 1 / Math.max(0.05, 1 + (gamma?.g ?? 0))
  const gammaB = 1 / Math.max(0.05, 1 + (gamma?.b ?? 0))
  const liftR = lift?.r ?? 0
  const liftG = lift?.g ?? 0
  const liftB = lift?.b ?? 0
  const gainR = 1 + (gain?.r ?? 0)
  const gainG = 1 + (gain?.g ?? 0)
  const gainB = 1 + (gain?.b ?? 0)

  // temperature: +1 でオレンジ (R↑, B↓), -1 で青 (R↓, B↑)
  const tempR = 1 + temp * 0.2
  const tempB = 1 - temp * 0.2
  // tint: +1 でマゼンタ (R/B↑, G↓), -1 で緑 (G↑, R/B↓)
  const tintR = 1 + tint * 0.1
  const tintB = 1 + tint * 0.1
  const tintG = 1 - tint * 0.1

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255
    let g2 = d[i + 1] / 255
    let b = d[i + 2] / 255
    // lift → gain → gamma
    r = (r + liftR * (1 - r)) * gainR
    g2 = (g2 + liftG * (1 - g2)) * gainG
    b = (b + liftB * (1 - b)) * gainB
    r = Math.pow(Math.max(0, Math.min(1, r)), gammaR)
    g2 = Math.pow(Math.max(0, Math.min(1, g2)), gammaG)
    b = Math.pow(Math.max(0, Math.min(1, b)), gammaB)
    // temp / tint
    r = r * tempR * tintR
    g2 = g2 * tintG
    b = b * tempB * tintB
    d[i] = Math.max(0, Math.min(255, r * 255))
    d[i + 1] = Math.max(0, Math.min(255, g2 * 255))
    d[i + 2] = Math.max(0, Math.min(255, b * 255))
  }
}

export function applyChromaKey(img: ImageData, ck: ChromaKey) {
  const d = img.data
  const hex = ck.color
  const r0 = parseInt(hex.slice(1, 3), 16)
  const g0 = parseInt(hex.slice(3, 5), 16)
  const b0 = parseInt(hex.slice(5, 7), 16)
  // RGB の距離 (最大約 441)
  const threshold = ck.threshold * 441
  const soft = Math.max(0.0001, ck.softness) * 441
  const spill = ck.spillSuppress
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    const dist = Math.sqrt(
      (r - r0) * (r - r0) + (g - g0) * (g - g0) + (b - b0) * (b - b0)
    )
    if (dist < threshold) {
      d[i + 3] = 0
    } else if (dist < threshold + soft) {
      const a = (dist - threshold) / soft
      d[i + 3] = Math.round(d[i + 3] * a)
    }
    // spill suppress: 緑 (キーカラー近傍) を desaturate
    if (spill > 0) {
      // 緑キー想定で G を抑制
      const avg = (r + b) / 2
      if (g > avg) {
        d[i + 1] = Math.round(g * (1 - spill) + avg * spill)
      }
    }
  }
}

// ============================================================
// テキスト: アニメーション描画
// ============================================================

function drawTextWithAnim(
  ctx: CanvasRenderingContext2D,
  clip: TextClip,
  progress: number,
  letterSpacing: number,
  decorOnly: boolean,
  strokeOnly = false
) {
  const anim = clip.anim
  const text = clip.text
  const type = anim?.type ?? 'none'

  // letter-spacing が 0 かつ normal (none) ならデフォルト fill/stroke で済む
  if (type === 'none' && letterSpacing === 0) {
    if (strokeOnly) ctx.strokeText(text, 0, 0)
    else ctx.fillText(text, 0, 0)
    return
  }

  // 1 文字ずつ描画 (位置計算は align に依存)
  const chars = Array.from(text)
  const widths = chars.map(ch => ctx.measureText(ch).width)
  const totalW = widths.reduce((a, b) => a + b, 0) + letterSpacing * Math.max(0, chars.length - 1)
  let startX = 0
  if (clip.align === 'center') startX = -totalW / 2
  else if (clip.align === 'right') startX = -totalW
  const prevAlign = ctx.textAlign
  ctx.textAlign = 'left'

  for (let i = 0; i < chars.length; i++) {
    const charProgress = computeCharProgress(type, progress, i, chars.length)
    if (charProgress <= 0) {
      startX += widths[i] + letterSpacing
      continue
    }
    ctx.save()
    // アニメ種別別の変形
    switch (type) {
      case 'fade-words': {
        ctx.globalAlpha = ctx.globalAlpha * charProgress
        break
      }
      case 'slide-chars': {
        const slideY = (1 - charProgress) * 40
        ctx.translate(0, slideY)
        ctx.globalAlpha = ctx.globalAlpha * charProgress
        break
      }
      case 'bounce': {
        const bounce = (1 - charProgress) * -30 * Math.sin(charProgress * Math.PI)
        ctx.translate(0, bounce)
        break
      }
      case 'scale-pop': {
        const s = 0.6 + charProgress * 0.4
        ctx.scale(s, s)
        ctx.globalAlpha = ctx.globalAlpha * charProgress
        break
      }
      case 'wave': {
        const waveY = Math.sin(progress * Math.PI * 2 + i * 0.4) * 10
        ctx.translate(0, waveY)
        break
      }
      case 'typewriter':
      case 'none':
      default:
        break
    }
    if (strokeOnly) ctx.strokeText(chars[i], startX, 0)
    else ctx.fillText(chars[i], startX, 0)
    ctx.restore()
    startX += widths[i] + letterSpacing
  }

  ctx.textAlign = prevAlign
}

function computeCharProgress(
  type: TextAnim['type'] | 'none',
  progress: number,
  idx: number,
  total: number
): number {
  if (type === 'typewriter') {
    const th = (idx + 1) / total
    if (progress >= th) return 1
    return 0
  }
  if (type === 'fade-words' || type === 'slide-chars' || type === 'scale-pop') {
    // 各文字を少しずつ遅延させて出す
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
  if (type === 'wave') return 1 // 常時表示
  return 1
}

// ============================================================
// 図形プリミティブ描画 (path 作成、fill/stroke は呼び出し側で)
// ============================================================

function drawShapePrimitive(
  ctx: CanvasRenderingContext2D,
  clip: ShapeClip,
  w: number,
  h: number
) {
  ctx.beginPath()
  const { shape, style } = clip
  if (shape === 'rect') {
    const r = style.cornerRadius ?? 0
    if (r > 0) {
      roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(r, Math.min(w, h) / 2))
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

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  if (typeof (ctx as any).roundRect === 'function') {
    ;(ctx as any).roundRect(x, y, w, h, r)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
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
