import type { Clip, Transition, TransitionType } from '../types/project'

// ============================================================
// トランジション計算
// ============================================================
// 入り (transitionIn): clip.start 〜 clip.start + in.duration で 0→1 に進行
// 出 (transitionOut): clip.start + clip.duration - out.duration 〜 終了 で 1→0
// transitionIn.overlap = true の場合、入りは開始位置の duration 秒前に始まり
// 開始位置で完了する。同じトラックでは開始が遅いクリップが手前に描かれるので、
// 前のクリップの末尾に重なる「クロストランジション」になる。
// ============================================================

/**
 * 表示領域の制限。
 * rect / rects: キャンバス座標を 0..1 に正規化した矩形 (rects は複数の和)
 * npoly: キャンバス座標を 0..1 に正規化した多角形
 * circle / poly: キャンバス中心基準で、単位は画面の対角の半分
 *   (r=1 の円で画面をすべて覆う)。縦横比に関係なく形が崩れない
 * sector: 中心から 12 時方向を起点に時計回りに sweep (ラジアン) 分の扇形
 */
export interface RevealRect {
  x0: number
  y0: number
  x1: number
  y1: number
}
export type TransitionReveal =
  | ({ kind: 'rect' } & RevealRect)
  | { kind: 'rects'; rects: RevealRect[] }
  | { kind: 'circle'; r: number }
  | { kind: 'poly'; points: Array<[number, number]> }
  | { kind: 'npoly'; points: Array<[number, number]> }
  | { kind: 'sector'; sweep: number }

export interface TransitionSample {
  /** 不透明度係数 (0..1) */
  alpha: number
  /** x 方向のオフセット (0..1 の正規化, キャンバス幅基準) */
  offsetX: number
  /** y 方向のオフセット (0..1 の正規化, キャンバス高さ基準) */
  offsetY: number
  /** スケール係数 (1=変化なし) */
  scale: number
  /** 追加の回転 (度) */
  rotation: number
  /** 横 / 縦だけの伸縮 (裏返り用, 1=変化なし) */
  scaleX: number
  scaleY: number
  /** 追加のぼかし (px, 1080p 基準) */
  blur: number
  /** 明るさ係数 (1=変化なし) */
  brightness: number
  /** モザイクの粗さ (px, 1080p 基準, 0=なし)。画像/映像クリップのみ */
  pixelate: number
  /** 音量係数 (0..1) */
  volume: number
  /** 表示領域の制限 (null = 制限なし) */
  reveal: TransitionReveal | null
}

function baseSample(): TransitionSample {
  return {
    alpha: 1,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    blur: 0,
    brightness: 1,
    pixelate: 0,
    volume: 1,
    reveal: null
  }
}

/**
 * 入り・出の共通処理。
 * p: 0 = 消えている, 1 = 定位置 (入りは 0→1、出は 1→0 に進む)
 * dir: 入り = 1, 出 = -1。スライド/回転は出で反対側へ抜ける。
 *   入 slide-left: 右から入る (offset +1 → 0)
 *   出 slide-left: 左へ抜ける (offset 0 → -1)
 */
function applyTransition(
  s: TransitionSample,
  type: TransitionType,
  progress: number,
  dir: 1 | -1
) {
  const p = Math.max(0, Math.min(1, progress))
  const q = 1 - p
  switch (type) {
    case 'fade':
      s.alpha *= p
      s.volume *= p
      break
    case 'slide-left':
      s.offsetX += q * dir
      break
    case 'slide-right':
      s.offsetX -= q * dir
      break
    case 'slide-up':
      s.offsetY += q * dir
      break
    case 'slide-down':
      s.offsetY -= q * dir
      break
    case 'zoom':
      s.scale *= p
      s.alpha *= p
      break
    case 'zoom-out':
      s.scale *= 1 + q * 0.6
      s.alpha *= p
      break
    case 'spin':
      s.rotation += q * 180 * dir
      s.scale *= 0.3 + 0.7 * p
      s.alpha *= p
      break
    case 'blur':
      s.blur += q * 30
      s.alpha *= p
      break
    case 'flash':
      s.brightness *= 1 + q * 4
      break
    case 'wipe':
      s.reveal = { kind: 'rect', x0: 0, y0: 0, x1: p, y1: 1 }
      break
    case 'wipe-rtl':
      s.reveal = { kind: 'rect', x0: q, y0: 0, x1: 1, y1: 1 }
      break
    case 'wipe-up':
      s.reveal = { kind: 'rect', x0: 0, y0: q, x1: 1, y1: 1 }
      break
    case 'wipe-down':
      s.reveal = { kind: 'rect', x0: 0, y0: 0, x1: 1, y1: p }
      break
    case 'split':
      s.reveal = { kind: 'rect', x0: 0.5 - p / 2, y0: 0, x1: 0.5 + p / 2, y1: 1 }
      break
    case 'iris':
      s.reveal = { kind: 'circle', r: p }
      break
    case 'wipe-diag': {
      // 左上の角から右下へ斜めの境界線を進める (x + y ≤ 2p)
      const d = p * 2
      s.reveal = {
        kind: 'npoly',
        points: [
          [0, 0],
          [Math.min(1, d), 0],
          [Math.min(1, d), Math.max(0, d - 1)],
          [Math.max(0, d - 1), Math.min(1, d)],
          [0, Math.min(1, d)]
        ]
      }
      break
    }
    case 'split-v':
      s.reveal = { kind: 'rect', x0: 0, y0: 0.5 - p / 2, x1: 1, y1: 0.5 + p / 2 }
      break
    case 'clock':
      s.reveal = { kind: 'sector', sweep: p * Math.PI * 2 }
      break
    case 'diamond': {
      // |x| + |y| ≤ r (中心基準)。r = √2 で画面の四隅まで覆う
      const r = p * Math.SQRT2
      s.reveal = { kind: 'poly', points: [[0, -r], [r, 0], [0, r], [-r, 0]] }
      break
    }
    case 'heart':
      s.reveal = { kind: 'poly', points: heartPoints(p * 2.2) }
      break
    case 'blinds': {
      const n = 8
      const rects: RevealRect[] = []
      for (let i = 0; i < n; i++) rects.push({ x0: 0, y0: i / n, x1: 1, y1: (i + p) / n })
      s.reveal = { kind: 'rects', rects }
      break
    }
    case 'checker': {
      // 市松模様: 前半で半分のマス、後半で残りのマスが左から埋まる
      const cols = 8
      const rows = 5
      const rects: RevealRect[] = []
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const phase = (i + j) % 2 === 0 ? p * 2 : p * 2 - 1
          const f = Math.max(0, Math.min(1, phase))
          if (f <= 0) continue
          rects.push({ x0: i / cols, y0: j / rows, x1: (i + f) / cols, y1: (j + 1) / rows })
        }
      }
      s.reveal = { kind: 'rects', rects }
      break
    }
    case 'flip-x':
      s.scaleX *= easeOutCubic(p)
      break
    case 'flip-y':
      s.scaleY *= easeOutCubic(p)
      break
    case 'bounce':
      s.scale *= easeOutBack(p)
      s.alpha *= Math.min(1, p * 3)
      break
    case 'shake': {
      const amp = q * q * 0.06
      s.offsetX += Math.sin(p * 40) * amp
      s.offsetY += Math.cos(p * 33) * amp * 0.6
      s.rotation += Math.sin(p * 27) * q * 4
      break
    }
    case 'glitch': {
      // 横帯が順に現れ、段階ごとに乱数で位置がずれる
      const step = Math.floor(p * 12)
      const rnd = (k: number) => hash01(step * 7.13 + k)
      s.offsetX += (rnd(1) - 0.5) * 0.08 * q
      s.brightness *= 1 + rnd(2) * 0.6 * q
      if (p < 1) {
        const bands = 10
        const rects: RevealRect[] = []
        for (let i = 0; i < bands; i++) {
          // 帯ごとの出現タイミングは固定 (進むほど本数が増える)。ずれ幅だけ段階ごとに変える
          if (hash01(i * 3.71 + 0.5) < p * 1.2) {
            const shift = (rnd(30 + i) - 0.5) * 0.1 * q
            rects.push({ x0: shift, y0: i / bands, x1: 1 + shift, y1: (i + 1) / bands })
          }
        }
        s.reveal = { kind: 'rects', rects }
      }
      break
    }
    case 'pixelate':
      s.pixelate = Math.max(s.pixelate, q * q * 80)
      s.alpha *= Math.min(1, p * 4)
      break
    case 'zoom-blur':
      s.scale *= 1 + q * 0.35
      s.blur += q * 18
      s.alpha *= p
      break
  }
}

export function sampleTransition(clip: Clip, t: number): TransitionSample {
  const s = baseSample()
  const localT = t - clip.start
  const inTr = clip.transitionIn
  const outTr = clip.transitionOut
  if (inTr && inTr.duration > 0) {
    // 重ねる場合は開始位置の duration 秒前から始まり、開始位置で完了する
    const inStart = inTr.overlap ? -inTr.duration : 0
    if (localT < inStart + inTr.duration) {
      const p = Math.max(0, Math.min(1, (localT - inStart) / inTr.duration))
      applyTransition(s, inTr.type, p, 1)
    }
  }
  if (outTr && outTr.duration > 0) {
    const outStart = clip.duration - outTr.duration
    if (localT >= outStart) {
      const p = Math.max(0, Math.min(1, (clip.duration - localT) / outTr.duration))
      applyTransition(s, outTr.type, p, -1)
    }
  }
  return s
}

// ---------- 形状・補間ヘルパー ----------

function heartPoints(size: number): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  const n = 48
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const x = 16 * Math.pow(Math.sin(a), 3)
    const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)
    // y は上が正なので反転。高さ ≒ 30 単位 → size で正規化
    pts.push([(x / 17) * size, (-(y + 2) / 17) * size])
  }
  return pts
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3)
}

function easeOutBack(t: number) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

/** 決定的な疑似乱数 (0..1)。同じ入力には常に同じ値 (プレビューと書き出しで一致) */
function hash01(x: number): number {
  const s = Math.sin(x * 12.9898) * 43758.5453
  return s - Math.floor(s)
}

export function isValidTransition(tr: Transition | undefined): tr is Transition {
  return !!tr && tr.duration > 0
}

/**
 * 音量フェード (clip.audioFade) の係数 (0..1)。localT はクリップ先頭からの秒。
 * 映像トランジションの fade とは独立に掛け合わせる。
 */
export function sampleAudioFade(clip: Clip, localT: number): number {
  const f = clip.audioFade
  if (!f) return 1
  let g = 1
  if (f.in > 0 && localT < f.in) g *= Math.max(0, localT / f.in)
  if (f.out > 0) {
    const remain = clip.duration - localT
    if (remain < f.out) g *= Math.max(0, remain / f.out)
  }
  return Math.max(0, Math.min(1, g))
}
