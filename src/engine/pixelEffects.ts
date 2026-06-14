import type { Duotone, PixelEffects } from '../types/project'

// ============================================================
// ピクセルエフェクト (Canvas ImageData 処理)
// ============================================================
// previewEngine / exportEngine の両方から共有される。
// data は Uint8ClampedArray なので、代入時に自動で 0..255 にクランプ&丸めされる。
// ============================================================

export function hasPixelEffects(fx: PixelEffects | undefined): fx is PixelEffects {
  if (!fx) return false
  return (
    (fx.vignette ?? 0) > 0 ||
    (fx.sharpen ?? 0) > 0 ||
    (fx.grain ?? 0) > 0 ||
    (fx.pixelate ?? 0) > 1 ||
    (fx.posterize ?? 0) >= 2 ||
    (fx.scanlines ?? 0) > 0 ||
    (fx.chromaticAberration ?? 0) > 0 ||
    (fx.threshold ?? 0) > 0 ||
    (fx.vibrance ?? 0) !== 0 ||
    !!fx.duotone?.enabled
  )
}

/**
 * 全ピクセルエフェクトを順に適用する。
 * 適用順は「構造 (pixelate) → 色調 (posterize/threshold/vibrance/duotone)
 *  → 質感 (sharpen/CA/grain/scanlines) → 周辺減光 (vignette)」。
 */
export function applyPixelEffects(img: ImageData, fx: PixelEffects) {
  const d = img.data
  const w = img.width
  const h = img.height
  if ((fx.pixelate ?? 0) > 1) pixelate(d, w, h, fx.pixelate as number)
  if ((fx.posterize ?? 0) >= 2) posterize(d, fx.posterize as number)
  if ((fx.threshold ?? 0) > 0) threshold(d, fx.threshold as number)
  if ((fx.vibrance ?? 0) !== 0) vibrance(d, fx.vibrance as number)
  if (fx.duotone?.enabled) duotone(d, fx.duotone)
  if ((fx.sharpen ?? 0) > 0) sharpen(d, w, h, fx.sharpen as number)
  if ((fx.chromaticAberration ?? 0) > 0)
    chromaticAberration(d, w, h, fx.chromaticAberration as number)
  if ((fx.grain ?? 0) > 0) grain(d, fx.grain as number)
  if ((fx.scanlines ?? 0) > 0) scanlines(d, w, h, fx.scanlines as number)
  if ((fx.vignette ?? 0) > 0) vignette(d, w, h, fx.vignette as number)
}

// ---------- 個別エフェクト ----------

type Data = Uint8ClampedArray

function pixelate(d: Data, w: number, h: number, block: number) {
  const b = Math.max(2, Math.round(block))
  for (let by = 0; by < h; by += b) {
    for (let bx = 0; bx < w; bx += b) {
      let r = 0, g = 0, bl = 0, a = 0, n = 0
      const ex = Math.min(bx + b, w)
      const ey = Math.min(by + b, h)
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * w + x) * 4
          r += d[i]; g += d[i + 1]; bl += d[i + 2]; a += d[i + 3]; n++
        }
      }
      r /= n; g /= n; bl /= n; a /= n
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * w + x) * 4
          d[i] = r; d[i + 1] = g; d[i + 2] = bl; d[i + 3] = a
        }
      }
    }
  }
}

function posterize(d: Data, levels: number) {
  const lv = Math.max(2, Math.min(255, Math.round(levels)))
  const step = 255 / (lv - 1)
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.round(d[i] / step) * step
    d[i + 1] = Math.round(d[i + 1] / step) * step
    d[i + 2] = Math.round(d[i + 2] / step) * step
  }
}

function threshold(d: Data, t: number) {
  const thr = t * 255
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const v = lum >= thr ? 255 : 0
    d[i] = v; d[i + 1] = v; d[i + 2] = v
  }
}

function vibrance(d: Data, amount: number) {
  // 低彩度のピクセルほど強く彩度を上げる (肌色などの過飽和を抑えた自然な彩度)
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2]
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const sat = (mx - mn) / 255
    const factor = 1 + amount * (1 - sat)
    const gray = (r + g + b) / 3
    d[i] = gray + (r - gray) * factor
    d[i + 1] = gray + (g - gray) * factor
    d[i + 2] = gray + (b - gray) * factor
  }
}

function duotone(d: Data, dt: Duotone) {
  const sh = hexToRgb(dt.shadow)
  const hi = hexToRgb(dt.highlight)
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255
    d[i] = sh.r + (hi.r - sh.r) * lum
    d[i + 1] = sh.g + (hi.g - sh.g) * lum
    d[i + 2] = sh.b + (hi.b - sh.b) * lum
  }
}

function sharpen(d: Data, w: number, h: number, amount: number) {
  // ラプラシアンを足し込むアンシャープ。境界は元のまま。
  const src = new Uint8ClampedArray(d)
  const k = amount
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const center = src[i + c]
        const lap =
          center * 4 -
          src[i - 4 + c] -
          src[i + 4 + c] -
          src[i - w * 4 + c] -
          src[i + w * 4 + c]
        d[i + c] = center + lap * k
      }
    }
  }
}

function chromaticAberration(d: Data, w: number, h: number, shift: number) {
  const src = new Uint8ClampedArray(d)
  const s = Math.round(shift)
  if (s === 0) return
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const xr = Math.min(w - 1, Math.max(0, x + s))
      const xb = Math.min(w - 1, Math.max(0, x - s))
      d[i] = src[(y * w + xr) * 4] // R を右へ
      d[i + 2] = src[(y * w + xb) * 4 + 2] // B を左へ (G は不動)
    }
  }
}

function grain(d: Data, amount: number) {
  const amt = amount * 100
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amt
    d[i] += n; d[i + 1] += n; d[i + 2] += n
  }
}

function scanlines(d: Data, w: number, h: number, amount: number) {
  const dark = 1 - amount * 0.7
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      d[i] *= dark; d[i + 1] *= dark; d[i + 2] *= dark
    }
  }
}

function vignette(d: Data, w: number, h: number, amount: number) {
  const cx = w / 2
  const cy = h / 2
  const maxD = Math.hypot(cx, cy)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.hypot(x - cx, y - cy) / maxD
      const factor = 1 - amount * dist * dist
      const i = (y * w + x) * 4
      d[i] *= factor; d[i + 1] *= factor; d[i + 2] *= factor
    }
  }
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0
  }
}
