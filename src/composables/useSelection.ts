import { ref, computed } from 'vue'

// ============================================================
// 選択中のクリップID (マルチ選択対応)
// ============================================================

const selectedIds = ref<string[]>([])

export function useSelection() {
  function selectClip(id: string | null, additive = false) {
    if (id == null) {
      selectedIds.value = []
      return
    }
    if (additive) {
      if (selectedIds.value.includes(id)) {
        selectedIds.value = selectedIds.value.filter(x => x !== id)
      } else {
        selectedIds.value = [...selectedIds.value, id]
      }
    } else {
      selectedIds.value = [id]
    }
  }

  function selectClips(ids: string[]) {
    selectedIds.value = [...ids]
  }

  function clearSelection() {
    selectedIds.value = []
  }

  function isSelected(id: string) {
    return selectedIds.value.includes(id)
  }

  // 単一選択の後方互換 API (最初の要素)
  const selectedClipId = computed<string | null>(() =>
    selectedIds.value.length > 0 ? selectedIds.value[0] : null
  )

  const selectedClipIds = computed<string[]>(() => selectedIds.value)

  return {
    selectedClipId,
    selectedClipIds,
    selectClip,
    selectClips,
    clearSelection,
    isSelected
  }
}
