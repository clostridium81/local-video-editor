// 実際の PreviewEngine/FrameSource とセッション素材の接続を検証する。
// DOM/Canvas は呼び出し記録用の代替。画素・音・実コーデック品質の検証ではない。
import assert from 'node:assert/strict'
import { PreviewEngine, getActiveEngine } from '../src/engine/previewEngine'
import { createFrameSourceForClip, ExportMediaCache } from '../src/engine/frameSource'
import { replaceSessionAssets, clearAllData } from '../src/persistence/assetStore'
import type { ProjectState } from '../src/types/project'

Object.defineProperty(globalThis, 'indexedDB', { get() { throw new Error('IndexedDB must not be used') } })
const elements: MediaElement[] = []
let deferLoads = false
const loads: Array<() => void> = []
class MediaElement extends EventTarget {
  complete = false
  naturalWidth = 320
  naturalHeight = 180
  videoWidth = 320
  videoHeight = 180
  paused = true
  private url = ''
  private time = 0
  constructor(readonly kind = 'image') { super(); elements.push(this) }
  get src() { return this.url }
  set src(value: string) {
    this.url = value
    if (!value) return
    const done = () => {
      this.complete = true
      this.dispatchEvent(new Event(this.kind === 'image' ? 'load' : 'loadeddata'))
    }
    if (deferLoads) loads.push(done)
    else queueMicrotask(done)
  }
  get currentTime() { return this.time }
  set currentTime(value: number) { this.time = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))) }
  removeAttribute(name: string) { if (name === 'src') this.url = '' }
  pause() { this.paused = true }
  async play() { this.paused = false }
  load() {}
}
const draws: MediaElement[] = []
function canvas() {
  const ctx = new Proxy({ drawImage: (source: MediaElement) => draws.push(source) }, {
    get(target, key) { return (target as any)[key] ?? (() => {}) }
  })
  return { width: 320, height: 180, getContext: () => ctx } as unknown as HTMLCanvasElement
}
Object.assign(globalThis, {
  document: { createElement: (tag: string) => tag === 'canvas' ? canvas() : new MediaElement(tag) },
  Image: MediaElement
})

function fixture(kinds = ['image', 'video', 'audio']): ProjectState {
  const project: ProjectState = {
    meta: { id: 'same-project', name: 'test', width: 320, height: 180, fps: 30, backgroundColor: '#000000', createdAt: 1, updatedAt: 1 },
    assets: {}, clips: [],
    tracks: [
      { id: 'v', kind: 'video', name: 'V1', muted: false, locked: false, order: 1 },
      { id: 'a', kind: 'audio', name: 'A1', muted: false, locked: false, order: 0 }
    ],
    timeline: { playhead: 0, duration: 2, zoom: 50 }
  }
  for (const kind of kinds) {
    project.assets[kind] = { id: kind, kind: kind as any, name: kind, mimeType: `${kind}/test`, size: kind.length, createdAt: 1 }
    project.clips.push({ id: `${kind}-clip`, kind, assetId: kind, trackId: kind === 'audio' ? 'a' : 'v', start: 0, duration: 2, opacity: 1, x: 0.5, y: 0.5, scale: 1, rotation: 0 } as any)
  }
  return project
}
function setSources(project: ProjectState, suffix = '') {
  replaceSessionAssets(project.meta.id, new Map(Object.keys(project.assets).map(id => [id, new Blob([id + suffix])])))
}
let passed = 0
async function test(name: string, run: () => Promise<void>) {
  draws.length = 0
  elements.length = 0
  await run()
  passed++
  console.log(`  ok: ${name}`)
}

await test('画像/動画プレビュー・音声要素がセッションの正しい素材 URL を使う', async () => {
  const state = fixture()
  setSources(state)
  const engine = new PreviewEngine(canvas(), state)
  await engine.renderCurrent()
  assert.deepEqual(draws.map(el => el.kind), ['image', 'video'])
  for (const el of elements) assert.equal(await (await fetch(el.src)).text(), el.kind)
  assert.deepEqual(elements.map(el => el.kind).sort(), ['audio', 'image', 'video'])
  engine.dispose()
  assert.ok(elements.every(el => el.src === '' && el.paused))
  assert.equal(getActiveEngine(), null)
})

await test('削除した画像のキャッシュを解放し Undo 相当の状態復元後に再読み込みする', async () => {
  const state = fixture(['image'])
  setSources(state)
  const engine = new PreviewEngine(canvas(), state)
  await engine.renderCurrent()
  const first = elements[0]
  engine.setState({ ...state, assets: {}, clips: [] })
  assert.equal(first.src, '')
  engine.setState(state)
  await engine.renderCurrent()
  assert.equal(elements.length, 2)
  assert.equal(await (await fetch(elements[1].src)).text(), 'image')
  engine.dispose()
})

await test('素材 URL の取得待ちで破棄したエンジンはメディア要素を作らない', async () => {
  const state = fixture()
  setSources(state)
  const engine = new PreviewEngine(canvas(), state)
  const pending = engine.renderCurrent()
  engine.dispose()
  await pending
  assert.equal(elements.length, 0)
  assert.equal(draws.length, 0)
})

await test('画像ロード待ちで破棄しても読み込み完了後に描画・参照保持しない', async () => {
  const state = fixture(['image'])
  setSources(state)
  const engine = new PreviewEngine(canvas(), state)
  deferLoads = true
  const pending = engine.renderCurrent()
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(elements.length, 1)
  engine.dispose()
  assert.equal(elements[0].src, '')
  loads.splice(0).forEach(done => done())
  await pending
  deferLoads = false
  assert.equal(draws.length, 0)
})

await test('同じ作品/素材/クリップ ID の復元でも新エンジンは新しい素材を描画する', async () => {
  const state = fixture(['image'])
  setSources(state, '-old')
  const oldEngine = new PreviewEngine(canvas(), state)
  await oldEngine.renderCurrent()
  const oldURL = elements[0].src
  setSources(state, '-new')
  const engine = new PreviewEngine(canvas(), state)
  oldEngine.dispose()
  assert.equal(getActiveEngine(), engine)
  await oldEngine.renderCurrent()
  await engine.renderCurrent()
  assert.equal(await (await fetch(draws.at(-1)!.src)).text(), 'image-new')
  await assert.rejects(fetch(oldURL))
  engine.dispose()
})

await test('動画書き出しの FrameSource がセッション素材を読み込み、シーク/終了できる', async () => {
  const state = fixture(['video'])
  setSources(state)
  const cache = new ExportMediaCache(state.meta.id)
  const result = await createFrameSourceForClip({ projectId: state.meta.id, assetId: 'video', speed: 1, timestamps: [0, 0.25], cache, activeDecoders: 0 })
  assert.equal(result?.kind, 'element')
  const frame = await result!.source.getFrameAt(0.25)
  assert.equal(frame!.width, 320)
  const el = frame!.image as unknown as MediaElement
  assert.equal(el.currentTime, 0.25)
  assert.equal(await (await fetch(el.src)).text(), 'video')
  result!.source.close()
  assert.equal(el.src, '')
  cache.closeAll()
})

clearAllData()
console.log(`\n${passed} preview/source integration tests passed (mock DOM, no real codec).`)
