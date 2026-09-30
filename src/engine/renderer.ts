import type {
  Clip,
  ClipEffects,
  ColorGrade,
  ChromaKey,
  Crop,
  Mask,
  BgFill,
  PixelEffects,
  BlendMode,
  TextClip,
  ShapeClip,
  TextAnim,
  Karaoke
} from '../types/project'
import { sampleKeyframes } from './keyframes'
import {
  sampleTransition,
  sampleAudioFade,
  type TransitionSample,
  type RevealRect
} from './transitions'
import { applyPixelEffects, hasPixelEffects } from './pixelEffects'
import { applyAnimatedProps } from './animatable'
import { karaokeLines, type KaraokeTokenState } from './karaoke'

// ============================================================
// クリップ 1 枚分の合成描画 (プレビュー / 書き出し共通)
// ============================================================
// previewEngine と exportEngine は「どのフレーム/画像を使うか」だけが異なり、
// 変形・エフェクト・トランジション・テキスト/図形の描き方は同一でなければ
// ならない。ここに集約し、両エンジンは drawClip() を呼ぶだけにする。
// ============================================================

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface EffectiveTransform {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
  volume: number
}

/**
 * キーフレーム・トランジション・音量フェード適用後の値。
 * キーフレームはタイムライン上の経過秒 (speed 非依存) でサンプリングする。
 * UI (Inspector のキーフレーム追加・タイムラインのドット表示) や
 * 書き出しの音量エンベロープと同じ時間軸に揃える。
 */
export function computeEffective(
  clip: Clip,
  t: number
): { eff: EffectiveTransform; trans: TransitionSample; localT: number } {
  const local = t - clip.start
  const eff: EffectiveTransform = {
    x: (clip as any).x ?? 0.5,
    y: (clip as any).y ?? 0.5,
    scale: (clip as any).scale ?? 1,
    rotation: (clip as any).rotation ?? 0,
    opacity: clip.opacity ?? 1,
    volume: clip.volume ?? 1
  }
  const kfs = clip.keyframes
  if (kfs) {
    eff.x = sampleKeyframes(kfs.x, local, eff.x)
    eff.y = sampleKeyframes(kfs.y, local, eff.y)
    eff.scale = sampleKeyframes(kfs.scale, local, eff.scale)
    eff.rotation = sampleKeyframes(kfs.rotation, local, eff.rotation)
    eff.opacity = sampleKeyframes(kfs.opacity, local, eff.opacity)
    eff.volume = sampleKeyframes(kfs.volume, local, eff.volume)
  }
  const trans = sampleTransition(clip, t)
  eff.x += trans.offsetX
  eff.y += trans.offsetY
  eff.scale *= trans.scale
  eff.rotation += trans.rotation
  eff.opacity *= trans.alpha
  eff.volume *= trans.volume * sampleAudioFade(clip, local)
  return { eff, trans, localT: local }
}

/**
 * px 指定の値 (文字サイズ・線幅など) の基準倍率。
 * 1080p (短辺 1080px) を 1 とし、書き出し解像度や縦長キャンバスでも
 * 画面に対する見た目の大きさを揃える。
 */
export function pxUnit(width: number, height: number): number {
  return Math.min(width, height) / 1080
}

// ---------- クロップ / 表示サイズ ----------

/** crop を素材のピクセル矩形に変換 (不正値は安全な範囲に丸める) */
export function cropRect(crop: Crop | undefined, srcW: number, srcH: number) {
  if (!crop) return { sx: 0, sy: 0, sw: srcW, sh: srcH }
  const c = normalizeCrop(crop)
  return {
    sx: srcW * c.left,
    sy: srcH * c.top,
    sw: Math.max(1, srcW * (1 - c.left - c.right)),
    sh: Math.max(1, srcH * (1 - c.top - c.bottom))
  }
}

/** 各辺 0..0.95、対辺の合計が 0.95 以下になるよう丸める */
export function normalizeCrop(crop: Crop): Crop {
  const cl = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(0.95, v)) : 0)
  let { left, top, right, bottom } = {
    left: cl(crop.left),
    top: cl(crop.top),
    right: cl(crop.right),
    bottom: cl(crop.bottom)
  }
  if (left + right > 0.95) right = Math.max(0, 0.95 - left)
  if (top + bottom > 0.95) bottom = Math.max(0, 0.95 - top)
  return { left, top, right, bottom }
}

export function hasCrop(crop: Crop | undefined): boolean {
  return !!crop && (crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0)
}

/**
 * 画像/映像クリップのキャンバス上の表示サイズ (scale 適用後, 回転前)。
 * 切り抜き後の縦横比でキャンバスに contain フィットする。
 * プレビューの選択枠・ヒットテストもこの値を使う。
 */
export function visualDrawSize(
  srcW: number,
  srcH: number,
  crop: Crop | undefined,
  width: number,
  height: number,
  scale: number
): { w: number; h: number } {
  const { sw, sh } = cropRect(crop, srcW, srcH)
  const fit = Math.min(width / sw, height / sh)
  return { w: sw * fit * scale, h: sh * fit * scale }
}

// ---------- オフスクリーンバッファ ----------

/** grade / mask 等の中間バッファの 1 辺の上限 (4096² × 4B ≒ 64MB) */
export const MAX_LAYER_SIDE = 4096

/** grade / chroma / pixelFx / mask 用の再利用バッファ */
export class LayerBuffer {
  private canvas_: HTMLCanvasElement | null = null
  private ctx_: CanvasRenderingContext2D | null = null

  get(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    if (!this.canvas_ || !this.ctx_) {
      const c = document.createElement('canvas')
      c.width = 1
      c.height = 1
      const ctx = c.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('2D ctx (offscreen) failed')
      this.canvas_ = c
      this.ctx_ = ctx
    }
    if (this.canvas_.width !== w) this.canvas_.width = w
    if (this.canvas_.height !== h) this.canvas_.height = h
    return { canvas: this.canvas_, ctx: this.ctx_ }
  }
}

// ---------- クリップ描画のエントリポイント ----------

export interface DrawTarget {
  ctx: Ctx2D
  width: number
  height: number
  buffer: LayerBuffer
  /** 背景ぼかし塗り用 (縮小バッファ)。省略時は背景塗りを描かない */
  bgBuffer?: LayerBuffer
}

export interface VisualSource {
  src: CanvasImageSource
  width: number
  height: number
}

/**
 * 1 クリップを描画する。video / image は source を呼び出し側が用意する
 * (null なら描かない)。text / shape は source 不要。
 */
export function drawClip(
  target: DrawTarget,
  rawClip: Clip,
  t: number,
  source: VisualSource | null
) {
  const { ctx } = target
  const { eff, trans, localT } = computeEffective(rawClip, t)
  // エフェクト・マスク・文字サイズ等のキーフレームを、この時刻の値として埋め込む
  const clip = applyAnimatedProps(rawClip, localT)
  const blend = (clip.blendMode ?? 'normal') as BlendMode
  ctx.save()
  // 途中で例外が出ても clip 領域・変形が残って以降の全フレームが崩れないよう、必ず restore する
  try {
    drawClipBody(target, clip, eff, trans, localT, source, blend)
  } finally {
    ctx.restore()
  }
}

function drawClipBody(
  target: DrawTarget,
  clip: Clip,
  eff: EffectiveTransform,
  trans: TransitionSample,
  localT: number,
  source: VisualSource | null,
  blend: BlendMode
) {
  const { ctx } = target
  if (blend !== 'normal') ctx.globalCompositeOperation = blendToCanvas(blend)
  if (clip.kind === 'video' || clip.kind === 'image') {
    if (source) {
      drawVisualSource(target, source, eff, trans, {
        effects: clip.effects,
        grade: clip.colorGrade,
        chroma: clip.chromaKey,
        pixelFx: clip.pixelFx,
        crop: clip.crop,
        mask: clip.mask,
        bgFill: clip.bgFill
      })
    }
  } else if (clip.kind === 'text') {
    drawText(target, clip, eff, trans, localT)
  } else if (clip.kind === 'shape') {
    drawShape(target, clip, eff, trans)
  }
}

// ---------- 共通の前処理 (不透明度 / フィルタ / 表示領域 / 変形) ----------

function transitionFilter(trans: TransitionSample, unit: number): string {
  const parts: string[] = []
  if (trans.blur > 0) parts.push(`blur(${(trans.blur * unit).toFixed(2)}px)`)
  if (trans.brightness !== 1) parts.push(`brightness(${trans.brightness.toFixed(3)})`)
  return parts.join(' ')
}

function joinFilters(...fs: string[]): string {
  return fs.filter(Boolean).join(' ')
}

function applyReveal(ctx: Ctx2D, trans: TransitionSample, width: number, height: number) {
  const r = trans.reveal
  if (!r) return
  const cx = width / 2
  const cy = height / 2
  // circle / poly / sector の単位 (画面の対角の半分)
  const R = Math.hypot(width, height) / 2
  ctx.beginPath()
  switch (r.kind) {
    case 'rect':
      rectPath(ctx, r, width, height)
      break
    case 'rects':
      for (const rc of r.rects) rectPath(ctx, rc, width, height)
      break
    case 'circle':
      ctx.arc(cx, cy, R * Math.max(0, r.r), 0, Math.PI * 2)
      break
    case 'poly':
      r.points.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(cx + x * R, cy + y * R)
        else ctx.lineTo(cx + x * R, cy + y * R)
      })
      ctx.closePath()
      break
    case 'npoly':
      r.points.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x * width, y * height)
        else ctx.lineTo(x * width, y * height)
      })
      ctx.closePath()
      break
    case 'sector':
      if (r.sweep >= Math.PI * 2) {
        ctx.rect(0, 0, width, height)
      } else if (r.sweep > 0) {
        const start = -Math.PI / 2
        ctx.moveTo(cx, cy)
        ctx.arc(cx, cy, R * 1.01, start, start + r.sweep)
        ctx.closePath()
      }
      break
  }
  ctx.clip()
}

function rectPath(ctx: Ctx2D, r: RevealRect, width: number, height: number) {
  ctx.rect(
    width * r.x0,
    height * r.y0,
    width * Math.max(0, r.x1 - r.x0),
    height * Math.max(0, r.y1 - r.y0)
  )
}

/** 回転の後に掛ける、トランジション由来の横/縦だけの伸縮 */
function applyAxisScale(ctx: Ctx2D, trans: TransitionSample) {
  if (trans.scaleX !== 1 || trans.scaleY !== 1) {
    // 0 ちょうどだと変換行列が退化して描画系が例外を出す環境があるため下限を置く
    ctx.scale(Math.max(1e-4, trans.scaleX), Math.max(1e-4, trans.scaleY))
  }
}

// ---------- 画像 / 映像 ----------

interface VisualParams {
  effects?: ClipEffects
  grade?: ColorGrade
  chroma?: ChromaKey
  pixelFx?: PixelEffects
  crop?: Crop
  mask?: Mask
  bgFill?: BgFill
}

function needsGradePass(grade: ColorGrade | undefined): boolean {
  return !!(grade && (grade.lift || grade.gamma || grade.gain || grade.temperature || grade.tint))
}

/**
 * 画像/映像を描画:
 *  - 追加処理が無ければ最終 ctx にそのまま drawImage (filter/transform 込み)
 *  - colorGrade / chromaKey / pixelFx / mask が必要ならオフスクリーンで
 *    処理してから描画
 */
function drawVisualSource(
  target: DrawTarget,
  source: VisualSource,
  eff: EffectiveTransform,
  trans: TransitionSample,
  p: VisualParams
) {
  const { ctx, width, height } = target
  const { src } = source
  if (!source.width || !source.height) return
  const unit = pxUnit(width, height)

  // トランジションのモザイクは素材のピクセルエフェクトに重ねる (粗い方を採用)
  const transPixelate = Math.round(trans.pixelate * unit)
  const pixelFx: PixelEffects | undefined =
    transPixelate >= 2
      ? { ...p.pixelFx, pixelate: Math.max(p.pixelFx?.pixelate ?? 0, transPixelate) }
      : p.pixelFx
  const needsPixelPass = needsGradePass(p.grade) || !!p.chroma?.enabled || hasPixelEffects(pixelFx)
  const mask = p.mask
  const needsLayer = needsPixelPass || !!mask
  const cropped = hasCrop(p.crop)
  const { sx, sy, sw, sh } = cropRect(p.crop, source.width, source.height)

  const { w: drawW, h: drawH } = visualDrawSize(
    source.width, source.height, p.crop, width, height, eff.scale
  )
  const effectsFilter = p.effects ? buildFilterString(p.effects) : ''

  if (p.bgFill && target.bgBuffer) {
    // 画面を覆っている (中央・回転なし・余白なし) なら背景は見えないので省く
    const covers =
      Math.abs(drawW) >= width - 1 && Math.abs(drawH) >= height - 1 &&
      Math.abs(eff.x - 0.5) < 1e-3 && Math.abs(eff.y - 0.5) < 1e-3 &&
      eff.rotation % 360 === 0 && trans.scaleX === 1 && trans.scaleY === 1
    if (!covers) {
      drawBgFill(target, source, { sx, sy, sw, sh }, p.bgFill, effectsFilter, eff, trans, unit)
    }
  }

  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, eff.opacity))
  // レイヤー経由のときはエフェクトのフィルタをバッファ側で掛けるため、
  // ここではトランジション由来のフィルタだけにする (二重適用を防ぐ)
  const outerFilter = joinFilters(needsLayer ? '' : effectsFilter, transitionFilter(trans, unit))
  if (outerFilter) ctx.filter = outerFilter
  applyReveal(ctx, trans, width, height)
  ctx.translate(width * eff.x, height * eff.y)
  if (eff.rotation) ctx.rotate((eff.rotation * Math.PI) / 180)
  applyAxisScale(ctx, trans)

  if (!needsLayer) {
    if (cropped) ctx.drawImage(src, sx, sy, sw, sh, -drawW / 2, -drawH / 2, drawW, drawH)
    else ctx.drawImage(src, -drawW / 2, -drawH / 2, drawW, drawH)
    ctx.restore()
    return
  }

  // バッファは「表示サイズ」ではなく「素材の解像度」と 1 辺 MAX_LAYER_SIDE で頭打ちにし、
  // 画面上の拡大は最後の drawImage に任せる。大きく拡大したクリップで数百 MB の
  // キャンバス + 毎フレームの getImageData が走り、タブが落ちるのを防ぐ。
  // px 指定の効果 (ぼかし・モザイク・色収差) はバッファの縮小率 k に合わせて換算する。
  const absW = Math.max(1e-6, Math.abs(drawW))
  const absH = Math.max(1e-6, Math.abs(drawH))
  const k = Math.min(1, sw / absW, sh / absH, MAX_LAYER_SIDE / absW, MAX_LAYER_SIDE / absH)
  const bw = Math.max(1, Math.round(absW * k))
  const bh = Math.max(1, Math.round(absH * k))
  const bufFilter = p.effects
    ? buildFilterString(k < 1 && p.effects.blur ? { ...p.effects, blur: p.effects.blur * k } : p.effects)
    : ''
  const bufPixelFx: PixelEffects | undefined =
    pixelFx && k < 1
      ? {
          ...pixelFx,
          pixelate: pixelFx.pixelate ? Math.max(pixelFx.pixelate > 1 ? 2 : 0, Math.round(pixelFx.pixelate * k)) : pixelFx.pixelate,
          chromaticAberration: pixelFx.chromaticAberration ? pixelFx.chromaticAberration * k : pixelFx.chromaticAberration
        }
      : pixelFx
  const { canvas: buf, ctx: bctx } = target.buffer.get(bw, bh)
  bctx.save()
  bctx.setTransform(1, 0, 0, 1, 0, 0)
  bctx.filter = bufFilter || 'none'
  bctx.globalCompositeOperation = 'source-over'
  bctx.globalAlpha = 1
  bctx.clearRect(0, 0, bw, bh)
  bctx.drawImage(src, sx, sy, sw, sh, 0, 0, bw, bh)
  bctx.restore()

  if (needsPixelPass) {
    try {
      const img = bctx.getImageData(0, 0, bw, bh)
      if (p.chroma?.enabled) applyChromaKey(img, p.chroma)
      if (p.grade) applyColorGrade(img, p.grade)
      if (hasPixelEffects(bufPixelFx)) applyPixelEffects(img, bufPixelFx)
      bctx.putImageData(img, 0, 0)
    } catch {
      // tainted canvas 等で失敗した場合は、フィルタ済みだけを描く
    }
  }
  if (mask) applyMask(bctx, bw, bh, mask)

  ctx.drawImage(buf, -drawW / 2, -drawH / 2, drawW, drawH)
  ctx.restore()
}

/**
 * 背景ぼかし塗り: 素材を画面いっぱい (cover) に縮小バッファへ描き、
 * ぼかしながら画面サイズに拡大して敷く。ぼかしで端が透けないよう、
 * ぼかし幅の分だけ画面の外まで広げて描く。
 */
function drawBgFill(
  target: DrawTarget,
  source: VisualSource,
  rect: { sx: number; sy: number; sw: number; sh: number },
  fill: BgFill,
  effectsFilter: string,
  eff: EffectiveTransform,
  trans: TransitionSample,
  unit: number
) {
  const { ctx, width, height } = target
  const k = 8 // 縮小率 (縮小そのものがぼかしの大部分を担う)
  const bw = Math.max(1, Math.ceil(width / k))
  const bh = Math.max(1, Math.ceil(height / k))
  const { canvas: buf, ctx: b } = target.bgBuffer!.get(bw, bh)
  const cover = Math.max(bw / rect.sw, bh / rect.sh)
  const dw = rect.sw * cover
  const dh = rect.sh * cover
  b.save()
  b.setTransform(1, 0, 0, 1, 0, 0)
  b.globalAlpha = 1
  b.globalCompositeOperation = 'source-over'
  b.filter = effectsFilter || 'none'
  b.clearRect(0, 0, bw, bh)
  b.drawImage(source.src, rect.sx, rect.sy, rect.sw, rect.sh, (bw - dw) / 2, (bh - dh) / 2, dw, dh)
  b.restore()

  const blurPx = Math.max(0, fill.blur) * unit
  const margin = blurPx * 2
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, eff.opacity))
  const dim = Math.max(0, Math.min(1, fill.dim))
  ctx.filter =
    joinFilters(
      blurPx > 0.5 ? `blur(${blurPx.toFixed(1)}px)` : '',
      dim > 0 ? `brightness(${(1 - dim).toFixed(3)})` : '',
      transitionFilter(trans, unit)
    ) || 'none'
  applyReveal(ctx, trans, width, height)
  ctx.imageSmoothingEnabled = true
  ;(ctx as any).imageSmoothingQuality = 'high'
  ctx.drawImage(buf, -margin, -margin, width + margin * 2, height + margin * 2)
  ctx.restore()
}

/**
 * レイヤー (w×h) にマスクを掛ける。マスク図形を destination-in (反転時は
 * destination-out) で重ね、feather は図形側を blur してぼかす。
 */
export function applyMask(bctx: Ctx2D, w: number, h: number, mask: Mask) {
  const feather = Math.max(0, Math.min(1, mask.feather)) * Math.min(w, h) * 0.25
  bctx.save()
  bctx.setTransform(1, 0, 0, 1, 0, 0)
  bctx.globalAlpha = 1
  bctx.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in'
  bctx.filter = feather > 0.5 ? `blur(${feather.toFixed(1)}px)` : 'none'
  bctx.fillStyle = '#000'
  bctx.translate(w * mask.x, h * mask.y)
  if (mask.rotation) bctx.rotate((mask.rotation * Math.PI) / 180)
  bctx.beginPath()
  const mw = Math.max(0, mask.width) * w
  const mh = Math.max(0, mask.height) * h
  if (mask.shape === 'ellipse') {
    bctx.ellipse(0, 0, mw / 2, mh / 2, 0, 0, Math.PI * 2)
  } else if (mask.shape === 'linear') {
    // 中心を通る直線の上側 (回転 0° で画面上側) を残す
    const L = Math.hypot(w, h) * 2
    bctx.rect(-L, -L, L * 2, L)
  } else {
    bctx.rect(-mw / 2, -mh / 2, mw, mh)
  }
  bctx.fill()
  bctx.restore()
}

// ---------- 図形 ----------

function drawShape(
  target: DrawTarget,
  clip: ShapeClip,
  eff: EffectiveTransform,
  trans: TransitionSample
) {
  const { ctx, width, height } = target
  const unit = pxUnit(width, height)
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, eff.opacity))
  const filter = joinFilters(
    clip.effects ? buildFilterString(clip.effects) : '',
    transitionFilter(trans, unit)
  )
  if (filter) ctx.filter = filter
  applyReveal(ctx, trans, width, height)
  // 図形のサイズはキャンバスの短辺を基準に正規化する。
  // 例: 1920x1080 で width=0.3, height=0.3 → 324x324 の正方形になる。
  const ref = Math.min(width, height)
  const w = ref * clip.width * eff.scale
  const h = ref * clip.height * eff.scale
  ctx.translate(width * eff.x, height * eff.y)
  if (eff.rotation) ctx.rotate((eff.rotation * Math.PI) / 180)
  applyAxisScale(ctx, trans)
  ctx.fillStyle = clip.style.fill ?? 'transparent'
  ctx.strokeStyle = clip.style.stroke ?? 'transparent'
  ctx.lineWidth = (clip.style.strokeWidth ?? 0) * unit
  shapePath(ctx, clip, w, h, (clip.style.cornerRadius ?? 0) * unit)
  if (clip.style.fill) ctx.fill()
  if (clip.style.stroke && (clip.style.strokeWidth ?? 0) > 0) ctx.stroke()
  ctx.restore()
}

function shapePath(ctx: Ctx2D, clip: ShapeClip, w: number, h: number, radius: number) {
  ctx.beginPath()
  const { shape } = clip
  if (shape === 'rect') {
    if (radius > 0) {
      roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(radius, Math.min(Math.abs(w), Math.abs(h)) / 2))
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

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
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

// ---------- テキスト ----------

/**
 * テキストを描画する。改行で複数行になり、行の中央が y 位置に揃う。
 * fontSize などの px 値は 1080p 基準で、pxUnit() 倍して描く。
 */
function drawText(
  target: DrawTarget,
  clip: TextClip,
  eff: EffectiveTransform,
  trans: TransitionSample,
  localT: number
) {
  const { ctx, width, height } = target
  const unit = pxUnit(width, height)
  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, eff.opacity))
  const filter = transitionFilter(trans, unit)
  if (filter) ctx.filter = filter
  applyReveal(ctx, trans, width, height)
  const weight = clip.bold ? '700' : '400'
  const style = clip.italic ? 'italic' : 'normal'
  ctx.translate(width * eff.x, height * eff.y)
  if (eff.rotation) ctx.rotate((eff.rotation * Math.PI) / 180)
  applyAxisScale(ctx, trans)
  // 以降は 1080p 基準の座標系で描く
  const s = eff.scale * unit
  if (s !== 1) ctx.scale(s, s)
  ctx.font = `${style} ${weight} ${clip.fontSize}px ${clip.fontFamily}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = clip.align

  const anim = clip.anim
  const progress = anim && anim.duration > 0
    ? Math.max(0, Math.min(1, localT / anim.duration))
    : 1
  const decor = clip.decor
  const letterSpacing = decor?.letterSpacing ?? 0
  const lineH = clip.fontSize * (decor?.lineHeight ?? 1.3)
  const lines = clip.text.split(/\r?\n/)
  const totalChars = lines.reduce((n, l) => n + Array.from(l).length, 0)

  const eachLine = (fn: (line: string, y: number, charOffset: number) => void) => {
    let offset = 0
    lines.forEach((line, i) => {
      fn(line, (i - (lines.length - 1) / 2) * lineH, offset)
      offset += Array.from(line).length
    })
  }

  // 背景 (行ごと)
  if (clip.backgroundColor) {
    ctx.fillStyle = clip.backgroundColor
    eachLine((line, y) => {
      if (!line) return
      const w = ctx.measureText(line).width + letterSpacing * Math.max(0, Array.from(line).length - 1)
      const bx = clip.align === 'center' ? -w / 2 : clip.align === 'right' ? -w : 0
      ctx.fillRect(bx - 16, y - lineH / 2, w + 32, lineH)
    })
  }

  // 単語ハイライト字幕 (カラオケ風) は単語ごとに描く (文字アニメより優先)
  if (clip.karaoke) {
    drawKaraokeText(ctx, clip, clip.karaoke, localT, lineH, letterSpacing, unit)
    ctx.restore()
    return
  }

  const run = (strokeOnly: boolean) =>
    eachLine((line, y, offset) =>
      drawTextLine(ctx, clip, line, y, progress, letterSpacing, strokeOnly, offset, totalChars)
    )

  if (decor?.shadow) {
    ctx.save()
    // shadow 系は変形の影響を受けないので、画面上の大きさに合わせて換算する
    ctx.shadowColor = decor.shadow.color
    ctx.shadowBlur = decor.shadow.blur * unit
    ctx.shadowOffsetX = decor.shadow.offsetX * unit
    ctx.shadowOffsetY = decor.shadow.offsetY * unit
    ctx.fillStyle = decor.shadow.color
    run(false)
    ctx.restore()
  }
  if (decor?.outline && decor.outline.width > 0) {
    ctx.save()
    ctx.strokeStyle = decor.outline.color
    ctx.lineWidth = decor.outline.width
    ctx.lineJoin = 'round'
    run(true)
    ctx.restore()
  }
  ctx.fillStyle = clip.color
  run(false)
  ctx.restore()
}

/** 字間を考慮した文字列の幅 (各文字の後ろに字間を足す。最後の文字の後ろは除く) */
function spacedWidth(ctx: Ctx2D, text: string, letterSpacing: number): number {
  const w = ctx.measureText(text).width
  return letterSpacing === 0 ? w : w + letterSpacing * Array.from(text).length
}

/** 左揃えで文字列を描く (字間があれば 1 文字ずつ) */
function drawSpaced(ctx: Ctx2D, text: string, x: number, y: number, letterSpacing: number, stroke: boolean) {
  if (letterSpacing === 0) {
    if (stroke) ctx.strokeText(text, x, y)
    else ctx.fillText(text, x, y)
    return
  }
  for (const ch of Array.from(text)) {
    if (stroke) ctx.strokeText(ch, x, y)
    else ctx.fillText(ch, x, y)
    x += ctx.measureText(ch).width + letterSpacing
  }
}

/**
 * 単語ハイライト字幕を描く。背景の箱 → 影 → ふち → 文字 の順に重ねる。
 * 座標系は drawText と同じ (1080p 基準に scale 済み、原点 = テキストの中心)。
 */
function drawKaraokeText(
  ctx: Ctx2D,
  clip: TextClip,
  k: Karaoke,
  localT: number,
  lineH: number,
  letterSpacing: number,
  unit: number
) {
  const lines = karaokeLines(clip, localT)
  const decor = clip.decor
  interface Placed {
    tok: KaraokeTokenState
    x: number
    y: number
    w: number
  }
  const popScale = (tok: KaraokeTokenState) =>
    k.mode === 'pop' && tok.current ? 1 + 0.18 * Math.min(1, tok.progress * 5) : 1
  const placed: Placed[] = []
  lines.forEach((toks, i) => {
    const y = (i - (lines.length - 1) / 2) * lineH
    const widths = toks.map(t => spacedWidth(ctx, t.text, letterSpacing))
    // pop で大きくする単語は、その分だけ前後に余白を取る (隣の単語・空白に重ならない)
    const extras = toks.map((t, j) => {
      const glyphW = spacedWidth(ctx, t.text.trimEnd(), letterSpacing)
      return widths[j] > 0 ? (popScale(t) - 1) * glyphW : 0
    })
    const total =
      widths.reduce((a, b) => a + b, 0) + extras.reduce((a, b) => a + b, 0) - (toks.length ? letterSpacing : 0)
    let x = clip.align === 'center' ? -total / 2 : clip.align === 'right' ? -total : 0
    toks.forEach((tok, j) => {
      placed.push({ tok, x: x + extras[j] / 2, y, w: widths[j] })
      x += widths[j] + extras[j]
    })
  })
  const visible = (p: Placed) => k.mode !== 'reveal' || p.tok.progress > 0
  const prevAlign = ctx.textAlign
  ctx.textAlign = 'left'

  // 今の単語だけ少し大きく (pop)。読み始めで素早く大きくなる
  const withToken = (p: Placed, draw: () => void) => {
    ctx.save()
    if (k.mode === 'pop' && p.tok.current) {
      const s = popScale(p.tok)
      // 空白を除いた文字部分の中心で拡大する
      const cx = p.x + spacedWidth(ctx, p.tok.text.trimEnd(), letterSpacing) / 2
      ctx.translate(cx, p.y)
      ctx.scale(s, s)
      ctx.translate(-cx, -p.y)
    }
    if (k.mode === 'reveal' && p.tok.progress < 1) {
      ctx.globalAlpha = ctx.globalAlpha * Math.max(0.2, Math.min(1, p.tok.progress * 3))
    }
    draw()
    ctx.restore()
  }

  // 背景の箱 (box): 今の単語の後ろ
  if (k.mode === 'box') {
    const cur = placed.find(p => p.tok.current)
    if (cur) {
      const padX = clip.fontSize * 0.18
      const h = clip.fontSize * 1.15
      ctx.save()
      ctx.fillStyle = k.boxColor ?? k.color
      ctx.beginPath()
      roundRect(ctx, cur.x - padX, cur.y - h / 2, cur.w - letterSpacing + padX * 2, h, clip.fontSize * 0.2)
      ctx.fill()
      ctx.restore()
    }
  }

  if (decor?.shadow) {
    ctx.save()
    ctx.shadowColor = decor.shadow.color
    ctx.shadowBlur = decor.shadow.blur * unit
    ctx.shadowOffsetX = decor.shadow.offsetX * unit
    ctx.shadowOffsetY = decor.shadow.offsetY * unit
    ctx.fillStyle = decor.shadow.color
    for (const p of placed) if (visible(p)) withToken(p, () => drawSpaced(ctx, p.tok.text, p.x, p.y, letterSpacing, false))
    ctx.restore()
  }
  if (decor?.outline && decor.outline.width > 0) {
    ctx.save()
    ctx.strokeStyle = decor.outline.color
    ctx.lineWidth = decor.outline.width
    ctx.lineJoin = 'round'
    for (const p of placed) if (visible(p)) withToken(p, () => drawSpaced(ctx, p.tok.text, p.x, p.y, letterSpacing, true))
    ctx.restore()
  }
  for (const p of placed) {
    if (!visible(p)) continue
    withToken(p, () => {
      const { tok } = p
      let color = clip.color
      if (k.mode === 'color' && tok.progress > 0) color = k.color
      if (k.mode === 'pop' && tok.current) color = k.color
      if (k.mode === 'fill' && tok.progress >= 1) color = k.color
      ctx.fillStyle = color
      drawSpaced(ctx, tok.text, p.x, p.y, letterSpacing, false)
      // fill: 読んでいる途中の単語は左から色を塗る
      if (k.mode === 'fill' && tok.progress > 0 && tok.progress < 1) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(p.x, p.y - lineH, p.w * tok.progress, lineH * 2)
        ctx.clip()
        ctx.fillStyle = k.color
        drawSpaced(ctx, tok.text, p.x, p.y, letterSpacing, false)
        ctx.restore()
      }
    })
  }
  ctx.textAlign = prevAlign
}

function drawTextLine(
  ctx: Ctx2D,
  clip: TextClip,
  text: string,
  y: number,
  progress: number,
  letterSpacing: number,
  strokeOnly: boolean,
  charOffset: number,
  totalChars: number
) {
  const type = clip.anim?.type ?? 'none'
  if (type === 'none' && letterSpacing === 0) {
    if (strokeOnly) ctx.strokeText(text, 0, y)
    else ctx.fillText(text, 0, y)
    return
  }

  // 1 文字ずつ描画 (位置計算は align に依存)
  const chars = Array.from(text)
  const widths = chars.map(ch => ctx.measureText(ch).width)
  const totalW = widths.reduce((a, b) => a + b, 0) + letterSpacing * Math.max(0, chars.length - 1)
  let x = 0
  if (clip.align === 'center') x = -totalW / 2
  else if (clip.align === 'right') x = -totalW
  const prevAlign = ctx.textAlign
  ctx.textAlign = 'left'

  for (let i = 0; i < chars.length; i++) {
    const idx = charOffset + i
    const cp = charProgress(type, progress, idx, totalChars)
    if (cp <= 0) {
      x += widths[i] + letterSpacing
      continue
    }
    ctx.save()
    ctx.translate(0, y)
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
        ctx.translate(0, Math.sin(progress * Math.PI * 2 + idx * 0.4) * 10)
        break
    }
    if (strokeOnly) ctx.strokeText(chars[i], x, 0)
    else ctx.fillText(chars[i], x, 0)
    ctx.restore()
    x += widths[i] + letterSpacing
  }
  ctx.textAlign = prevAlign
}

function charProgress(
  type: TextAnim['type'] | 'none',
  progress: number,
  idx: number,
  total: number
): number {
  if (type === 'typewriter') return progress >= (idx + 1) / total ? 1 : 0
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
  return 1
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
