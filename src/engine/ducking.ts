import type { Clip, ProjectState } from '../types/project'
import { mapClipTimeToSource } from './frameTiming'
import { loadAssetBlob } from '../persistence/assetStore'
import { decodeForAnalysis, TooLargeForAnalysisError } from './audioDecode'

// ============================================================
// ダッキング (他の音が鳴っている間だけ BGM を自動で下げる)
// ============================================================
// 1. 素材ごとに音量 (RMS, dB) を DUCK_RATE 回/秒で求める
// 2. ダッキング対象でない音 (話し声・動画の音など) がタイムライン上で
//    鳴っている度合い (0..1) を並べ、アタック/リリースで滑らかにする
// 3. ダッキング対象クリップの音量に 1 - amount × 度合い を掛ける
// プレビュー・書き出しとも同じ buildDuckActivity() / duckGain() を使う。
// ============================================================

export const DUCK_RATE = 20 // 1 秒あたりのサンプル数

/** これ以下の音量は「鳴っていない」、これ以上は「鳴っている」 (dBFS) */
const QUIET_DB = -45
const LOUD_DB = -30
/** 下げ始め / 戻し始めの速さ (秒) */
const ATTACK = 0.08
const RELEASE = 0.45
/** 声の出だしで既に下がっているよう、少し先読みする (秒) */
const LOOKAHEAD = 0.1

export interface RmsTrack {
  rate: number
  db: Float32Array
}

/** 全チャンネルをまとめた RMS (dB) を rate 回/秒で求める */
export function rmsFromChannels(
  chans: Float32Array[],
  sampleRate: number,
  rate = DUCK_RATE
): RmsTrack {
  const len = chans[0]?.length ?? 0
  const win = Math.max(1, Math.floor(sampleRate / rate))
  const n = Math.ceil(len / win)
  const db = new Float32Array(n)
  for (let b = 0; b < n; b++) {
    const s0 = b * win
    const s1 = Math.min(len, s0 + win)
    let sum = 0
    for (const ch of chans) {
      for (let i = s0; i < s1; i++) sum += ch[i] * ch[i]
    }
    const mean = sum / Math.max(1, (s1 - s0) * chans.length)
    db[b] = mean > 0 ? 10 * Math.log10(mean) : -120
  }
  return { rate, db }
}

export interface DuckActivity {
  rate: number
  /** タイムライン t = i / rate 秒で他の音が鳴っている度合い (0..1, 平滑化済み) */
  values: Float32Array
}

export function hasDucking(clips: Clip[]): boolean {
  return clips.some(c => c.kind === 'audio' && (c.ducking?.amount ?? 0) > 0)
}

/** ダッキングのきっかけになるクリップ (音を持ち、鳴らしていて、自分は下げられない) */
export function duckTriggers(state: Pick<ProjectState, 'clips' | 'tracks'>): Array<Clip & { assetId: string }> {
  const muted = new Set(state.tracks.filter(t => t.muted).map(t => t.id))
  return state.clips.filter(
    (c): c is Clip & { assetId: string } =>
      (c.kind === 'video' || c.kind === 'audio') &&
      !c.muted &&
      !muted.has(c.trackId) &&
      (c.volume ?? 1) > 0 &&
      !(c.kind === 'audio' && (c.ducking?.amount ?? 0) > 0)
  )
}

/**
 * タイムライン全体の「他の音が鳴っている度合い」を求める。
 * rms は素材 ID → RmsTrack (無い素材はきっかけにしない)。
 */
export function buildDuckActivity(
  state: Pick<ProjectState, 'clips' | 'tracks'>,
  rms: ReadonlyMap<string, RmsTrack>,
  rate = DUCK_RATE
): DuckActivity {
  const triggers = duckTriggers(state).filter(c => rms.has(c.assetId))
  const end = Math.max(0, ...state.clips.map(c => c.start + c.duration))
  const n = Math.ceil(end * rate) + 1
  const raw = new Float32Array(n)
  for (const c of triggers) {
    const r = rms.get(c.assetId)!
    const i0 = Math.max(0, Math.ceil(c.start * rate))
    const i1 = Math.min(n - 1, Math.floor((c.start + c.duration) * rate))
    for (let i = i0; i <= i1; i++) {
      const t = i / rate
      if (t >= c.start + c.duration) break
      const src = mapClipTimeToSource(c, t)
      const k = Math.floor(src * r.rate)
      if (k < 0 || k >= r.db.length) continue
      const a = (r.db[k] - QUIET_DB) / (LOUD_DB - QUIET_DB)
      if (a > raw[i]) raw[i] = Math.min(1, a)
    }
  }
  // 先読み: 少し先までの最大値を目標にする
  const ahead = Math.round(LOOKAHEAD * rate)
  const target = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let j = i; j <= Math.min(n - 1, i + ahead); j++) if (raw[j] > m) m = raw[j]
    target[i] = m
  }
  // アタック / リリースで平滑化 (1 次遅れ)
  const values = new Float32Array(n)
  const dt = 1 / rate
  let cur = 0
  for (let i = 0; i < n; i++) {
    const k = target[i] > cur ? Math.min(1, dt / ATTACK) : Math.min(1, dt / RELEASE)
    cur += (target[i] - cur) * k
    values[i] = cur
  }
  return { rate, values }
}

/** ダッキング対象クリップの時刻 t での音量係数 (対象外や activity なしは 1) */
export function duckGain(activity: DuckActivity | null, clip: Clip, t: number): number {
  if (!activity || clip.kind !== 'audio') return 1
  const amount = Math.max(0, Math.min(1, clip.ducking?.amount ?? 0))
  if (amount <= 0) return 1
  const x = t * activity.rate
  const i = Math.floor(x)
  if (i < 0 || i >= activity.values.length) return 1
  const a = activity.values[i]
  const b = activity.values[Math.min(activity.values.length - 1, i + 1)]
  const v = a + (b - a) * (x - i)
  return 1 - amount * v
}

// ---------- プレビュー用: 素材の RMS をデコードしてキャッシュ ----------

const rmsCache = new Map<string, Promise<RmsTrack | null>>()

export function loadRms(projectId: string, assetId: string): Promise<RmsTrack | null> {
  const key = `${projectId}:${assetId}`
  let p = rmsCache.get(key)
  if (!p) {
    p = decodeRms(projectId, assetId)
    rmsCache.set(key, p)
  }
  return p
}

async function decodeRms(projectId: string, assetId: string): Promise<RmsTrack | null> {
  const blob = await loadAssetBlob(projectId, assetId)
  if (!blob) return null
  try {
    const buf = await decodeForAnalysis(blob)
    const chans: Float32Array[] = []
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c))
    return rmsFromChannels(chans, buf.sampleRate)
  } catch (e) {
    // 大きすぎる素材は「解析できなかった」として呼び出し側に知らせる
    if (e instanceof TooLargeForAnalysisError) throw e
    return null // 音声の無い素材など
  }
}

export interface DuckComputation {
  activity: DuckActivity | null
  /** 大きすぎて解析できず、きっかけにできなかった素材 ID */
  skippedAssetIds: string[]
}

/** 現在の作品のダッキング度合いを求める (プレビュー用)。対象が無ければ activity は null */
export async function computeDuckActivity(state: ProjectState): Promise<DuckComputation> {
  if (!hasDucking(state.clips)) return { activity: null, skippedAssetIds: [] }
  const rms = new Map<string, RmsTrack>()
  const skipped: string[] = []
  for (const c of duckTriggers(state)) {
    if (rms.has(c.assetId) || skipped.includes(c.assetId)) continue
    try {
      const r = await loadRms(state.meta.id, c.assetId)
      if (r) rms.set(c.assetId, r)
    } catch {
      skipped.push(c.assetId)
    }
  }
  return { activity: buildDuckActivity(state, rms), skippedAssetIds: skipped }
}

export function clearDuckCache() {
  rmsCache.clear()
}
