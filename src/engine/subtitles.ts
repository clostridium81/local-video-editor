import type { Clip, TextClip } from '../types/project'

// ============================================================
// 字幕ファイル (SRT / WebVTT) の読み書き (DOM 非依存の純ロジック)
// ============================================================

export interface SubtitleCue {
  start: number // 秒
  end: number // 秒
  text: string // 改行は \n
}

// 00:01:02,345 / 00:01:02.345 / 01:02.345 (VTT は時が省略可能)
const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/
const CUE_TIME_RE = new RegExp(`${TIME_RE.source}\\s*-->\\s*${TIME_RE.source}`)

function toSec(h: string | undefined, m: string, s: string, ms: string): number {
  return (
    Number(h ?? 0) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(ms.padEnd(3, '0')) / 1000
  )
}

/**
 * SRT / WebVTT を解析する。番号行・VTT のヘッダ / NOTE / STYLE ブロック・
 * 位置指定・タグ (<i> など) は読み飛ばす。時刻行の無いブロックは無視する。
 */
export function parseSubtitles(input: string): SubtitleCue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const blocks = text.split(/\n{2,}/)
  const cues: SubtitleCue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '')
    const timeIdx = lines.findIndex(l => CUE_TIME_RE.test(l))
    if (timeIdx < 0) continue
    const m = lines[timeIdx].match(CUE_TIME_RE)!
    const start = toSec(m[1], m[2], m[3], m[4])
    const end = toSec(m[5], m[6], m[7], m[8])
    const body = lines
      .slice(timeIdx + 1)
      .map(l => stripTags(l).trim())
      .filter(Boolean)
      .join('\n')
    if (!body || !(end > start)) continue
    cues.push({ start, end, text: body })
  }
  return cues.sort((a, b) => a.start - b.start)
}

function stripTags(line: string): string {
  return line
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '') // ASS 風の {\an8} など
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

function fmtTime(sec: number, sep: ',' | '.'): string {
  const totalMs = Math.max(0, Math.round(sec * 1000))
  const ms = totalMs % 1000
  const totalS = Math.floor(totalMs / 1000)
  const s = totalS % 60
  const m = Math.floor(totalS / 60) % 60
  const h = Math.floor(totalS / 3600)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`
}

export function toSrt(cues: SubtitleCue[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${fmtTime(c.start, ',')} --> ${fmtTime(c.end, ',')}\n${c.text}`)
      .join('\n\n') + '\n'
  )
}

export function toVtt(cues: SubtitleCue[]): string {
  return (
    'WEBVTT\n\n' +
    cues
      .map(c => `${fmtTime(c.start, '.')} --> ${fmtTime(c.end, '.')}\n${c.text}`)
      .join('\n\n') +
    '\n'
  )
}

/**
 * テキストクリップを字幕に変換する。trackId を渡すとそのトラックだけ。
 * rangeStart を渡すと、その時刻を 0 秒とした時刻に直す (範囲書き出し用)。
 */
export function textClipsToCues(
  clips: Clip[],
  opts: { trackId?: string; rangeStart?: number; rangeEnd?: number } = {}
): SubtitleCue[] {
  const offset = opts.rangeStart ?? 0
  const rangeEnd = opts.rangeEnd ?? Infinity
  return clips
    .filter((c): c is TextClip => c.kind === 'text')
    .filter(c => !opts.trackId || c.trackId === opts.trackId)
    .filter(c => c.text.trim() !== '')
    .filter(c => c.start + c.duration > offset && c.start < rangeEnd)
    .map(c => ({
      start: Math.max(0, c.start - offset),
      end: Math.min(rangeEnd, c.start + c.duration) - offset,
      text: c.text.trim()
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
}
