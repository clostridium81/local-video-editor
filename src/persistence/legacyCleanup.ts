export type CleanupStatus = 'deleted' | 'blocked' | 'failed' | 'unavailable'

/** 旧版の DB のみ削除する。DB を開く/作ることも、起動を待たせることもしない。 */
export function cleanupLegacyStorage(onStatus: (status: CleanupStatus) => void): void {
  try {
    if (!globalThis.indexedDB) {
      onStatus('unavailable')
      return
    }
    const request = indexedDB.deleteDatabase('local-video-editor')
    request.onsuccess = () => onStatus('deleted')
    request.onblocked = () => onStatus('blocked')
    request.onerror = () => onStatus('failed')
  } catch {
    onStatus('failed')
  }
}
