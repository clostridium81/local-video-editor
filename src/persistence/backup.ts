import type { Asset, BackupManifest, ProjectState } from '../types/project'
import { loadAssetBlob } from './assetStore'
import { buildStoredZip, crc32OfBlob, readZipEntries, type ZipEntryInput } from './zipStream'

// ============================================================
// バックアップZIPの構造
// ============================================================
//   manifest.json           ... フォーマット識別 (+ 保存できなかった素材の一覧)
//   project.json            ... ProjectState (JSON)
//   assets/<assetId>.<ext>  ... 素材ファイル本体 (元のバイト列のまま)
// 大容量でもタブが落ちないよう、素材は無圧縮で元の File を参照したまま ZIP にする
// (zipStream.ts)。読み込みも 1 素材ずつ取り出す。
// ============================================================

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
  if (m === 'font/ttf') return 'ttf'
  if (m === 'font/otf') return 'otf'
  if (m === 'font/woff') return 'woff'
  if (m === 'font/woff2') return 'woff2'
  // fallback: 元ファイル名から
  const match = /\.([a-z0-9]+)$/i.exec(fallbackName)
  return match ? match[1] : 'bin'
}

// ----------------------------------------------------------------
// エクスポート
// ----------------------------------------------------------------

export interface BackupBuildResult {
  blob: Blob
  /** 読み込めず ZIP に入れられなかった素材 (元ファイルの移動・変更・削除など) */
  skipped: Asset[]
}

/**
 * バックアップ ZIP を組み立てる。読めない素材があっても全体は失敗させず、
 * その素材だけを除いて skipped で返す (manifest にも記録し、復元時に知らせる)。
 */
export async function buildBackup(project: ProjectState): Promise<BackupBuildResult> {
  // 全参照を最初に確保する。ZIP 作成中に作品を切り替えても途中で素材を失わない。
  const sources = await Promise.all(Object.values(project.assets).map(async asset => ({
    asset,
    blob: await loadAssetBlob(project.meta.id, asset.id)
  })))

  const entries: ZipEntryInput[] = []
  const skipped: Asset[] = []
  for (const { asset, blob } of sources) {
    if (!blob) {
      skipped.push(asset)
      continue
    }
    try {
      // 1 回読み通して CRC を求める (ここで読めない File は除外する)
      const { crc, size } = await crc32OfBlob(blob)
      if (size !== blob.size) throw new Error('size changed')
      entries.push({ name: `assets/${asset.id}.${extForMime(asset.mimeType, asset.name)}`, data: blob, crc })
    } catch (e) {
      console.warn('バックアップに含められない素材', asset.name, e)
      skipped.push(asset)
    }
  }

  const manifest: BackupManifest = {
    format: 'local-video-editor-backup',
    version: 1,
    createdAt: Date.now(),
    projectId: project.meta.id,
    projectName: project.meta.name,
    ...(skipped.length ? { missingAssets: skipped.map(a => a.id) } : {})
  }
  const text = (v: unknown) => new Blob([JSON.stringify(v, null, 2)], { type: 'application/json' })
  const blob = await buildStoredZip([
    { name: 'manifest.json', data: text(manifest) },
    { name: 'project.json', data: text(project) },
    ...entries
  ])
  return { blob, skipped }
}

/** 互換用: ZIP の Blob だけを返す */
export async function createBackupBlob(project: ProjectState): Promise<Blob> {
  return (await buildBackup(project)).blob
}

export function backupFileName(project: ProjectState, filename?: string): string {
  const safeName = (filename ?? project.meta.name).replace(/[\\/:*?"<>|]/g, '_')
  const ts = new Date()
    .toISOString()
    .replace(/[:T]/g, '-')
    .replace(/\..+/, '')
  return `${safeName}__${ts}.lvebackup.zip`
}

export interface SaveBackupResult {
  /**
   * saved: 保存先に書き込み完了を確認した / downloaded: ダウンロードを開始した
   * (ブラウザ任せで完了は確認できない) / cancelled: 保存先の選択をやめた
   */
  status: 'saved' | 'downloaded' | 'cancelled'
  skipped: Asset[]
}

/**
 * バックアップを保存する。File System Access API が使えるブラウザでは、
 * クリック直後 (ユーザー操作が有効なうち) に保存先を選ばせ、ZIP を作ってから
 * 書き込み、完了まで待つ。使えない場合は従来どおりダウンロードする。
 */
export async function saveBackup(
  project: ProjectState,
  opts: { filename?: string } = {}
): Promise<SaveBackupResult> {
  const name = backupFileName(project, opts.filename)
  const picker = (globalThis as any).showSaveFilePicker as undefined | ((o: unknown) => Promise<any>)
  if (typeof picker === 'function') {
    let handle: any = null
    try {
      handle = await picker({
        suggestedName: name,
        types: [{ description: 'バックアップ (ZIP)', accept: { 'application/zip': ['.zip'] } }]
      })
    } catch (e: any) {
      if (e?.name === 'AbortError') return { status: 'cancelled', skipped: [] }
      // SecurityError (ユーザー操作切れ・iframe 内) などはダウンロードに切り替える
      handle = null
    }
    if (handle) {
      const { blob, skipped } = await buildBackup(project)
      const writable = await handle.createWritable()
      try {
        await writable.write(blob)
        await writable.close()
      } catch (e) {
        await writable.abort?.().catch?.(() => {})
        throw e
      }
      return { status: 'saved', skipped }
    }
  }
  const { blob, skipped } = await buildBackup(project)
  downloadBlob(blob, name)
  return { status: 'downloaded', skipped }
}

/** 互換用 (ダウンロード固定) */
export async function exportBackup(
  project: ProjectState,
  opts: { filename?: string } = {}
): Promise<void> {
  const { blob } = await buildBackup(project)
  downloadBlob(blob, backupFileName(project, opts.filename))
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 大きなファイルでもダウンロード開始まで URL を生かしておく
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ----------------------------------------------------------------
// インポート (復元)
// ----------------------------------------------------------------
export interface ImportResult {
  project: ProjectState
  assetCount: number
  blobs: ReadonlyMap<string, Blob>
  /** 復元できなかった素材・クリップなどの注意 (空なら完全に復元) */
  warnings: string[]
}

export async function importBackup(file: File): Promise<ImportResult> {
  const entries = await readZipEntries(file)
  const byName = new Map(entries.map(e => [e.name, e]))
  const manifestEntry = byName.get('manifest.json')
  const projectEntry = byName.get('project.json')
  if (!manifestEntry || !projectEntry) {
    throw new Error('このファイルはこのアプリで作成したものではないようです')
  }

  const manifest = JSON.parse(await manifestEntry.text()) as BackupManifest
  if (manifest.format !== 'local-video-editor-backup') {
    throw new Error('このファイルはこのアプリで作成したものではありません')
  }
  if (manifest.version !== 1) {
    throw new Error(`このファイルは新しすぎて開けません (v${manifest.version})`)
  }

  const project = JSON.parse(await projectEntry.text()) as ProjectState
  validateProjectReferences(project, manifest)
  const warnings: string[] = []

  // 全素材を検証してから呼び出し側で一括反映する。失敗時は現作品に触れない。
  // 1 素材ずつ取り出すので、ZIP 全体をメモリに載せない。
  const blobs = new Map<string, Blob>()
  for (const entry of entries) {
    if (!entry.name.startsWith('assets/')) continue
    const filename = entry.name.slice('assets/'.length)
    const assetId = filename.replace(/\.[^.]+$/, '')
    if (!Object.hasOwn(project.assets, assetId)) continue
    const asset = project.assets[assetId]
    if (blobs.has(assetId)) throw new Error(`素材が重複しています: ${asset.name}`)
    const blob = await entry.read(asset.mimeType)
    if (blob.size !== asset.size) {
      // 壊れている可能性はあるが、作品ごと開けなくなるよりは読める分を使う
      warnings.push(`素材のサイズが記録と違います (壊れている可能性があります): ${asset.name}`)
    }
    blobs.set(assetId, blob)
  }

  // ZIP に入っていない素材 (旧版の不具合・保存時に読めなかった素材) は、
  // それを使うクリップと一緒に外して、残りを復元する
  const missing = Object.values(project.assets).filter(a => !blobs.has(a.id))
  if (missing.length) {
    for (const a of missing) delete project.assets[a.id]
    warnings.push(
      `次の素材はバックアップに入っていなかったため、使っていたクリップを外しました: ` +
        missing.map(a => a.name).join('、')
    )
  }
  const trackIds = new Set(project.tracks.map(t => t.id))
  const before = project.clips.length
  project.clips = project.clips.filter(c =>
    trackIds.has(c.trackId) &&
    !(['video', 'image', 'audio'].includes(c.kind) && !Object.hasOwn(project.assets, (c as any).assetId))
  )
  const dropped = before - project.clips.length
  if (dropped > 0) warnings.push(`素材やトラックが見つからないクリップ ${dropped} 件を外しました`)
  if (sanitizeKeyframes(project)) warnings.push('壊れていたキーフレームを取り除きました')

  return { project, assetCount: blobs.size, blobs, warnings }
}

/**
 * キーフレームを検査し、描画を止めてしまう壊れたデータ (null・数値でない時刻や値・
 * 配列でない) を取り除く。取り除いたものがあれば true。
 */
function sanitizeKeyframes(project: ProjectState): boolean {
  let changed = false
  for (const clip of project.clips) {
    const kfs = (clip as any).keyframes
    if (kfs == null) continue
    if (typeof kfs !== 'object' || Array.isArray(kfs)) {
      delete (clip as any).keyframes
      changed = true
      continue
    }
    for (const [path, list] of Object.entries(kfs)) {
      if (!Array.isArray(list)) {
        delete kfs[path]
        changed = true
        continue
      }
      const valid = list.filter(
        (k: any) => k && typeof k === 'object' && Number.isFinite(k.time) && Number.isFinite(k.value)
      )
      for (const k of valid as any[]) {
        if (typeof k.easing !== 'string') k.easing = 'linear'
        if (k.bezier !== undefined && !(Array.isArray(k.bezier) && k.bezier.length === 4 && k.bezier.every(Number.isFinite))) {
          delete k.bezier
          if (k.easing === 'bezier') k.easing = 'linear'
          changed = true
        }
      }
      if (valid.length !== list.length) changed = true
      if (valid.length) kfs[path] = (valid as any[]).sort((a, b) => a.time - b.time)
      else delete kfs[path]
    }
    if (Object.keys(kfs).length === 0) delete (clip as any).keyframes
  }
  return changed
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
    if (!validId(id) || !asset || asset.id !== id || !['video', 'image', 'audio', 'font'].includes(asset.kind)
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
    // 素材・トラックが見つからない参照は importBackup で外す (旧版の不具合で起こりうるため
    // 作品全体を開けなくはしない)。ここでは構造として壊れているものだけを弾く
    if (!clip || !validId(clip.id) || clipIds.has(clip.id) || typeof clip.trackId !== 'string'
      || !['video', 'image', 'audio', 'text', 'shape'].includes(clip.kind)
      || !Number.isFinite(clip.start) || !Number.isFinite(clip.duration) || clip.duration <= 0) {
      throw new Error('クリップ情報が不正です')
    }
    clipIds.add(clip.id)
  }
}
