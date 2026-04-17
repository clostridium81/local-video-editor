import { ref } from 'vue'
import type { Clip } from '../types/project'

// ============================================================
// クリップのコピー/ペーストバッファ (モジュールシングルトン)
// システムクリップボードには乗せない (JSON で済む内部状態のため)
// ============================================================

const buffer = ref<Clip[] | null>(null)

export function useClipboard() {
  function copy(clips: Clip[]) {
    if (clips.length === 0) return
    // deep copy (後で ID を差し替える)
    buffer.value = clips.map(c => JSON.parse(JSON.stringify(c)) as Clip)
  }

  function hasContents() {
    return (buffer.value?.length ?? 0) > 0
  }

  function peek(): Clip[] | null {
    return buffer.value
  }

  function clear() {
    buffer.value = null
  }

  return { copy, hasContents, peek, clear }
}
