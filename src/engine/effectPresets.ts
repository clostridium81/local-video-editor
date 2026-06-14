import type { ClipEffects, ColorGrade, PixelEffects } from '../types/project'

// ============================================================
// エフェクトプリセット (ワンタッチで複数のエフェクトを適用)
// ============================================================
// effects (CSS filter) / colorGrade (ピクセル) / pixelFx (ピクセル) を
// まとめて定義する。適用時は対象クリップの 3 つを丸ごと置き換える
// (= 一度リセットしてから適用)。
// ============================================================

export interface EffectPreset {
  id: string
  labelEasy: string
  labelNormal: string
  effects?: ClipEffects
  colorGrade?: ColorGrade
  pixelFx?: PixelEffects
}

export const EFFECT_PRESETS: EffectPreset[] = [
  { id: 'none', labelEasy: 'なし', labelNormal: 'なし' },
  {
    id: 'cinematic',
    labelEasy: 'えいが ふう',
    labelNormal: 'シネマティック',
    effects: { contrast: 1.1, saturation: 0.9 },
    colorGrade: {
      temperature: 0.15,
      lift: { r: 0, g: 0, b: 0.03 },
      gain: { r: 0.03, g: 0, b: -0.02 }
    },
    pixelFx: { vignette: 0.4 }
  },
  {
    id: 'vintage',
    labelEasy: 'むかし ふう',
    labelNormal: 'ヴィンテージ',
    effects: { sepia: 0.4, contrast: 0.95, saturation: 0.85 },
    pixelFx: { grain: 0.25, vignette: 0.5 }
  },
  {
    id: 'mono',
    labelEasy: 'しろくろ',
    labelNormal: 'モノクロ',
    effects: { grayscale: 1, contrast: 1.15 }
  },
  {
    id: 'vivid',
    labelEasy: 'あざやか',
    labelNormal: 'ビビッド',
    effects: { contrast: 1.1, saturation: 1.1 },
    pixelFx: { vibrance: 0.5 }
  },
  {
    id: 'cold',
    labelEasy: 'つめたい いろ',
    labelNormal: 'クール',
    colorGrade: { temperature: -0.3, tint: -0.05 }
  },
  {
    id: 'warm',
    labelEasy: 'あたたかい いろ',
    labelNormal: 'ウォーム',
    colorGrade: { temperature: 0.35, tint: 0.05 }
  },
  {
    id: 'retro8',
    labelEasy: 'ゲーム ふう',
    labelNormal: 'レトロ 8bit',
    pixelFx: { pixelate: 6, posterize: 5 }
  },
  {
    id: 'comic',
    labelEasy: 'まんが ふう',
    labelNormal: 'コミック',
    effects: { contrast: 1.2, saturation: 1.2 },
    pixelFx: { posterize: 6, sharpen: 0.6 }
  },
  {
    id: 'noir',
    labelEasy: 'くらい えいが',
    labelNormal: 'フィルムノワール',
    effects: { grayscale: 1, contrast: 1.3 },
    pixelFx: { vignette: 0.6, grain: 0.2 }
  },
  {
    id: 'dream',
    labelEasy: 'ゆめ ふう',
    labelNormal: 'ドリーミー',
    effects: { brightness: 1.1, contrast: 0.92, saturation: 1.05, blur: 1.5 },
    pixelFx: { vignette: 0.25 }
  },
  {
    id: 'crt',
    labelEasy: 'ブラウンかん',
    labelNormal: 'CRT モニタ',
    pixelFx: { scanlines: 0.5, chromaticAberration: 2, vignette: 0.4 }
  },
  {
    id: 'duotone',
    labelEasy: 'ふたいろ',
    labelNormal: 'デュオトーン',
    pixelFx: {
      duotone: { enabled: true, shadow: '#1a1a4a', highlight: '#ffd98a' }
    }
  }
]

export function getPreset(id: string): EffectPreset | undefined {
  return EFFECT_PRESETS.find(p => p.id === id)
}
