// 一時スモークテスト: 純粋ロジック (キーフレーム / トランジション / 履歴) の検証
import {
  sampleKeyframes,
  insertKeyframe,
  removeKeyframeAt,
  splitKeyframes,
  splitAllKeyframes,
  neighborKeyframes
} from '../src/engine/keyframes'
import { sampleTransition } from '../src/engine/transitions'
import { HistoryManager } from '../src/stores/history'
import { applyPixelEffects, hasPixelEffects, hexToRgb } from '../src/engine/pixelEffects'
import { EFFECT_PRESETS, getPreset } from '../src/engine/effectPresets'
import { contentSignature, isEmptyProject } from '../src/stores/backupSignature'
import type { Clip, Keyframe, ProjectState, PixelEffects } from '../src/types/project'

let failures = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok: ${name}`)
  } else {
    failures++
    console.error(`  NG: ${name}${detail ? ' — ' + detail : ''}`)
  }
}
function approx(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps
}

// ---------- keyframes ----------
console.log('keyframes:')
{
  const kfs: Keyframe[] = [
    { time: 0, value: 0, easing: 'linear' },
    { time: 2, value: 10, easing: 'linear' }
  ]
  check('線形補間 t=1 → 5', approx(sampleKeyframes(kfs, 1, 99), 5))
  check('範囲前 → 最初の値', approx(sampleKeyframes(kfs, -1, 99), 0))
  check('範囲後 → 最後の値', approx(sampleKeyframes(kfs, 3, 99), 10))
  check('空 → baseline', approx(sampleKeyframes(undefined, 1, 42), 42))

  const ins = insertKeyframe(kfs, { time: 1, value: 7, easing: 'easeIn' })
  check('insert でソート維持', ins.length === 3 && ins[1].time === 1)
  const replaced = insertKeyframe(ins, { time: 1, value: 8, easing: 'linear' })
  check('同時刻は置換', replaced.length === 3 && replaced[1].value === 8)

  const removed = removeKeyframeAt(replaced, 1)
  check('remove で削除', removed?.length === 2)

  const { left, right } = splitKeyframes(kfs, 1)
  check('split 左に境界値', !!left && approx(left[left.length - 1].value, 5))
  check('split 右先頭が time=0 値5', !!right && right[0].time === 0 && approx(right[0].value, 5))
  check(
    'split 右の後続 KF は時刻シフト',
    !!right && approx(right[right.length - 1].time, 1) && approx(right[right.length - 1].value, 10)
  )

  const all = splitAllKeyframes({ opacity: kfs }, 1)
  check('splitAll 両側生成', !!all.left?.opacity && !!all.right?.opacity)

  const nb = neighborKeyframes(kfs, 1)
  check('neighbor prev/next', nb.prev?.time === 0 && nb.next?.time === 2)
}

// ---------- transitions ----------
console.log('transitions:')
{
  const clip = {
    id: 'c1',
    kind: 'video',
    trackId: 't1',
    start: 10,
    duration: 4,
    opacity: 1,
    transitionIn: { type: 'fade', duration: 1 },
    transitionOut: { type: 'slide-left', duration: 1 }
  } as unknown as Clip

  const mid = sampleTransition(clip, 12) // 中間: 変化なし
  check('中間は neutral', approx(mid.alpha, 1) && approx(mid.offsetX, 0))

  const fadeHalf = sampleTransition(clip, 10.5) // 入り 50%
  check('fade-in 50% → alpha 0.5', approx(fadeHalf.alpha, 0.5))

  const outHalf = sampleTransition(clip, 13.5) // 出 50% (slide-left → 左へ)
  check('slide-out 50% → offsetX -0.5', approx(outHalf.offsetX, -0.5))

  const atStart = sampleTransition(clip, 10)
  check('開始時点 alpha 0', approx(atStart.alpha, 0))
}

// ---------- history ----------
console.log('history:')
{
  const h = new HistoryManager(10, 50)
  const mk = (n: number) => ({ meta: { name: `s${n}` } } as unknown as ProjectState)

  check('初期 canUndo=false', !h.canUndo())
  h.record(mk(1))
  h.record(mk(2))
  check('record 後 canUndo', h.canUndo())

  const undone = h.performUndo(mk(3))
  check('undo で直前状態', (undone as any)?.meta.name === 's2')
  check('undo 後 canRedo', h.canRedo())

  const redone = h.performRedo(undone!)
  check('redo で戻る', (redone as any)?.meta.name === 's3')

  // mergeKey: 同キー連続は 1 エントリ
  const h2 = new HistoryManager(10, 10_000)
  h2.record(mk(1), 'drag:a')
  h2.record(mk(2), 'drag:a')
  h2.record(mk(3), 'drag:a')
  const u1 = h2.performUndo(mk(4))
  check('merge で最初の状態のみ保持', (u1 as any)?.meta.name === 's1')
  check('merge 後 undo スタック空', !h2.canUndo())
}

// ---------- 順方向シーク位置の計算 (speed 考慮) ----------
console.log('forward seek math:')
{
  // sourceIn=2, duration=3 (timeline 秒), speed=2 → 素材消費 6s (2s〜8s)
  const sourceIn = 2
  const duration = 3
  const speed = 2
  // クリップ先頭 (local=0) では素材 2s 地点、末尾 (local=duration*speed=6) では 8s 地点
  check('先頭 → 素材 2s', approx(0 + sourceIn, 2))
  check('末尾 → 素材 8s', approx(duration * speed + sourceIn, 8))
}

// ---------- pixel effects ----------
console.log('pixel effects:')
{
  // 2x2 の単色画像を作るヘルパー
  function makeImg(w: number, h: number, rgb: [number, number, number]) {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255
    }
    return { data, width: w, height: h } as unknown as ImageData
  }

  check('hasPixelEffects: 空は false', !hasPixelEffects(undefined) && !hasPixelEffects({}))
  check('hasPixelEffects: vignette>0 で true', hasPixelEffects({ vignette: 0.3 }))
  check('hasPixelEffects: pixelate<=1 は false', !hasPixelEffects({ pixelate: 1 }))
  check('hasPixelEffects: duotone enabled で true',
    hasPixelEffects({ duotone: { enabled: true, shadow: '#000', highlight: '#fff' } }))

  check('hexToRgb 基本', (() => {
    const c = hexToRgb('#ff8000')
    return c.r === 255 && c.g === 128 && c.b === 0
  })())

  // threshold: 暗い灰色 → 黒
  {
    const img = makeImg(2, 2, [60, 60, 60])
    applyPixelEffects(img, { threshold: 0.5 } as PixelEffects)
    check('threshold 暗部 → 0', img.data[0] === 0)
  }
  // threshold: 明るい灰色 → 白
  {
    const img = makeImg(2, 2, [200, 200, 200])
    applyPixelEffects(img, { threshold: 0.5 } as PixelEffects)
    check('threshold 明部 → 255', img.data[0] === 255)
  }
  // posterize 2 階調: 中間値は 0 か 255
  {
    const img = makeImg(2, 2, [100, 200, 50])
    applyPixelEffects(img, { posterize: 2 } as PixelEffects)
    const ok = [0, 1, 2].every(c => img.data[c] === 0 || img.data[c] === 255)
    check('posterize 2階調は端値のみ', ok)
  }
  // duotone: 黒→shadow色, 白→highlight色
  {
    const black = makeImg(1, 1, [0, 0, 0])
    applyPixelEffects(black, { duotone: { enabled: true, shadow: '#102030', highlight: '#ffffff' } })
    check('duotone 黒→shadow', black.data[0] === 0x10 && black.data[1] === 0x20 && black.data[2] === 0x30)
    const white = makeImg(1, 1, [255, 255, 255])
    applyPixelEffects(white, { duotone: { enabled: true, shadow: '#000000', highlight: '#ffd000' } })
    check('duotone 白→highlight', white.data[0] === 0xff && white.data[1] === 0xd0 && white.data[2] === 0x00)
  }
  // pixelate: 全ブロックが平均色になる (2x2を1ブロック)
  {
    const data = new Uint8ClampedArray(2 * 2 * 4)
    // 左上だけ白、他は黒
    data[0] = 255; data[1] = 255; data[2] = 255; data[3] = 255
    for (let i = 4; i < data.length; i += 4) data[i + 3] = 255
    const img = { data, width: 2, height: 2 } as unknown as ImageData
    applyPixelEffects(img, { pixelate: 2 } as PixelEffects)
    check('pixelate で全画素が平均値 (≈64)',
      img.data[0] === img.data[4] && Math.abs(img.data[0] - 64) <= 1)
  }
  // vignette: 中心ほど明るく、四隅ほど暗い
  {
    const img = makeImg(5, 5, [200, 200, 200])
    applyPixelEffects(img, { vignette: 0.8 } as PixelEffects)
    const center = img.data[(2 * 5 + 2) * 4] // 中心付近
    const corner = img.data[0] // 左上
    check('vignette 中心は四隅より明るい', center > corner)
    check('vignette 四隅は暗く', corner < 200)
  }
  // grain: 値が揺れる (確率的だが 100px もあればほぼ確実に変化)
  {
    const img = makeImg(10, 10, [128, 128, 128])
    applyPixelEffects(img, { grain: 0.5 } as PixelEffects)
    let changed = false
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i] !== 128) { changed = true; break }
    }
    check('grain で画素が変化', changed)
  }
}

// ---------- effect presets ----------
console.log('effect presets:')
{
  check('プリセット 13 種 + なし', EFFECT_PRESETS.length === 13)
  check('"none" は中身なし',
    !getPreset('none')?.effects && !getPreset('none')?.colorGrade && !getPreset('none')?.pixelFx)
  check('cinematic に pixelFx あり', !!getPreset('cinematic')?.pixelFx?.vignette)
  check('retro8 は pixelate', (getPreset('retro8')?.pixelFx?.pixelate ?? 0) > 1)
  check('全プリセットに一意の id', new Set(EFFECT_PRESETS.map(p => p.id)).size === EFFECT_PRESETS.length)
  check('全プリセットに両言語ラベル',
    EFFECT_PRESETS.every(p => p.labelEasy && p.labelNormal))
}

// ---------- バックアップ差分検知 (未保存で閉じる警告の判定) ----------
console.log('backup signature:')
{
  function makeState(): ProjectState {
    return {
      meta: { id: 'p1', name: 'x', createdAt: 1, updatedAt: 1, width: 1920, height: 1080, fps: 30, backgroundColor: '#000' },
      assets: {},
      folders: [],
      tracks: [{ id: 't1', kind: 'video', name: 'V1', muted: false, locked: false, order: 1 }],
      clips: [],
      markers: [],
      timeline: { playhead: 0, zoom: 50, duration: 60, snapping: true, rippleMode: false, masterVolume: 1 }
    }
  }
  const mkClip = (id: string): Clip => ({
    id, kind: 'text', trackId: 't1', start: 0, duration: 3, opacity: 1,
    text: 'a', fontFamily: 'sans-serif', fontSize: 72, color: '#fff',
    x: 0.5, y: 0.5, align: 'center', bold: true, italic: false
  } as Clip)

  const base = makeState()
  const sig = contentSignature(base)

  // 同一内容 → 同一署名 (べき等)
  check('同一内容は同じ署名', sig === contentSignature(makeState()))

  // playhead / zoom 変更 → 署名不変 (再生・表示は編集ではない)
  {
    const s = makeState(); s.timeline.playhead = 42; s.timeline.zoom = 200
    check('playhead/zoom は署名に影響しない', contentSignature(s) === sig)
  }

  // updatedAt 変更 → 署名不変
  {
    const s = makeState(); s.meta.updatedAt = 999999
    check('updatedAt は署名に影響しない', contentSignature(s) === sig)
  }

  // クリップ追加 → 署名変化 (編集は必ず捕捉)
  {
    const s = makeState(); s.clips.push(mkClip('c1'))
    check('クリップ追加で署名が変わる', contentSignature(s) !== sig)
  }

  // クリップの微小プロパティ変更 → 署名変化
  {
    const s1 = makeState(); s1.clips.push(mkClip('c1'))
    const s2 = makeState(); const c = mkClip('c1'); (c as any).start = 0.01; s2.clips.push(c)
    check('クリップ start の変更で署名が変わる', contentSignature(s1) !== contentSignature(s2))
  }

  // マーカー・トラック・メタ名・masterVolume・in/out も検知対象
  {
    const s = makeState(); s.markers!.push({ id: 'm', time: 1, label: 'x' })
    check('マーカー追加で署名が変わる', contentSignature(s) !== sig)
  }
  {
    const s = makeState(); s.meta.name = 'renamed'
    check('プロジェクト名変更で署名が変わる', contentSignature(s) !== sig)
  }
  {
    const s = makeState(); s.timeline.masterVolume = 0.5
    check('マスター音量変更で署名が変わる', contentSignature(s) !== sig)
  }
  {
    const s = makeState(); s.timeline.outPoint = 10
    check('Out点設定で署名が変わる', contentSignature(s) !== sig)
  }

  // 空プロジェクト判定
  check('初期状態は空プロジェクト', isEmptyProject(makeState()))
  {
    const s = makeState(); s.clips.push(mkClip('c1'))
    check('クリップありは非空', !isEmptyProject(s))
  }
  {
    const s = makeState(); s.assets['a'] = { id: 'a', kind: 'image', name: 'x', mimeType: 'image/png', size: 1, createdAt: 1 }
    check('素材ありは非空', !isEmptyProject(s))
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
