import { ref } from 'vue'

// ============================================================
// ブラウザストレージ (IndexedDB) の永続化リクエスト & 残量管理
// ============================================================
// - navigator.storage.persist(): ストレージを "persistent" に昇格させ、
//   ディスク逼迫時にブラウザが勝手に退避 (削除) するのを防ぐ
// - navigator.storage.estimate(): 使用量・上限を取得して残量表示に使う
// モジュールシングルトンで、どのコンポーネントからも同じ reactive 状態を参照する。
// ============================================================

const usage = ref<number | null>(null)
const quota = ref<number | null>(null)
// true=永続化済 / false=拒否 or 未対応 / null=未確認
const persisted = ref<boolean | null>(null)

let estimating = false

/**
 * ストレージの永続化をリクエストする。起動時に一度呼べばよい。
 * 既に永続化済みなら再要求しない。結果は persisted に反映。
 */
async function requestPersist(): Promise<boolean> {
  try {
    const sm = navigator.storage
    if (!sm?.persist) {
      persisted.value = null
      return false
    }
    // 既に永続化されていれば再要求しない
    if (sm.persisted) {
      const already = await sm.persisted()
      if (already) {
        persisted.value = true
        return true
      }
    }
    const granted = await sm.persist()
    persisted.value = granted
    return granted
  } catch {
    persisted.value = null
    return false
  }
}

/** 使用量・上限を取得して usage/quota を更新する */
async function refreshEstimate(): Promise<void> {
  if (estimating) return
  estimating = true
  try {
    const sm = navigator.storage
    if (sm?.estimate) {
      const est = await sm.estimate()
      usage.value = est.usage ?? null
      quota.value = est.quota ?? null
    }
  } catch {
    // 取得できなければ null のまま (=不明)
  } finally {
    estimating = false
  }
}

/** 推定空き容量 (バイト)。取得できなければ null */
function freeBytes(): number | null {
  if (usage.value == null || quota.value == null) return null
  return Math.max(0, quota.value - usage.value)
}

/**
 * size バイトを保存する余地があるか。
 * ブラウザは quota ぎりぎりで QuotaExceeded を出すため、安全マージンを引く。
 * 残量が取得できない (不明) 場合は true を返す (チェック不能なので通す)。
 */
function hasSpaceFor(size: number): boolean {
  const free = freeBytes()
  if (free == null) return true
  const margin = Math.max(50 * 1024 * 1024, (quota.value ?? 0) * 0.05)
  return size + margin <= free
}

export function useStorage() {
  return {
    usage,
    quota,
    persisted,
    requestPersist,
    refreshEstimate,
    freeBytes,
    hasSpaceFor
  }
}
