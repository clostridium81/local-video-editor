// 素材はタブのセッション内だけで参照する。File/Blob のコピーや永続化はしない。
// project.json と履歴には素材 ID とメタデータだけを持つ。
interface SessionAsset {
  blob: Blob
  url?: string
}

const projects = new Map<string, Map<string, SessionAsset>>()

export function saveAssetBlob(projectId: string, assetId: string, blob: Blob): void {
  let assets = projects.get(projectId)
  if (!assets) projects.set(projectId, assets = new Map())
  revokeAssetObjectURL(projectId, assetId)
  assets.set(assetId, { blob })
}

// 既存のデコード/描画側の非同期インターフェースを維持する。
export async function loadAssetBlob(projectId: string, assetId: string): Promise<Blob | null> {
  return projects.get(projectId)?.get(assetId)?.blob ?? null
}

export function deleteAssetBlob(projectId: string, assetId: string): void {
  revokeAssetObjectURL(projectId, assetId)
  const assets = projects.get(projectId)
  assets?.delete(assetId)
  if (assets?.size === 0) projects.delete(projectId)
}

export async function listProjectAssets(projectId: string): Promise<string[]> {
  return [...(projects.get(projectId)?.keys() ?? [])]
}

/** 現在の作品にも Undo/Redo 履歴にもない素材の参照を解放する。 */
export function retainProjectAssets(projectId: string, retained: ReadonlySet<string>): void {
  for (const id of projects.get(projectId)?.keys() ?? []) {
    if (!retained.has(id)) deleteAssetBlob(projectId, id)
  }
}

export function clearProject(projectId: string): void {
  for (const id of projects.get(projectId)?.keys() ?? []) revokeAssetObjectURL(projectId, id)
  projects.delete(projectId)
}

export function clearAllData(): void {
  revokeAllObjectURLs()
  projects.clear()
}

/** 復元の検証が終わってから同期的に切り替え、旧セッションの参照を解放する。 */
export function replaceSessionAssets(projectId: string, blobs: ReadonlyMap<string, Blob>): void {
  clearAllData()
  for (const [id, blob] of blobs) saveAssetBlob(projectId, id, blob)
}

export async function getAssetObjectURL(projectId: string, assetId: string): Promise<string | null> {
  const asset = projects.get(projectId)?.get(assetId)
  if (!asset) return null
  // await を挟まないので、同時リクエストでも URL は一つだけ生成される。
  return asset.url ??= URL.createObjectURL(asset.blob)
}

export function revokeAssetObjectURL(projectId: string, assetId: string): void {
  const asset = projects.get(projectId)?.get(assetId)
  if (asset?.url) {
    URL.revokeObjectURL(asset.url)
    delete asset.url
  }
}

export function revokeAllObjectURLs(): void {
  for (const [projectId, assets] of projects) {
    for (const id of assets.keys()) revokeAssetObjectURL(projectId, id)
  }
}
