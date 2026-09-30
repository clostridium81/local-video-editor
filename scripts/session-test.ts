// セッション素材・実ストア・ZIP の回帰テスト。DOM のメタデータ読み込みだけを代替する。
// ブラウザの実デコード/録画/エンコードはこのテストの対象外。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import * as assets from '../src/persistence/assetStore'
import { cleanupLegacyStorage, type CleanupStatus } from '../src/persistence/legacyCleanup'
import { buildBackup, createBackupBlob, importBackup } from '../src/persistence/backup'
import { readZipEntries, crc32OfBlob, buildStoredZip } from '../src/persistence/zipStream'
import { useProjectStore } from '../src/stores/projectStore'
import { useClipboard } from '../src/composables/useClipboard'
import { useSelection } from '../src/composables/useSelection'
import type { ProjectState } from '../src/types/project'

let passed = 0
async function test(name: string, run: () => void | Promise<void>) {
  await run()
  passed++
  console.log(`  ok: ${name}`)
}

// 素材処理が IndexedDB に触れたら即失敗 (legacyCleanup のテスト時だけ差し替え)。
Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  get() { throw new Error('素材処理から IndexedDB を使用した') }
})
const storage = new Map<string, string>()
Object.assign(globalThis, {
  window: { setTimeout: () => 0, clearTimeout: () => {} },
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  }
})
let holdMetadata = false
let metadataCompletions: Array<() => void> = []
class MetaElement {
  naturalWidth = 320
  naturalHeight = 180
  videoWidth = 320
  videoHeight = 180
  duration = 2
  onload?: () => void
  onloadedmetadata?: () => void
  set src(_value: string) {
    const done = () => { this.onload?.(); this.onloadedmetadata?.() }
    if (holdMetadata) metadataCompletions.push(done)
    else queueMicrotask(done)
  }
}
Object.assign(globalThis, { Image: MetaElement, document: { createElement: () => new MetaElement() } })
setActivePinia(createPinia())
const store = useProjectStore()
const imageFile = () => new File(['image-content'], 'photo.png', { type: 'image/png' })
const zipFile = (blob: Blob) => new File([blob], 'test.lvebackup.zip', { type: 'application/zip' })
const reset = async () => { store.resetToEmpty(); await nextTick() }

await test('File 本体をコピーせず保持し、同一 ID でも作品ごとに独立する', async () => {
  const original = imageFile()
  assets.saveAssetBlob('a', 'b:c', original)
  assets.saveAssetBlob('a:b', 'c', new Blob(['other']))
  assert.equal(await assets.loadAssetBlob('a', 'b:c'), original)
  assert.equal(await (await assets.loadAssetBlob('a:b', 'c'))!.text(), 'other')
  assert.equal(await assets.loadAssetBlob('a', 'missing'), null)
  assets.clearAllData()
})

await test('並行 URL 取得は同じ URL、素材差し替え/削除で旧 URL が無効になる', async () => {
  assets.saveAssetBlob('p', 'a', new Blob(['first']))
  const urls = await Promise.all(Array.from({ length: 20 }, () => assets.getAssetObjectURL('p', 'a')))
  assert.equal(new Set(urls).size, 1)
  assert.equal(await (await fetch(urls[0]!)).text(), 'first')
  assets.saveAssetBlob('p', 'a', new Blob(['second']))
  await assert.rejects(fetch(urls[0]!))
  const replacement = (await assets.getAssetObjectURL('p', 'a'))!
  assert.notEqual(replacement, urls[0])
  assert.equal(await (await fetch(replacement)).text(), 'second')
  assets.deleteAssetBlob('p', 'a')
  await assert.rejects(fetch(replacement))
  assert.deepEqual(await assets.listProjectAssets('p'), [])
})

await test('動画/画像/音声/録画・録音由来 File を同じ素材経路で読み出せる', async () => {
  await reset()
  for (const [name, mime, kind] of [
    ['video.mp4', 'video/mp4', 'video'], ['photo.png', 'image/png', 'image'],
    ['sound.wav', 'audio/wav', 'audio'], ['screen.webm', 'video/webm', 'video'],
    ['mic.webm', 'audio/webm', 'audio'], ['no-mime.mp4', '', 'video']
  ]) {
    const file = new File([name], name, { type: mime })
    const asset = (await store.addAssetFromFile(file))!
    assert.equal(asset.kind, kind)
    assert.equal(await assets.loadAssetBlob(store.meta.id, asset.id), file)
    const clip = store.addClipFromAsset(asset.id)
    assert.ok(clip)
    assert.equal(await (await fetch((await store.getAssetURL(asset.id))!)).text(), name)
  }
  assert.equal(Object.keys(store.assets).length, 6)
  const before = store.serialize()
  assert.equal(await store.addAssetFromFile(new File(['no'], 'data.txt', { type: 'text/plain' })), null)
  assert.deepEqual(store.serialize(), before)
})

await test('素材追加の Undo/Redo でメタデータと本体が揃って復元する', async () => {
  await reset()
  store.addTextClip()
  const file = imageFile()
  const asset = (await store.addAssetFromFile(file))!
  store.undo()
  await nextTick()
  assert.equal(store.assets[asset.id], undefined)
  assert.equal(store.clips.length, 1)
  assert.equal(await assets.loadAssetBlob(store.meta.id, asset.id), file)
  store.redo()
  assert.ok(store.assets[asset.id])
  assert.equal(await assets.loadAssetBlob(store.meta.id, asset.id), file)
})

await test('素材削除の Undo/Redo で使用中の全クリップと再生 URL が復元する', async () => {
  await reset()
  const file = imageFile()
  const asset = (await store.addAssetFromFile(file))!
  store.addClipFromAsset(asset.id)
  store.addClipFromAsset(asset.id, { start: 5 })
  const snapshot = store.serialize()
  const url = await store.getAssetURL(asset.id)
  await store.removeAsset(asset.id)
  await nextTick()
  assert.equal(store.clips.length, 0)
  assert.equal(store.assets[asset.id], undefined)
  store.undo()
  await nextTick()
  assert.deepEqual(store.serialize(), snapshot)
  assert.equal(await store.getAssetURL(asset.id), url)
  assert.equal(await assets.loadAssetBlob(store.meta.id, asset.id), file)
  store.redo()
  await nextTick()
  assert.equal(store.clips.length, 0)
  assert.equal(store.assets[asset.id], undefined)
  // 削除済み素材だけを参照するクリップを貼り付けても参照切れを作らない。
  assert.deepEqual(store.pasteClipsAtPlayhead(snapshot.clips), [])
})

await test('Undo 後に別編集で Redo を破棄すると不要な本体・URL を解放する', async () => {
  await reset()
  const asset = (await store.addAssetFromFile(imageFile()))!
  const url = (await store.getAssetURL(asset.id))!
  store.undo()
  await nextTick()
  assert.ok(await assets.loadAssetBlob(store.meta.id, asset.id))
  store.addTextClip()
  await nextTick()
  assert.equal(store.canRedo, false)
  assert.equal(await assets.loadAssetBlob(store.meta.id, asset.id), null)
  await assert.rejects(fetch(url))
})

await test('削除素材が 100 件の履歴から外れたら本体を解放する', async () => {
  await reset()
  const asset = (await store.addAssetFromFile(imageFile()))!
  await store.removeAsset(asset.id)
  for (let i = 0; i < 101; i++) store.addTextClip()
  await nextTick()
  assert.equal(await assets.loadAssetBlob(store.meta.id, asset.id), null)
})

await test('新規作品は素材・URL・履歴・選択・クリップボード・保存通知を引き継がない', async () => {
  await reset()
  const asset = (await store.addAssetFromFile(imageFile()))!
  const clip = store.addClipFromAsset(asset.id)!
  useSelection().selectClip(clip.id)
  useClipboard().copy([clip])
  store.shouldPromptBackup = true
  const id = store.meta.id
  const version = store.sessionVersion
  const url = (await store.getAssetURL(asset.id))!
  await reset()
  assert.notEqual(store.meta.id, id)
  assert.equal(store.sessionVersion, version + 1)
  assert.equal(await assets.loadAssetBlob(id, asset.id), null)
  await assert.rejects(fetch(url))
  assert.equal(store.canUndo, false)
  assert.equal(store.canRedo, false)
  assert.equal(useClipboard().hasContents(), false)
  assert.deepEqual(useSelection().selectedClipIds.value, [])
  assert.equal(store.shouldPromptBackup, false)
  assert.equal(store.hasUnbackedUpChanges(), false)
})

await test('メタデータ取得/一括追加の途中で作品が変わっても素材が混入しない', async () => {
  await reset()
  const session = store.sessionVersion
  holdMetadata = true
  const pending = store.addAssetFromFile(imageFile(), session)
  await reset()
  holdMetadata = false
  metadataCompletions.splice(0).forEach(done => done())
  assert.equal(await pending, null)
  assert.equal(await store.addAssetFromFile(imageFile(), session), null)
  assert.deepEqual(Object.keys(store.assets), [])
  assert.deepEqual(await assets.listProjectAssets(store.meta.id), [])
})

let backup: Blob
let backedUp: ProjectState
let originalBytes: Map<string, string>
await test('ZIP v1 往復で動画/画像/音声の全バイトと編集情報が一致する', async () => {
  await reset()
  originalBytes = new Map()
  for (const [name, mime] of [['sample.mp4', 'video/mp4'], ['picture.png', 'image/png'], ['voice.webm', 'audio/webm']]) {
    const file = new File([`original-${name}`], name, { type: mime })
    const asset = (await store.addAssetFromFile(file))!
    originalBytes.set(asset.id, await file.text())
    store.addClipFromAsset(asset.id)
  }
  store.addTextClip()
  store.addMarker(1, '復元テスト')
  backedUp = store.serialize()
  backup = await createBackupBlob(backedUp)
  const result = await importBackup(zipFile(backup))
  assert.deepEqual(result.project, backedUp)
  assert.equal(result.assetCount, 3)
  for (const [id, blob] of result.blobs) {
    assert.equal(await blob.text(), originalBytes.get(id))
    assert.equal(blob.type, backedUp.assets[id].mimeType)
  }
  const oldURL = (await store.getAssetURL(Object.keys(backedUp.assets)[0]))!
  const version = store.sessionVersion
  store.replaceState(result.project, result.blobs)
  store.markBackedUp()
  assert.equal(store.hasUnbackedUpChanges(), false)
  assert.equal(store.sessionVersion, version + 1)
  await assert.rejects(fetch(oldURL))
  for (const [id, content] of originalBytes) {
    assert.equal(await (await fetch((await store.getAssetURL(id))!)).text(), content)
  }
  store.undo()
  assert.deepEqual(store.serialize(), backedUp)
})

await test('従来の ZIP v1 配置を読み込める (同じコードの往復だけで検証しない)', async () => {
  const input: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify({ format: 'local-video-editor-backup', version: 1, projectId: backedUp.meta.id })),
    'project.json': strToU8(JSON.stringify(backedUp))
  }
  for (const [id, content] of originalBytes) input[`assets/${id}.originalext`] = strToU8(content)
  const result = await importBackup(zipFile(new Blob([zipSync(input)])))
  assert.deepEqual(result.project, backedUp)
  assert.equal(result.assetCount, originalBytes.size)
})

await test('構造が壊れた ZIP (重複素材・不正 JSON) は失敗し、編集中の作品と本体は無傷', async () => {
  const before = store.serialize()
  const source = unzipSync(new Uint8Array(await backup.arrayBuffer()))
  const assetPath = Object.keys(source).find(path => path.startsWith('assets/'))!
  const cases = [
    (files: Record<string, Uint8Array>) => { files[assetPath.replace(/\.[^.]+$/, '.dup')] = files[assetPath] },
    (files: Record<string, Uint8Array>) => { files['project.json'] = strToU8('{invalid') },
    (files: Record<string, Uint8Array>) => { delete files['manifest.json'] }
  ]
  for (const mutate of cases) {
    const files = { ...source }
    mutate(files)
    await assert.rejects(importBackup(zipFile(new Blob([zipSync(files)]))))
    assert.deepEqual(store.serialize(), before)
    for (const [id, content] of originalBytes) assert.equal(await (await assets.loadAssetBlob(store.meta.id, id))!.text(), content)
  }
  await assert.rejects(importBackup(zipFile(new Blob(['not a zip']))))
  assert.throws(() => store.replaceState(before, new Map()), /素材がありません/)
  assert.deepEqual(store.serialize(), before)
})

await test('旧版の不具合で素材欠損・参照切れがある ZIP も、該当クリップだけ外して復元できる', async () => {
  const before = store.serialize()
  const source = unzipSync(new Uint8Array(await backup.arrayBuffer()))
  const assetPath = Object.keys(source).find(path => path.startsWith('assets/'))!
  const missingId = assetPath.slice('assets/'.length).replace(/\.[^.]+$/, '')
  // 1) 素材ファイルが ZIP に無い
  {
    const files = { ...source }
    delete files[assetPath]
    const r = await importBackup(zipFile(new Blob([zipSync(files)])))
    assert.ok(!(missingId in r.project.assets))
    assert.ok(r.project.clips.every(c => !('assetId' in c) || c.assetId !== missingId))
    assert.ok(r.project.clips.length > 0, '他のクリップは残る')
    assert.match(r.warnings.join(), /バックアップに入っていなかった/)
    assert.equal(r.assetCount, originalBytes.size - 1)
  }
  // 2) トラック参照切れ・存在しない素材を指すクリップ
  {
    const files = { ...source }
    const p = structuredClone(before)
    p.clips[0].trackId = 'missing'
    ;(p.clips[1] as any).assetId = 'nope'
    files['project.json'] = strToU8(JSON.stringify(p))
    const r = await importBackup(zipFile(new Blob([zipSync(files)])))
    assert.equal(r.project.clips.length, p.clips.length - 2)
    assert.match(r.warnings.join(), /2 件/)
  }
  // 3) サイズ不一致 (壊れている可能性) は警告して読める分を使う
  {
    const files = { ...source, [assetPath]: new Uint8Array(0) }
    const r = await importBackup(zipFile(new Blob([zipSync(files)])))
    assert.equal(r.blobs.get(missingId)!.size, 0)
    assert.match(r.warnings.join(), /サイズが記録と違います/)
  }
  assert.deepEqual(store.serialize(), before, '読み込むだけでは現在の作品は変わらない')
})

await test('読めない素材があってもバックアップ全体は失敗させず、除外して知らせる', async () => {
  const [id] = Object.keys(store.assets)
  const name = store.assets[id].name
  // 元ファイルが移動・変更された File の代わり (読むと例外)
  class BrokenBlob extends Blob {
    stream(): ReadableStream<Uint8Array> {
      return new ReadableStream({ pull(c) { c.error(new DOMException('The blob could not be read', 'NotReadableError')) } })
    }
  }
  const original = (await assets.loadAssetBlob(store.meta.id, id))!
  assets.saveAssetBlob(store.meta.id, id, new BrokenBlob([await original.arrayBuffer()]))
  const built = await buildBackup(store.serialize())
  assert.deepEqual(built.skipped.map(a => a.name), [name])
  const r = await importBackup(zipFile(built.blob))
  assert.ok(!(id in r.project.assets))
  assert.equal(r.assetCount, originalBytes.size - 1)
  assets.saveAssetBlob(store.meta.id, id, original)
  // 素材本体がセッションに無い場合も同様に除外される
  assets.deleteAssetBlob(store.meta.id, id)
  assert.deepEqual((await buildBackup(store.serialize())).skipped.map(a => a.id), [id])
  assets.saveAssetBlob(store.meta.id, id, original)
})

await test('新しい ZIP は他の ZIP 実装 (fflate) でも読め、無圧縮で CRC が正しい', async () => {
  const blob = await createBackupBlob(store.serialize())
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  assert.ok(files['project.json'] && files['manifest.json'])
  for (const [id, content] of originalBytes) {
    const path = Object.keys(files).find(p => p.startsWith(`assets/${id}.`))!
    assert.equal(strFromU8(files[path]), content)
  }
  const entries = await readZipEntries(blob)
  assert.ok(entries.every(e => e.method === 0))
  for (const e of entries) assert.equal(e.crc, (await crc32OfBlob(await e.read())).crc)
})

await test('ZIP64 (4GB 超) 形式の書き込み・読み込みが往復でき、fflate でも読める', async () => {
  const data = [new Blob(['hello']), new Blob([new Uint8Array(70000).fill(7)]), new Blob([])]
  const zip = await buildStoredZip(data.map((d, i) => ({ name: `f${i}.bin`, data: d })), new Date(), true)
  const entries = await readZipEntries(zip)
  assert.deepEqual(entries.map(e => [e.name, e.size]), [['f0.bin', 5], ['f1.bin', 70000], ['f2.bin', 0]])
  assert.equal(await (await entries[0].read()).text(), 'hello')
  assert.equal((await entries[1].read()).size, 70000)
  const viaFflate = unzipSync(new Uint8Array(await zip.arrayBuffer()))
  assert.equal(strFromU8(viaFflate['f0.bin']), 'hello')
  assert.equal(viaFflate['f1.bin'].length, 70000)
  // 途中で切れたファイルは失敗として扱う
  await assert.rejects(readZipEntries(zip.slice(0, zip.size - 30)))
})

await test('ZIP 作成開始直後に作品を閉じても開始時点の全素材を保存できる', async () => {
  const result = await importBackup(zipFile(backup))
  store.replaceState(result.project, result.blobs)
  const exporting = createBackupBlob(store.serialize())
  await reset()
  const restored = await importBackup(zipFile(await exporting))
  assert.equal(restored.assetCount, originalBytes.size)
  for (const [id, blob] of restored.blobs) assert.equal(await blob.text(), originalBytes.get(id))
  assert.deepEqual(Object.keys(store.assets), [])
})

await test('素材なしのテキスト作品も保存/復元でき、バックアップ後の編集警告は維持', async () => {
  await reset()
  store.addTextClip()
  assert.equal(store.hasUnbackedUpChanges(), true)
  const snapshot = store.serialize()
  const result = await importBackup(zipFile(await createBackupBlob(snapshot)))
  assert.equal(result.assetCount, 0)
  store.replaceState(result.project, result.blobs)
  store.markBackedUp()
  assert.equal(store.hasUnbackedUpChanges(), false)
  store.addTextClip()
  assert.equal(store.hasUnbackedUpChanges(), true)
  store.undo()
  assert.equal(store.hasUnbackedUpChanges(), false)
})

await test('旧 DB 削除は指定名だけで、blocked でも非同期に起動を妨げない', async () => {
  const calls: string[] = []
  const request: Record<string, () => void> = {}
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    deleteDatabase(name: string) { calls.push(name); return request },
    open() { throw new Error('DB を新規作成してはいけない') }
  } })
  const statuses: CleanupStatus[] = []
  cleanupLegacyStorage(s => statuses.push(s))
  assert.deepEqual(calls, ['local-video-editor'])
  assert.deepEqual(statuses, [])
  request.onblocked()
  assert.deepEqual(statuses, ['blocked'])
  request.onsuccess()
  assert.deepEqual(statuses, ['blocked', 'deleted'])
  request.onerror()
  assert.equal(statuses.at(-1), 'failed')
})

await test('IndexedDB 使用不可/例外でも移行処理から例外を漏らさない', async () => {
  const statuses: CleanupStatus[] = []
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
  cleanupLegacyStorage(s => statuses.push(s))
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new Error('denied') } })
  cleanupLegacyStorage(s => statuses.push(s))
  assert.deepEqual(statuses, ['unavailable', 'failed'])
  // IndexedDB が使えなくても通常の編集・ZIP 保存/復元を継続できる。
  const asset = (await store.addAssetFromFile(imageFile()))!
  assert.ok(asset)
  const result = await importBackup(zipFile(await createBackupBlob(store.serialize())))
  assert.ok(result.blobs.has(asset.id))
})

await test('依存関係から idb を除去している', () => {
  for (const file of ['package.json', 'package-lock.json']) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /"(?:node_modules\/)?idb"/)
  }
})

await test('フリーズフレーム: 分割・静止画挿入・後続シフトを 1 回の Undo で戻せる', async () => {
  await reset()
  const video = (await store.addAssetFromFile(new File(['v'], 'clip.mp4', { type: 'video/mp4' })))!
  const clip = store.addClipFromAsset(video.id, { start: 0 })!
  store.updateClip(clip.id, { duration: 6, scale: 1.5, crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 } } as any)
  store.addTextClip({ start: 4 })
  const before = store.serialize()
  const still = (await store.insertFreezeFrame(clip.id, 2, new File(['png'], 'f.png', { type: 'image/png' }), 1.5))!
  assert.ok(still)
  const clips = store.state.clips
  const videos = clips.filter(c => c.kind === 'video').sort((a, b) => a.start - b.start)
  assert.equal(videos.length, 2)
  assert.equal(videos[0].duration, 2)
  assert.equal(videos[1].start, 3.5)
  assert.equal(videos[1].sourceIn, 2)
  assert.equal(still.start, 2)
  assert.equal(still.duration, 1.5)
  assert.equal(still.scale, 1.5)
  assert.deepEqual(still.crop, { left: 0.1, top: 0, right: 0.1, bottom: 0 })
  assert.equal(clips.find(c => c.kind === 'text')!.start, 5.5)
  assert.equal(store.getAsset(still.assetId)?.kind, 'image')
  assert.equal(await (await assets.loadAssetBlob(store.meta.id, still.assetId))!.text(), 'png')
  store.undo()
  await nextTick()
  assert.deepEqual(JSON.parse(JSON.stringify(store.state.clips)), before.clips)
  assert.deepEqual(Object.keys(store.assets), Object.keys(before.assets))
})

await test('字幕の読み込みは「字幕」トラックにテキストを並べ 1 回の Undo で戻る', async () => {
  await reset()
  const tracksBefore = store.state.tracks.length
  const n = store.importSubtitles([
    { start: 1, end: 2, text: 'いち' },
    { start: 3, end: 5, text: 'に\nさん' },
    { start: 6, end: 6, text: '長さ0は除外' },
    { start: 7, end: 8, text: '   ' }
  ])
  assert.equal(n, 2)
  const track = store.state.tracks.find(t => t.name === '字幕')!
  assert.ok(track)
  const topVideo = Math.max(...store.state.tracks.filter(t => t.kind === 'video' && t.id !== track.id).map(t => t.order))
  assert.ok(track.order > topVideo, '字幕トラックは一番手前')
  const texts = store.state.clips.filter(c => c.trackId === track.id)
  assert.deepEqual(texts.map(c => [c.start, c.duration, (c as any).text]), [[1, 1, 'いち'], [3, 2, 'に\nさん']])
  store.undo()
  assert.equal(store.state.tracks.length, tracksBefore)
  assert.equal(store.state.clips.length, 0)
  assert.equal(store.importSubtitles([]), 0)
})

await test('キャンバスサイズ変更は偶数に丸め、Undo でき、バックアップに残る', async () => {
  await reset()
  store.addTextClip()
  store.setCanvasSize(1080, 1921)
  assert.deepEqual([store.meta.width, store.meta.height], [1080, 1922])
  const result = await importBackup(zipFile(await createBackupBlob(store.serialize())))
  assert.deepEqual([result.project.meta.width, result.project.meta.height], [1080, 1922])
  store.undo()
  assert.deepEqual([store.meta.width, store.meta.height], [1920, 1080])
})

await test('トラック全体への適用は隣接するつなぎ目だけに 1 回の Undo で設定する', async () => {
  await reset()
  const track = store.tracks.find(t => t.kind === 'video')!.id
  const a = store.addTextClip({ start: 0, trackId: track })
  const b = store.addTextClip({ start: 3, trackId: track })
  const c = store.addTextClip({ start: 6.02, trackId: track })
  const d = store.addTextClip({ start: 12, trackId: track })
  store.updateClip(c.id, { duration: 0.4 } as any)
  const n = store.applyTransitionToTrack(track, { type: 'iris', duration: 0.8, overlap: true })
  assert.equal(n, 2)
  const get = (id: string) => store.getClip(id)!.transitionIn
  assert.equal(get(a.id), undefined)
  assert.deepEqual(get(b.id), { type: 'iris', duration: 0.8, overlap: true })
  assert.equal(get(c.id)!.duration, 0.4, '短いクリップに収まるよう短縮')
  assert.equal(get(d.id), undefined, '離れたクリップには入れない')
  store.undo()
  assert.equal(get(b.id), undefined)
  const other = store.tracks.find(t => t.kind === 'video' && t.id !== track)!.id
  store.addTextClip({ start: 0, trackId: other })
  assert.equal(store.applyTransitionToTrack(other, { type: 'fade', duration: 1 }), 0, '隣接クリップなし')
})

await test('速度カーブ付きクリップの分割で素材位置とカーブが連続する', async () => {
  await reset()
  const video = (await store.addAssetFromFile(new File(['v'], 'clip.mp4', { type: 'video/mp4' })))!
  const clip = store.addClipFromAsset(video.id, { start: 0 })!
  store.updateClip(clip.id, { duration: 4, sourceIn: 1, speedCurve: [{ x: 0, speed: 1 }, { x: 1, speed: 3 }] } as any)
  const rightId = store.splitClipAt(clip.id, 1)!
  const left = store.getClip(clip.id)!
  const right = store.getClip(rightId)!
  // 1s 目の速度 1.5、0..1s の消費 = (1 + 1.5) / 2 = 1.25
  assert.equal(right.sourceIn, 2.25)
  assert.deepEqual(left.speedCurve, [{ x: 0, speed: 1 }, { x: 1, speed: 1.5 }])
  assert.deepEqual(right.speedCurve, [{ x: 0, speed: 1.5 }, { x: 1, speed: 3 }])
  store.undo()
  assert.equal(store.state.clips.length, 1)
})

await test('テキストスタイル・背景ぼかしは複数クリップへ 1 回の Undo で適用できる', async () => {
  await reset()
  const track = store.tracks.find(t => t.kind === 'video')!.id
  const a = store.addTextClip({ start: 0, trackId: track })
  const b = store.addTextClip({ start: 3, trackId: track })
  store.updateClip(a.id, { x: 0.2, text: 'そのまま' } as any)
  assert.equal(store.applyTextStyle([a.id, b.id], 'neon-blue'), 2)
  const sa = store.getClip(a.id) as any
  assert.equal(sa.decor.outline.color, '#27d7ff')
  assert.equal(sa.x, 0.2)
  assert.equal(sa.text, 'そのまま')
  store.undo()
  assert.equal((store.getClip(b.id) as any).decor, undefined)
  assert.equal(store.applyTextStyle([a.id], 'no-such-style'), 0)

  const img = (await store.addAssetFromFile(imageFile()))!
  const c1 = store.addClipFromAsset(img.id, { start: 0 })!
  const c2 = store.addClipFromAsset(img.id, { start: 5 })!
  assert.equal(store.setBgFill([c1.id, c2.id, a.id], { blur: 30, dim: 0.1 }), 2, 'テキストは対象外')
  assert.deepEqual((store.getClip(c2.id) as any).bgFill, { blur: 30, dim: 0.1 })
  store.undo()
  assert.equal((store.getClip(c1.id) as any).bgFill, undefined)
})

await test('キーフレーム: 値の変更は「キーがあれば再生位置にキー、無ければ基準値」・緩急・全削除・分割・保存', async () => {
  await reset()
  const img = (await store.addAssetFromFile(imageFile()))!
  const c = store.addClipFromAsset(img.id, { start: 0 })!
  store.updateClip(c.id, { duration: 4 } as any)
  // キーが無い → 基準値 (親の effects も補う)
  store.setPlayhead(1)
  store.setAnimatable(c.id, { 'effects.blur': 5, x: 0.3 })
  let cur = store.getClip(c.id) as any
  assert.equal(cur.effects.blur, 5)
  assert.equal(cur.x, 0.3)
  assert.equal(cur.keyframes, undefined)
  // キーを 2 つ打ってから、別の位置で値を変える → その位置にキーが増える
  store.addKeyframe(c.id, 'effects.blur', { time: 0, value: 0, easing: 'linear' })
  store.addKeyframe(c.id, 'effects.blur', { time: 3, value: 30, easing: 'linear' })
  store.setPlayhead(2)
  store.setAnimatable(c.id, { 'effects.blur': 12 })
  cur = store.getClip(c.id) as any
  assert.deepEqual(cur.keyframes['effects.blur'].map((k: any) => [k.time, k.value]), [[0, 0], [2, 12], [3, 30]])
  assert.equal(cur.effects.blur, 5, '基準値はそのまま')
  // 範囲の上限で丸める
  store.setAnimatable(c.id, { 'effects.blur': 999 })
  assert.equal((store.getClip(c.id) as any).keyframes['effects.blur'][1].value, 50)
  // 緩急 (ベジェ) → 別の緩急に戻すと bezier は消える
  store.setKeyframeEasing(c.id, 'effects.blur', 2, 'bezier', [0.1, 0.9, 0.2, 1])
  assert.deepEqual((store.getClip(c.id) as any).keyframes['effects.blur'][1].bezier, [0.1, 0.9, 0.2, 1])
  store.setKeyframeEasing(c.id, 'effects.blur', 2, 'spring')
  const k = (store.getClip(c.id) as any).keyframes['effects.blur'][1]
  assert.equal(k.easing, 'spring')
  assert.equal(k.bezier, undefined)
  // 分割: パス指定のキーも左右に分かれ、境界に値が入る
  const rightId = store.splitClipAt(c.id, 1)!
  assert.ok((store.getClip(rightId) as any).keyframes['effects.blur'].length >= 2)
  store.undo()
  // 保存 → 復元でキーフレーム (緩急込み) が残る
  const r = await importBackup(zipFile(await createBackupBlob(store.serialize())))
  assert.equal(r.project.clips[0].keyframes!['effects.blur']![1].easing, 'spring')
  // 全削除: 再生位置の値を基準値として残す
  store.setPlayhead(2)
  store.clearKeyframes(c.id, 'effects.blur')
  cur = store.getClip(c.id) as any
  assert.equal(cur.keyframes, undefined)
  assert.equal(cur.effects.blur, 50)
})

await test('単語ハイライト字幕のスタイルは karaoke を設定し、持たないスタイルは既存設定を残す', async () => {
  await reset()
  const tx = store.addTextClip()
  store.applyTextStyle([tx.id], 'karaoke-pop')
  assert.equal((store.getClip(tx.id) as any).karaoke.mode, 'pop')
  store.applyTextStyle([tx.id], 'subtitle')
  assert.equal((store.getClip(tx.id) as any).karaoke.mode, 'pop', '字幕スタイルを当てても単語ハイライトは残る')
})

await reset()
console.log(`\n${passed} session regression tests passed.`)
