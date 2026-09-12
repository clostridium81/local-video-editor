// セッション素材・実ストア・ZIP の回帰テスト。DOM のメタデータ読み込みだけを代替する。
// ブラウザの実デコード/録画/エンコードはこのテストの対象外。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { zipSync, unzipSync, strToU8 } from 'fflate'
import * as assets from '../src/persistence/assetStore'
import { cleanupLegacyStorage, type CleanupStatus } from '../src/persistence/legacyCleanup'
import { createBackupBlob, importBackup } from '../src/persistence/backup'
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

await test('欠損/破損/重複素材/不正参照の ZIP は失敗し、編集中の作品と本体は無傷', async () => {
  const before = store.serialize()
  const source = unzipSync(new Uint8Array(await backup.arrayBuffer()))
  const assetPath = Object.keys(source).find(path => path.startsWith('assets/'))!
  const cases = [
    (files: Record<string, Uint8Array>) => { delete files[assetPath] },
    (files: Record<string, Uint8Array>) => { files[assetPath] = new Uint8Array(0) },
    (files: Record<string, Uint8Array>) => { files[assetPath.replace(/\.[^.]+$/, '.dup')] = files[assetPath] },
    (files: Record<string, Uint8Array>) => { const p = structuredClone(before); p.clips[0].trackId = 'missing'; files['project.json'] = strToU8(JSON.stringify(p)) },
    (files: Record<string, Uint8Array>) => { files['project.json'] = strToU8('{invalid') }
  ]
  for (const mutate of cases) {
    const files = { ...source }
    mutate(files)
    await assert.rejects(importBackup(zipFile(new Blob([zipSync(files)]))))
    assert.deepEqual(store.serialize(), before)
    for (const [id, content] of originalBytes) assert.equal(await (await assets.loadAssetBlob(store.meta.id, id))!.text(), content)
  }
  assert.throws(() => store.replaceState(before, new Map()), /素材がありません/)
  assert.deepEqual(store.serialize(), before)
})

await test('素材不足の ZIP 作成は成功扱いにしない', async () => {
  const id = Object.keys(store.assets)[0]
  assets.deleteAssetBlob(store.meta.id, id)
  await assert.rejects(createBackupBlob(store.serialize()), /素材が見つかりません/)
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

await reset()
console.log(`\n${passed} session regression tests passed.`)
