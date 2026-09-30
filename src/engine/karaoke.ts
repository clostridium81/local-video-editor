import type { Karaoke, TextClip } from '../types/project'

// ============================================================
// 単語ハイライト字幕 (カラオケ風) の区切りと進み具合 (DOM 非依存)
// ============================================================
// 文章を単語に区切り (日本語は Intl.Segmenter の単語単位、無ければ 1 文字ずつ)、
// 文字数に比例した時間で順に「読んでいる」状態にする。
// 句読点・空白は時間を持たず、直前の単語と一緒に扱う。
// ============================================================

export interface KaraokeToken {
  text: string
  /** 読み上げの重み (文字数。句読点・空白は 0) */
  weight: number
}

export interface KaraokeTokenState extends KaraokeToken {
  /** 0 = まだ, 0..1 = 読んでいる途中, 1 = 読み終わり */
  progress: number
  /** 今読んでいる単語か */
  current: boolean
}

let segmenter: any | null | undefined

function getSegmenter(): any | null {
  if (segmenter === undefined) {
    const Seg = (Intl as any).Segmenter
    segmenter = typeof Seg === 'function' ? new Seg('ja', { granularity: 'word' }) : null
  }
  return segmenter
}

const SILENT = /^[\s\p{P}\p{S}]+$/u

/** 1 行を単語に区切る */
export function tokenizeLine(line: string): KaraokeToken[] {
  const seg = getSegmenter()
  const parts: string[] = seg
    ? Array.from(seg.segment(line), (s: any) => s.segment as string)
    : Array.from(line)
  const tokens: KaraokeToken[] = []
  for (const text of parts) {
    const silent = SILENT.test(text)
    const weight = silent ? 0 : Array.from(text).length
    // 句読点・空白は直前の単語にくっつける (単独で光らせない)
    if (silent && tokens.length > 0) {
      tokens[tokens.length - 1].text += text
      continue
    }
    tokens.push({ text, weight })
  }
  return tokens
}

/** 進み具合 (0..1)。lead 秒後に始まり、終わりの tail 秒前に 1 になる */
export function karaokeProgress(k: Karaoke, duration: number, localT: number): number {
  const start = Math.max(0, k.lead)
  const end = Math.max(start + 0.01, duration - Math.max(0, k.tail))
  return Math.max(0, Math.min(1, (localT - start) / (end - start)))
}

/**
 * 各行の単語と、その時点での状態を返す (行をまたいで時間を割り振る)。
 */
export function karaokeLines(clip: Pick<TextClip, 'text' | 'duration' | 'karaoke'>, localT: number): KaraokeTokenState[][] {
  const k = clip.karaoke
  const lines = clip.text.split(/\r?\n/).map(tokenizeLine)
  const total = lines.reduce((n, l) => n + l.reduce((m, t) => m + t.weight, 0), 0)
  const p = k ? karaokeProgress(k, clip.duration, localT) : 1
  const spoken = p * total
  let acc = 0
  let currentFound = false
  return lines.map(line =>
    line.map(tok => {
      const start = acc
      acc += tok.weight
      let progress: number
      if (tok.weight === 0) progress = spoken >= start ? 1 : 0
      else progress = Math.max(0, Math.min(1, (spoken - start) / tok.weight))
      // 「今読んでいる単語」はちょうど 1 つ (読み終わった直後は次の単語へ)
      const current = !currentFound && p < 1 && tok.weight > 0 && spoken >= start && spoken < acc
      if (current) currentFound = true
      return { ...tok, progress, current }
    })
  )
}
