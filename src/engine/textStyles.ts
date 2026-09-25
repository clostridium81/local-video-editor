import type { TextAnim, TextClip, TextDecor } from '../types/project'

// ============================================================
// テキストのスタイル集 (ワンクリックで見た目をまとめて設定)
// ============================================================
// 適用すると書体・大きさ・色・背景・太字/斜体・装飾を置き換える。
// 位置と文字の内容は変えない。anim を持つプリセットだけアニメも設定する。

export interface TextStylePreset {
  id: string
  labelEasy: string
  labelNormal: string
  style: {
    fontFamily: string
    fontSize: number
    color: string
    backgroundColor?: string
    bold: boolean
    italic: boolean
    decor?: TextDecor
    anim?: TextAnim
  }
}

export const TEXT_STYLE_PRESETS: TextStylePreset[] = [
  {
    id: 'subtitle',
    labelEasy: '字幕 (白・黒ふち)',
    labelNormal: '字幕 (白)',
    style: {
      fontFamily: "'Noto Sans JP'", fontSize: 56, color: '#ffffff', bold: true, italic: false,
      decor: { outline: { color: '#000000', width: 8 } }
    }
  },
  {
    id: 'subtitle-yellow',
    labelEasy: '字幕 (黄色)',
    labelNormal: '字幕 (黄)',
    style: {
      fontFamily: "'Noto Sans JP'", fontSize: 56, color: '#ffe14d', bold: true, italic: false,
      decor: { outline: { color: '#000000', width: 8 } }
    }
  },
  {
    id: 'subtitle-band',
    labelEasy: '字幕 (黒い帯)',
    labelNormal: '字幕 (帯)',
    style: {
      fontFamily: "'Noto Sans JP'", fontSize: 50, color: '#ffffff', backgroundColor: '#000000b3',
      bold: false, italic: false, decor: { lineHeight: 1.5 }
    }
  },
  {
    id: 'headline',
    labelEasy: '見出し',
    labelNormal: '見出し',
    style: {
      fontFamily: "'Noto Sans JP'", fontSize: 110, color: '#ffffff', bold: true, italic: false,
      decor: { shadow: { color: '#000000b0', blur: 18, offsetX: 0, offsetY: 6 }, letterSpacing: 4 }
    }
  },
  {
    id: 'neon-pink',
    labelEasy: 'ネオン (ピンク)',
    labelNormal: 'ネオン (ピンク)',
    style: {
      fontFamily: "'IBM Plex Sans'", fontSize: 92, color: '#fff4fd', bold: true, italic: false,
      decor: {
        outline: { color: '#ff3fd4', width: 3 },
        shadow: { color: '#ff3fd4', blur: 32, offsetX: 0, offsetY: 0 },
        letterSpacing: 3
      }
    }
  },
  {
    id: 'neon-blue',
    labelEasy: 'ネオン (青)',
    labelNormal: 'ネオン (青)',
    style: {
      fontFamily: "'IBM Plex Sans'", fontSize: 92, color: '#f0fdff', bold: true, italic: false,
      decor: {
        outline: { color: '#27d7ff', width: 3 },
        shadow: { color: '#27d7ff', blur: 32, offsetX: 0, offsetY: 0 },
        letterSpacing: 3
      }
    }
  },
  {
    id: 'pop',
    labelEasy: 'ポップ (はずむ)',
    labelNormal: 'ポップ',
    style: {
      fontFamily: "'Noto Sans JP'", fontSize: 100, color: '#ffe14d', bold: true, italic: false,
      decor: { outline: { color: '#1a1a1a', width: 14 }, shadow: { color: '#1a1a1a', blur: 0, offsetX: 0, offsetY: 8 } },
      anim: { type: 'scale-pop', duration: 0.6 }
    }
  },
  {
    id: 'variety',
    labelEasy: 'バラエティ',
    labelNormal: 'バラエティ',
    style: {
      fontFamily: "'Noto Sans JP'", fontSize: 96, color: '#ffffff', bold: true, italic: false,
      decor: { outline: { color: '#e8322d', width: 14 }, shadow: { color: '#000000', blur: 0, offsetX: 6, offsetY: 6 } }
    }
  },
  {
    id: 'cinema',
    labelEasy: '映画 (上品)',
    labelNormal: 'シネマ',
    style: {
      fontFamily: "'Instrument Serif'", fontSize: 72, color: '#f5f1e8', bold: false, italic: false,
      decor: { letterSpacing: 10, shadow: { color: '#00000099', blur: 12, offsetX: 0, offsetY: 2 } }
    }
  },
  {
    id: 'typewriter',
    labelEasy: 'タイプライター',
    labelNormal: 'タイプライター',
    style: {
      fontFamily: "'IBM Plex Mono'", fontSize: 54, color: '#f5f0e0', backgroundColor: '#1a1a1a',
      bold: false, italic: false, decor: { lineHeight: 1.5 },
      anim: { type: 'typewriter', duration: 1.5 }
    }
  },
  {
    id: 'retro',
    labelEasy: 'レトロ',
    labelNormal: 'レトロ',
    style: {
      fontFamily: "'Noto Serif JP'", fontSize: 84, color: '#f4d58d', bold: true, italic: false,
      decor: { outline: { color: '#7a3e1d', width: 6 }, shadow: { color: '#3a1e0e', blur: 0, offsetX: 5, offsetY: 5 } }
    }
  },
  {
    id: 'label',
    labelEasy: 'ラベル (白地)',
    labelNormal: 'ラベル',
    style: {
      fontFamily: "'Noto Sans JP'", fontSize: 54, color: '#111111', backgroundColor: '#ffffff',
      bold: true, italic: false, decor: { lineHeight: 1.6 }
    }
  },
  {
    id: 'minimal',
    labelEasy: 'シンプル',
    labelNormal: 'ミニマル',
    style: {
      fontFamily: "'IBM Plex Sans'", fontSize: 60, color: '#ffffff', bold: false, italic: false,
      decor: { letterSpacing: 2 }
    }
  }
]

export function getTextStyle(id: string): TextStylePreset | undefined {
  return TEXT_STYLE_PRESETS.find(p => p.id === id)
}

/** プリセットを TextClip に当てるための差分 (位置・内容は含まない) */
export function textStylePatch(preset: TextStylePreset): Partial<TextClip> {
  const s = preset.style
  const patch: Partial<TextClip> = {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    color: s.color,
    backgroundColor: s.backgroundColor,
    bold: s.bold,
    italic: s.italic,
    decor: s.decor ? JSON.parse(JSON.stringify(s.decor)) : undefined
  }
  if (s.anim) patch.anim = { ...s.anim }
  return patch
}

/** スタイル見本ボタン用の CSS (Canvas 描画の近似) */
export function textStylePreviewCss(preset: TextStylePreset): Record<string, string> {
  const s = preset.style
  const css: Record<string, string> = {
    fontFamily: s.fontFamily,
    color: s.color,
    fontWeight: s.bold ? '700' : '400',
    fontStyle: s.italic ? 'italic' : 'normal'
  }
  if (s.backgroundColor) css.background = s.backgroundColor
  const shadows: string[] = []
  const d = s.decor
  if (d?.outline && d.outline.width > 0) {
    // 見本は小さいので線幅は控えめにする
    const w = Math.max(1, Math.min(2, d.outline.width / 5))
    css.webkitTextStroke = `${w}px ${d.outline.color}`
    css.paintOrder = 'stroke fill'
  }
  if (d?.shadow) {
    shadows.push(`${d.shadow.offsetX / 4}px ${d.shadow.offsetY / 4}px ${d.shadow.blur / 3}px ${d.shadow.color}`)
  }
  if (shadows.length) css.textShadow = shadows.join(', ')
  if (d?.letterSpacing) css.letterSpacing = `${d.letterSpacing / 6}px`
  return css
}
