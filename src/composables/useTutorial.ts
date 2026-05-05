import { ref } from 'vue'

// ============================================================
// チュートリアル表示状態 (モジュールシングルトン)
// ============================================================

const STORAGE_KEY = 'lve.tutorialDone.v1'

const showing = ref(false)

function hasSeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function markSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {}
}

function resetSeen() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

export function useTutorial() {
  return {
    showing,
    hasSeen,
    markSeen,
    resetSeen,
    open: () => {
      showing.value = true
    },
    close: () => {
      showing.value = false
    },
    openIfFirstVisit: () => {
      if (!hasSeen()) showing.value = true
    }
  }
}
