import { onBeforeUnmount, onMounted } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { useSelection } from './useSelection'
import { useClipboard } from './useClipboard'

// ============================================================
// グローバルキーボードショートカット
// ============================================================
// 入力系フォーカス中は全てバイパス。
// mac/win 両対応 (metaKey || ctrlKey)。
// ============================================================

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

/**
 * モーダル (エクスポート/プロジェクト管理/録画/ショートカット一覧) や
 * チュートリアルが開いている間は編集ショートカットを止める。
 * ダイアログの裏で Space 再生・S 分割・Delete 削除などが
 * 気づかないうちに走るのを防ぐ。
 */
function isModalOpen(): boolean {
  return !!document.querySelector('.modal-backdrop, .tour-bubble')
}

function isCmdOrCtrl(e: KeyboardEvent) {
  return e.metaKey || e.ctrlKey
}

export function useKeyboard() {
  const store = useProjectStore()
  const selection = useSelection()
  const clipboard = useClipboard()

  function onKey(e: KeyboardEvent) {
    if (isTypingTarget(e.target)) return
    if (isModalOpen()) return

    // Undo / Redo
    if (isCmdOrCtrl(e) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault()
      store.undo()
      return
    }
    if (
      (isCmdOrCtrl(e) && e.key.toLowerCase() === 'z' && e.shiftKey) ||
      (isCmdOrCtrl(e) && e.key.toLowerCase() === 'y')
    ) {
      e.preventDefault()
      store.redo()
      return
    }

    // Copy / Cut / Paste / Duplicate
    if (isCmdOrCtrl(e) && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      const ids = selection.selectedClipIds.value
      const clips = store.state.clips.filter(c => ids.includes(c.id))
      if (clips.length > 0) clipboard.copy(clips)
      return
    }
    if (isCmdOrCtrl(e) && e.key.toLowerCase() === 'x') {
      e.preventDefault()
      const ids = selection.selectedClipIds.value
      const clips = store.state.clips.filter(c => ids.includes(c.id))
      if (clips.length > 0) {
        clipboard.copy(clips)
        store.removeClips(ids)
        selection.clearSelection()
      }
      return
    }
    if (isCmdOrCtrl(e) && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      const clips = clipboard.peek()
      if (clips && clips.length > 0) {
        const newIds = store.pasteClipsAtPlayhead(clips)
        selection.selectClips(newIds)
      }
      return
    }
    if (isCmdOrCtrl(e) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      const ids = selection.selectedClipIds.value
      const clips = store.state.clips.filter(c => ids.includes(c.id))
      if (clips.length > 0) {
        const dups = store.duplicateClips(
          clips,
          Math.max(...clips.map(c => c.duration)) || 0
        )
        store.addClips(dups)
        selection.selectClips(dups.map(d => d.id))
      }
      return
    }

    // Split
    if (e.key.toLowerCase() === 's' && !isCmdOrCtrl(e)) {
      e.preventDefault()
      const newIds = store.splitSelectedAtPlayhead(selection.selectedClipIds.value)
      if (newIds.length > 0) {
        // 新しく出来た右側を選択 (ユーザーがすぐ削除しやすい)
        selection.selectClips(newIds)
      }
      return
    }

    // Select all
    if (isCmdOrCtrl(e) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selection.selectClips(store.state.clips.map(c => c.id))
      return
    }

    // Delete (リップルモード中は後続クリップを詰める)
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const ids = selection.selectedClipIds.value
      if (ids.length > 0) {
        e.preventDefault()
        if (store.state.timeline.rippleMode) store.rippleDelete(ids)
        else store.removeClips(ids)
        selection.clearSelection()
      }
      return
    }

    // Space → 再生 (PreviewPanel で受ける)
    if (e.code === 'Space') {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('lve:toggle-play'))
      return
    }

    // Markers & in/out
    if (e.key.toLowerCase() === 'm' && !isCmdOrCtrl(e) && !e.shiftKey) {
      e.preventDefault()
      store.addMarker(store.state.timeline.playhead)
      return
    }
    if (e.key.toLowerCase() === 'i' && !isCmdOrCtrl(e) && !e.shiftKey) {
      e.preventDefault()
      store.setInPoint(store.state.timeline.playhead)
      return
    }
    if (e.key.toLowerCase() === 'o' && !isCmdOrCtrl(e) && !e.shiftKey) {
      e.preventDefault()
      store.setOutPoint(store.state.timeline.playhead)
      return
    }
    if (e.key.toLowerCase() === 'i' && e.shiftKey) {
      e.preventDefault()
      store.clearInOut()
      return
    }
    // スナップ切替
    if (e.key.toLowerCase() === 'n' && !isCmdOrCtrl(e)) {
      e.preventDefault()
      store.toggleSnapping()
      return
    }
    // リップル切替
    if (e.key.toLowerCase() === 'r' && e.shiftKey && !isCmdOrCtrl(e)) {
      e.preventDefault()
      store.toggleRipple()
      return
    }
    // Link / Unlink
    if (isCmdOrCtrl(e) && e.key.toLowerCase() === 'l' && !e.shiftKey) {
      e.preventDefault()
      const ids = selection.selectedClipIds.value
      if (ids.length >= 2) store.linkClips(ids)
      return
    }
    if (isCmdOrCtrl(e) && e.key.toLowerCase() === 'l' && e.shiftKey) {
      e.preventDefault()
      const ids = selection.selectedClipIds.value
      if (ids.length > 0) store.unlinkClips(ids)
      return
    }

    // Arrow keys: playhead 1 フレーム移動
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const fps = store.state.meta.fps || 30
      const step = e.shiftKey ? 1 : 1 / fps
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      store.setPlayhead(store.state.timeline.playhead + dir * step)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      store.setPlayhead(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      store.setPlayhead(store.state.timeline.duration)
      return
    }
  }

  onMounted(() => window.addEventListener('keydown', onKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}
