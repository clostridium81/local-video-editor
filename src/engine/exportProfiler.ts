// ============================================================
// 書き出しプロファイラ
// ============================================================
// フレーム取得待ち (seek/decode)・描画・エンコード待ちなどの累積時間を
// 区間名ごとに集計し、書き出し完了時に内訳を出力する。
// localStorage の 'export-profile' を '1' にすると詳細テーブルも出す。
// ============================================================

export interface ProfilerClock {
  now(): number
}

export interface ProfileEntry {
  totalMs: number
  count: number
}

export class ExportProfiler {
  private clock: ProfilerClock
  private totals = new Map<string, ProfileEntry>()
  private running = new Map<string, number>()
  private startedAt: number

  constructor(clock?: ProfilerClock) {
    this.clock = clock ?? { now: () => performance.now() }
    this.startedAt = this.clock.now()
  }

  begin(name: string) {
    this.running.set(name, this.clock.now())
  }

  end(name: string) {
    const t0 = this.running.get(name)
    if (t0 === undefined) return
    this.running.delete(name)
    this.add(name, this.clock.now() - t0)
  }

  add(name: string, ms: number) {
    const e = this.totals.get(name)
    if (e) {
      e.totalMs += ms
      e.count++
    } else {
      this.totals.set(name, { totalMs: ms, count: 1 })
    }
  }

  elapsedMs(): number {
    return this.clock.now() - this.startedAt
  }

  summary(): Record<string, ProfileEntry & { avgMs: number }> {
    const out: Record<string, ProfileEntry & { avgMs: number }> = {}
    for (const [name, e] of this.totals) {
      out[name] = { ...e, avgMs: e.count > 0 ? e.totalMs / e.count : 0 }
    }
    return out
  }

  /** "frameWait 62% (12.3s) / draw 20% (4.0s) / ..." 形式の 1 行サマリ */
  oneLine(): string {
    const total = Math.max(1, this.elapsedMs())
    const parts = [...this.totals.entries()]
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .map(
        ([name, e]) =>
          `${name} ${Math.round((e.totalMs / total) * 100)}% (${(e.totalMs / 1000).toFixed(1)}s)`
      )
    return `計 ${(total / 1000).toFixed(1)}s: ${parts.join(' / ')}`
  }
}

export function isProfileDetailEnabled(): boolean {
  try {
    return (globalThis as any).localStorage?.getItem('export-profile') === '1'
  } catch {
    return false
  }
}

export function logProfile(profiler: ExportProfiler, label: string) {
  console.info(`[export] ${label}: ${profiler.oneLine()}`)
  if (isProfileDetailEnabled()) {
    const rows: Record<string, { 'total(ms)': number; count: number; 'avg(ms)': number }> = {}
    for (const [name, e] of Object.entries(profiler.summary())) {
      rows[name] = {
        'total(ms)': Math.round(e.totalMs),
        count: e.count,
        'avg(ms)': Math.round(e.avgMs * 100) / 100
      }
    }
    console.table(rows)
  }
}
