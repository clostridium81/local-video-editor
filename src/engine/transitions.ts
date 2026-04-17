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

export interface TransitionSample {
  /** 不透明度係数 (0..1) */
  alpha: number
  /** x 方向のオフセット (0..1 の正規化, キャンバス幅基準) */
  offsetX: number
  /** y 方向のオフセット (0..1 の正規化, キャンバス高さ基準) */
  offsetY: number
  /** スケール係数 (1=変化なし) */
  scale: number
  /** 音量係数 (0..1) */
  volume: number
  /** wipe 用プログレス (0..1) */
  wipeProgress: number
  /** wipe 時のみ true */
  isWipe: boolean
}

const NEUTRAL: TransitionSample = {
  alpha: 1,
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  volume: 1,
  wipeProgress: 1,
  isWipe: false
}

function baseSample(): TransitionSample {
  return { ...NEUTRAL }
}

function applyTransition(
  s: TransitionSample,
  type: TransitionType,
  /** 0 = 始まり, 1 = 全開 */
  progress: number
) {
  const p = Math.max(0, Math.min(1, progress))
  switch (type) {
    case 'fade':
      s.alpha *= p
      s.volume *= p
      break
    case 'slide-left':
      // 入り: 画面右外→定位置、出: 定位置→左外
      s.offsetX += 1 - p // in: 0..1 → 1..0 なので 1-p で右からスライド
      break
    case 'slide-right':
      s.offsetX -= 1 - p
      break
    case 'slide-up':
      s.offsetY += 1 - p
      break
    case 'slide-down':
      s.offsetY -= 1 - p
      break
    case 'zoom':
      s.scale *= p
      s.alpha *= p
      break
    case 'wipe':
      s.wipeProgress = p
      s.isWipe = true
      break
  }
}

/**
 * 出側のスライド方向は in の反対側へ抜ける。
 * 入 slide-left: 右から入る (offset +1 → 0)
 * 出 slide-left: 左へ抜ける (offset 0 → -1)
 */
function applyOutTransition(
  s: TransitionSample,
  type: TransitionType,
  /** 1 = 定位置(開始時), 0 = 消失 */
  progress: number
) {
  const p = Math.max(0, Math.min(1, progress))
  switch (type) {
    case 'fade':
      s.alpha *= p
      s.volume *= p
      break
    case 'slide-left':
      s.offsetX -= 1 - p
      break
    case 'slide-right':
      s.offsetX += 1 - p
      break
    case 'slide-up':
      s.offsetY -= 1 - p
      break
    case 'slide-down':
      s.offsetY += 1 - p
      break
    case 'zoom':
      s.scale *= p
      s.alpha *= p
      break
    case 'wipe':
      s.wipeProgress = p
      s.isWipe = true
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
    applyTransition(s, inTr.type, p)
  }
  if (outTr && outTr.duration > 0) {
    const outStart = clip.duration - outTr.duration
    if (localT >= outStart) {
      const p = Math.max(0, Math.min(1, (clip.duration - localT) / outTr.duration))
      applyOutTransition(s, outTr.type, p)
    }
  }
  return s
}

export function isValidTransition(tr: Transition | undefined): tr is Transition {
  return !!tr && tr.duration > 0
}
