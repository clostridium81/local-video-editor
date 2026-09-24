import type { Clip, Transition, TransitionType } from '../types/project'

// ============================================================
// トランジション計算
// ============================================================
// 入り (transitionIn): clip.start 〜 clip.start + in.duration で 0→1 に進行
// 出 (transitionOut): clip.start + clip.duration - out.duration 〜 終了 で 1→0
// 隣接クリップが同じトラックで境界を共有している場合、自動クロスフェード
// (各クリップの in/out fade を設定しなくても境界で 0.5s 程度ブレンド)
// → 今回は明示的な transitionIn/Out のみサポート (自動クロスは将来)
// ============================================================

/**
 * 表示領域の制限 (キャンバス座標を 0..1 に正規化)。
 * rect: 矩形の内側だけ描く / circle: キャンバス中心からの円の内側だけ描く
 * (r=1 で画面の対角をすべて覆う)
 */
export type TransitionReveal =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'circle'; r: number }

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
  /** 追加のぼかし (px, 1080p 基準) */
  blur: number
  /** 明るさ係数 (1=変化なし) */
  brightness: number
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
    blur: 0,
    brightness: 1,
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
  }
}

export function sampleTransition(clip: Clip, t: number): TransitionSample {
  const s = baseSample()
  const localT = t - clip.start
  const inTr = clip.transitionIn
  const outTr = clip.transitionOut
  if (inTr && inTr.duration > 0 && localT < inTr.duration) {
    const p = Math.max(0, Math.min(1, localT / inTr.duration))
    applyTransition(s, inTr.type, p, 1)
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
