import { zip, unzip, strToU8, strFromU8 } from 'fflate'
import type { BackupManifest, ProjectState } from '../types/project'
import { loadAssetBlob, saveAssetBlob } from './assetStore'

// ============================================================
// バックアップZIPの構造
// ============================================================
//   manifest.json           ... フォーマット識別
//   project.json            ... ProjectState (JSON)
//   assets/<assetId>.<ext>  ... 素材ファイル本体 (元のバイト列のまま)
// ============================================================

interface ZipInput {
  [path: string]: Uint8Array
}

function zipAsync(input: ZipInput): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(input, { level: 6 }, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

function unzipAsync(data: Uint8Array): Promise<ZipInput> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, files) => {
      if (err) reject(err)
      else resolve(files as ZipInput)
    })
  })
}

// assetId から、保存時に使う拡張子を決める
function extForMime(mime: string, fallbackName: string): string {
  const m = mime.toLowerCase()
  if (m === 'video/mp4') return 'mp4'
  if (m === 'video/webm') return 'webm'
  if (m === 'video/quicktime') return 'mov'
  if (m === 'image/png') return 'png'
  if (m === 'image/jpeg') return 'jpg'
  if (m === 'image/gif') return 'gif'
  if (m === 'image/webp') return 'webp'
  if (m === 'audio/mpeg') return 'mp3'
  if (m === 'audio/wav' || m === 'audio/x-wav') return 'wav'
  if (m === 'audio/ogg') return 'ogg'
  // fallback: 元ファイル名から
  const match = /\.([a-z0-9]+)$/i.exec(fallbackName)
  return match ? match[1] : 'bin'
}

// ----------------------------------------------------------------
// エクスポート
// ----------------------------------------------------------------
export async function exportBackup(
  project: ProjectState,
  opts: { filename?: string } = {}
): Promise<void> {
  const manifest: BackupManifest = {
    format: 'local-video-editor-backup',
    version: 1,
    createdAt: Date.now(),
    projectId: project.meta.id,
    projectName: project.meta.name
  }

  const files: ZipInput = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'project.json': strToU8(JSON.stringify(project, null, 2))
  }

  // すべての素材を IndexedDB から読み出して ZIP に詰める
  for (const asset of Object.values(project.assets)) {
    const blob = await loadAssetBlob(project.meta.id, asset.id)
    if (!blob) {
      console.warn('素材が見つかりません (スキップ):', asset.name)
      continue
    }
    const ext = extForMime(asset.mimeType, asset.name)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    files[`assets/${asset.id}.${ext}`] = bytes
  }

  const zipped = await zipAsync(files)

  const safeName = (opts.filename ?? project.meta.name).replace(
    /[\\/:*?"<>|]/g,
    '_'
  )
  const ts = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .replace(/\..+/, '')
  const fname = `${safeName}__${ts}.lvebackup.zip`

  downloadBlob(new Blob([zipped as BlobPart], { type: 'application/zip' }), fname)
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 次のタスクで revoke
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ----------------------------------------------------------------
// インポート (復元)
// ----------------------------------------------------------------
export interface ImportResult {
  project: ProjectState
  assetCount: number
}

export async function importBackup(file: File): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const files = await unzipAsync(bytes)

  if (!files['manifest.json'] || !files['project.json']) {
    throw new Error('この ファイルは このアプリで つくったものでは ないみたい')
  }

  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as BackupManifest
  if (manifest.format !== 'local-video-editor-backup') {
    throw new Error('この ファイルは このアプリで つくったものでは ないよ')
  }
  if (manifest.version !== 1) {
    throw new Error(`この ファイルは あたらしすぎて ひらけないよ (v${manifest.version})`)
  }

  const project = JSON.parse(strFromU8(files['project.json'])) as ProjectState

  // 素材を IndexedDB に書き戻す
  let assetCount = 0
  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith('assets/')) continue
    const filename = path.slice('assets/'.length)
    const assetId = filename.replace(/\.[^.]+$/, '')
    const asset = project.assets[assetId]
    if (!asset) {
      console.warn('project.json に記載のない素材があります (スキップ):', filename)
      continue
    }
    const blob = new Blob([data as BlobPart], { type: asset.mimeType })
    await saveAssetBlob(project.meta.id, assetId, blob)
    assetCount++
  }

  return { project, assetCount }
}
