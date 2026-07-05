import { openDB, type IDBPDatabase } from 'idb'

// ============================================================
// IndexedDB 素材ストア + プロジェクトストア
// ============================================================
// 設計方針:
// - 素材の Blob 本体だけを 'assets' ストアで持つ
// - プロジェクト状態は 'projects' ストアに JSON として保存 (自動保存用)
// - 複数プロジェクトを跨いでも素材を共有できるように
//   (projectId, assetId) をキーにする
// ============================================================

const DB_NAME = 'local-video-editor'
const DB_VERSION = 2
const ASSET_STORE = 'assets'
const PROJECT_STORE = 'projects'

interface StoredAsset {
  key: string // `${projectId}:${assetId}`
  projectId: string
  assetId: string
  blob: Blob
}

let dbPromise: Promise<IDBPDatabase> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains(ASSET_STORE)) {
            const store = db.createObjectStore(ASSET_STORE, { keyPath: 'key' })
            store.createIndex('projectId', 'projectId', { unique: false })
          }
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains(PROJECT_STORE)) {
            const pstore = db.createObjectStore(PROJECT_STORE, { keyPath: 'id' })
            pstore.createIndex('updatedAt', 'updatedAt', { unique: false })
          }
        }
      }
    })
  }
  return dbPromise
}

function makeKey(projectId: string, assetId: string) {
  return `${projectId}:${assetId}`
}

// ---------- Asset Blob ----------

export async function saveAssetBlob(
  projectId: string,
  assetId: string,
  blob: Blob
): Promise<void> {
  const db = await getDB()
  const record: StoredAsset = {
    key: makeKey(projectId, assetId),
    projectId,
    assetId,
    blob
  }
  await db.put(ASSET_STORE, record)
}

export async function loadAssetBlob(
  projectId: string,
  assetId: string
): Promise<Blob | null> {
  const db = await getDB()
  const record = (await db.get(ASSET_STORE, makeKey(projectId, assetId))) as
    | StoredAsset
    | undefined
  return record?.blob ?? null
}

export async function deleteAssetBlob(
  projectId: string,
  assetId: string
): Promise<void> {
  const db = await getDB()
  await db.delete(ASSET_STORE, makeKey(projectId, assetId))
}

export async function listProjectAssets(projectId: string): Promise<string[]> {
  const db = await getDB()
  const index = db.transaction(ASSET_STORE).store.index('projectId')
  const records = (await index.getAll(projectId)) as StoredAsset[]
  return records.map(r => r.assetId)
}

export async function clearProject(projectId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(ASSET_STORE, 'readwrite')
  const index = tx.store.index('projectId')
  let cursor = await index.openCursor(projectId)
  while (cursor) {
    await cursor.delete()
    cursor = await cursor.continue()
  }
  await tx.done
}

/**
 * IndexedDB の全データ (素材 Blob + 保存済みプロジェクト状態) を消去する。
 * 自動保存を廃したため、起動時に前セッションの残骸を掃除するのに使う。
 */
export async function clearAllData(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([ASSET_STORE, PROJECT_STORE], 'readwrite')
  await tx.objectStore(ASSET_STORE).clear()
  await tx.objectStore(PROJECT_STORE).clear()
  await tx.done
}

// ---------- Project state persistence ----------

export async function saveProjectState(state: ProjectState): Promise<void> {
  const db = await getDB()
  const record: StoredProject = {
    id: state.meta.id,
    name: state.meta.name,
    updatedAt: state.meta.updatedAt,
    state
  }
  await db.put(PROJECT_STORE, record)
}

export async function loadProjectState(
  projectId: string
): Promise<ProjectState | null> {
  const db = await getDB()
  const record = (await db.get(PROJECT_STORE, projectId)) as
    | StoredProject
    | undefined
  return record?.state ?? null
}

export async function loadLatestProjectState(): Promise<ProjectState | null> {
  const db = await getDB()
  const tx = db.transaction(PROJECT_STORE)
  const index = tx.store.index('updatedAt')
  let cursor = await index.openCursor(null, 'prev')
  const record = (cursor?.value as StoredProject | undefined) ?? null
  await tx.done
  return record?.state ?? null
}

export async function listStoredProjects(): Promise<
  Array<{ id: string; name: string; updatedAt: number }>
> {
  const db = await getDB()
  const records = (await db.getAll(PROJECT_STORE)) as StoredProject[]
  return records
    .map(r => ({ id: r.id, name: r.name, updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteProjectState(projectId: string): Promise<void> {
  const db = await getDB()
  await db.delete(PROJECT_STORE, projectId)
}

// ============================================================
// Object URL キャッシュ
// ============================================================
// <video>, <img> 要素で Blob を表示するために createObjectURL が必要。
// 同じ素材を何度も URL 化すると漏れるので、キャッシュを持つ。
// ============================================================

const urlCache = new Map<string, string>()

export async function getAssetObjectURL(
  projectId: string,
  assetId: string
): Promise<string | null> {
  const key = makeKey(projectId, assetId)
  const cached = urlCache.get(key)
  if (cached) return cached
  const blob = await loadAssetBlob(projectId, assetId)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urlCache.set(key, url)
  return url
}

export function revokeAssetObjectURL(projectId: string, assetId: string) {
  const key = makeKey(projectId, assetId)
  const url = urlCache.get(key)
  if (url) {
    URL.revokeObjectURL(url)
    urlCache.delete(key)
  }
}

export function revokeAllObjectURLs() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
}
