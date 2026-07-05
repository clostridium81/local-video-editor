import type { ProjectState } from '../types/project'

// ============================================================
// Undo / Redo 履歴スタック
// ============================================================
// 設計:
// - 現在状態の直前にスナップショット(JSON deep copy)を undo に積む
// - undo 実行時、現在状態を redo に移し、undo.pop() を現在状態にする
// - mergeKey + mergeWindow によってドラッグなど高頻度変更を 1 エントリにまとめる
// - 素材追加/削除は IndexedDB への副作用があるため履歴対象外 (呼び出し側で clear)
// ============================================================

const DEFAULT_MAX = 100
const DEFAULT_MERGE_WINDOW_MS = 400

type Snapshot = string // JSON 文字列 (deep copy のコストを削減)

function snap(state: ProjectState): Snapshot {
  return JSON.stringify(state)
}

function restore(s: Snapshot): ProjectState {
  return JSON.parse(s) as ProjectState
}

export class HistoryManager {
  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private max: number
  private mergeWindow: number
  private lastMergeKey: string | null = null
  private lastTime = 0
  private version = 0

  constructor(max = DEFAULT_MAX, mergeWindow = DEFAULT_MERGE_WINDOW_MS) {
    this.max = max
    this.mergeWindow = mergeWindow
  }

  /**
   * 現在の状態をスナップショットとして履歴に積む。
   * 同じ mergeKey が mergeWindow 以内に続けて来たら直前エントリを上書きせず
   * 「最初のエントリだけ」残し、途中の変更は破棄する。(=ドラッグ中の無数の
   * 微少変化を 1 回分にまとめる)
   *
   * 返り値: 新しい履歴エントリを積んだら true、mergeでまとめたら false。
   * (編集回数のカウントに使う。ドラッグ 1 回 = 1 エントリ = 1 回)
   */
  record(current: ProjectState, mergeKey?: string): boolean {
    const now = Date.now()
    if (
      mergeKey &&
      this.lastMergeKey === mergeKey &&
      now - this.lastTime < this.mergeWindow &&
      this.undoStack.length > 0
    ) {
      // 直前の record と同じキー→最初の状態をそのまま維持し、時刻だけ更新
      this.lastTime = now
      this.redoStack.length = 0
      this.version++
      return false
    }

    this.undoStack.push(snap(current))
    if (this.undoStack.length > this.max) {
      this.undoStack.shift()
    }
    this.redoStack.length = 0
    this.lastMergeKey = mergeKey ?? null
    this.lastTime = now
    this.version++
    return true
  }

  /**
   * undo 実行。現在状態を redo に積み、直前の状態を返す。
   * 何もなければ null。
   */
  performUndo(current: ProjectState): ProjectState | null {
    const prev = this.undoStack.pop()
    if (!prev) return null
    this.redoStack.push(snap(current))
    this.lastMergeKey = null
    this.version++
    return restore(prev)
  }

  /**
   * redo 実行。現在状態を undo に積み、redo から取り出した状態を返す。
   */
  performRedo(current: ProjectState): ProjectState | null {
    const next = this.redoStack.pop()
    if (!next) return null
    this.undoStack.push(snap(current))
    this.lastMergeKey = null
    this.version++
    return restore(next)
  }

  canUndo() {
    return this.undoStack.length > 0
  }
  canRedo() {
    return this.redoStack.length > 0
  }

  clear() {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.lastMergeKey = null
    this.version++
  }

  /**
   * 変更検知用のバージョン番号。Vue の computed から購読してもらう。
   */
  getVersion() {
    return this.version
  }
}

export const historyManager = new HistoryManager()
