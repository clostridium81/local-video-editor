import { zip, unzip, strToU8, strFromU8 } from 'fflate'
import type { BackupManifest, ProjectState } from '../types/project'
import { loadAssetBlob } from './assetStore'

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
export async function createBackupBlob(project: ProjectState): Promise<Blob> {
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

  // 全参照を最初に確保する。ZIP 作成中に作品を切り替えても途中で素材を失わない。
  const sources = await Promise.all(Object.values(project.assets).map(async asset => {
    const blob = await loadAssetBlob(project.meta.id, asset.id)
    if (!blob) {
      throw new Error(`素材が見つかりません: ${asset.name}`)
    }
    return { asset, blob }
  }))
  for (const { asset, blob } of sources) {
    const ext = extForMime(asset.mimeType, asset.name)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    files[`assets/${asset.id}.${ext}`] = bytes
  }

  const zipped = await zipAsync(files)
  return new Blob([zipped as BlobPart], { type: 'application/zip' })
}

export async function exportBackup(
  project: ProjectState,
  opts: { filename?: string } = {}
): Promise<void> {
  const blob = await createBackupBlob(project)

  const safeName = (opts.filename ?? project.meta.name).replace(
    /[\\/:*?"<>|]/g,
    '_'
  )
  const ts = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .replace(/\..+/, '')
  const fname = `${safeName}__${ts}.lvebackup.zip`

  downloadBlob(blob, fname)
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
  blobs: ReadonlyMap<string, Blob>
}

export async function importBackup(file: File): Promise<ImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const files = await unzipAsync(bytes)

  if (!files['manifest.json'] || !files['project.json']) {
    throw new Error('このファイルはこのアプリで作成したものではないようです')
  }

  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as BackupManifest
  if (manifest.format !== 'local-video-editor-backup') {
    throw new Error('このファイルはこのアプリで作成したものではありません')
  }
  if (manifest.version !== 1) {
    throw new Error(`このファイルは新しすぎて開けません (v${manifest.version})`)
  }

  const project = JSON.parse(strFromU8(files['project.json'])) as ProjectState
  validateProjectReferences(project, manifest)

  // 全素材を検証してから呼び出し側で一括反映する。失敗時は現作品に触れない。
  const blobs = new Map<string, Blob>()
  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith('assets/')) continue
    const filename = path.slice('assets/'.length)
    const assetId = filename.replace(/\.[^.]+$/, '')
    if (!Object.hasOwn(project.assets, assetId)) continue
    const asset = project.assets[assetId]
    if (blobs.has(assetId)) throw new Error(`素材が重複しています: ${asset.name}`)
    if (data.byteLength !== asset.size) throw new Error(`素材のサイズが一致しません: ${asset.name}`)
    const blob = new Blob([data as BlobPart], { type: asset.mimeType })
    blobs.set(assetId, blob)
  }

  for (const asset of Object.values(project.assets)) {
    if (!blobs.has(asset.id)) throw new Error(`バックアップに素材がありません: ${asset.name}`)
  }
  return { project, assetCount: blobs.size, blobs }
}

// ZIP v1 の構造・素材参照の整合性を確認する (エフェクト等の拡張フィールドは維持)。
function validateProjectReferences(project: ProjectState, manifest: BackupManifest): void {
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]+$/.test(id)
    && !['__proto__', 'constructor', 'prototype'].includes(id)
  if (!project || !validId(project.meta?.id) || project.meta.id !== manifest.projectId
    || typeof project.meta.name !== 'string' || !project.assets || Array.isArray(project.assets)
    || typeof project.assets !== 'object' || !Array.isArray(project.tracks)
    || !Array.isArray(project.clips) || !project.timeline
    || ![project.meta.width, project.meta.height, project.meta.fps, project.timeline.zoom,
      project.timeline.duration].every(n => Number.isFinite(n) && n > 0)
    || !Number.isFinite(project.timeline.playhead)) {
    throw new Error('バックアップのプロジェクト情報が不正です')
  }
  for (const [id, asset] of Object.entries(project.assets)) {
    if (!validId(id) || !asset || asset.id !== id || !['video', 'image', 'audio'].includes(asset.kind)
      || typeof asset.name !== 'string' || typeof asset.mimeType !== 'string'
      || !Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error('バックアップの素材情報が不正です')
    }
  }
  const trackIds = new Set<string>()
  for (const track of project.tracks) {
    if (!track || !validId(track.id) || trackIds.has(track.id)
      || !['video', 'audio'].includes(track.kind)) throw new Error('トラック情報が不正です')
    trackIds.add(track.id)
  }
  const clipIds = new Set<string>()
  for (const clip of project.clips) {
    if (!clip || !validId(clip.id) || clipIds.has(clip.id) || !trackIds.has(clip.trackId)
      || !['video', 'image', 'audio', 'text', 'shape'].includes(clip.kind)
      || !Number.isFinite(clip.start) || !Number.isFinite(clip.duration) || clip.duration <= 0
      || (['video', 'image', 'audio'].includes(clip.kind)
        && (!('assetId' in clip) || !Object.hasOwn(project.assets, clip.assetId)))) {
      throw new Error('クリップの素材・トラック参照が不正です')
    }
    clipIds.add(clip.id)
  }
}
