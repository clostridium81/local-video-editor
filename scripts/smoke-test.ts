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
import {
  mapClipTimeToSource,
  isClipActiveAt,
  clipSourceTimestamps,
  selectSourceKind
} from '../src/engine/frameTiming'
import { ExportProfiler } from '../src/engine/exportProfiler'
import { sampleAudioFade } from '../src/engine/transitions'
import {
  computeEffective,
  cropRect,
  normalizeCrop,
  visualDrawSize,
  pxUnit,
  drawClip,
  LayerBuffer
} from '../src/engine/renderer'
import { parseSubtitles, toSrt, toVtt, textClipsToCues } from '../src/engine/subtitles'
import { avcCodecFor } from '../src/engine/capabilities'
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
  const mk = (n: number) => ({ meta: { name: `s${n}` }, assets: {} } as unknown as ProjectState)

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
  const clip = { start: 10, duration: 3, sourceIn: 2, speed: 2 }
  check('先頭 → 素材 2s', approx(mapClipTimeToSource(clip, 10), 2))
  check('中間 → 素材 5s', approx(mapClipTimeToSource(clip, 11.5), 5))
  check('末尾 → 素材 8s', approx(mapClipTimeToSource(clip, 13), 8))
  check('speed 省略 = 1', approx(mapClipTimeToSource({ start: 10, duration: 3 }, 11), 1))
  check('sourceIn 省略 = 0', approx(mapClipTimeToSource({ start: 10, duration: 3, speed: 0.5 }, 12), 1))
  // 逆再生 (speed<0) でも式自体は成立する (負方向に進む)
  check('speed<0 は素材時刻が減少', mapClipTimeToSource({ start: 0, duration: 4, sourceIn: 8, speed: -1 }, 2) < 8)
}

// ---------- エクスポートのフレームスケジュール ----------
console.log('frame timing:')
{
  const clip = { start: 1, duration: 2, sourceIn: 0.5, speed: 1 }
  check('開始前は非アクティブ', !isClipActiveAt(clip, 0.99))
  check('開始時刻はアクティブ', isClipActiveAt(clip, 1))
  check('終了時刻 (排他) は非アクティブ', !isClipActiveAt(clip, 3))

  // rangeStart=0, fps=10, totalFrames=50 (5秒) → クリップは t=1.0〜2.9 の 20 フレーム
  const plan = clipSourceTimestamps(clip, 0, 10, 50)
  check('plan あり', plan !== null)
  if (plan) {
    check('最初のフレーム番号 = 10', plan.firstFrameIndex === 10)
    check('フレーム数 = 20', plan.timestamps.length === 20)
    check('先頭タイムスタンプ = sourceIn', approx(plan.timestamps[0], 0.5))
    check('末尾タイムスタンプ = sourceIn + 1.9', approx(plan.timestamps[19], 2.4))
    const monotonic = plan.timestamps.every((v, i, a) => i === 0 || v >= a[i - 1])
    check('単調非減少', monotonic)
  }

  // speed=2 + sourceIn: メインループと同じ式で素材時刻が進む
  const plan2 = clipSourceTimestamps({ start: 0, duration: 1, sourceIn: 3, speed: 2 }, 0, 10, 10)
  check('speed=2: 2 倍で進む', !!plan2 && approx(plan2.timestamps[5], 3 + 0.5 * 2))

  // 範囲とまったく重ならないクリップ
  check('範囲外クリップは null', clipSourceTimestamps({ start: 100, duration: 5 }, 0, 10, 50) === null)

  // 範囲の途中から始まるエクスポート (rangeStart>0)
  const plan3 = clipSourceTimestamps({ start: 0, duration: 10, sourceIn: 0 }, 4, 10, 10)
  check('rangeStart オフセット反映', !!plan3 && plan3.firstFrameIndex === 0 && approx(plan3.timestamps[0], 4))

  // 負のタイムスタンプは 0 にクランプ (<video> と同じ挙動)
  const plan4 = clipSourceTimestamps({ start: 0, duration: 2, sourceIn: -1 }, 0, 10, 5)
  check('負の素材時刻は 0 クランプ', !!plan4 && plan4.timestamps[0] === 0)
}

// ---------- フレーム供給元の選定 ----------
console.log('source kind selection:')
{
  const base = {
    hasDecoder: true,
    parsedOk: true,
    canDecode: true,
    speed: 1,
    activeDecoders: 0,
    maxDecoders: 4
  }
  check('全条件 OK → decoder', selectSourceKind(base) === 'decoder')
  check('VideoDecoder なし → element', selectSourceKind({ ...base, hasDecoder: false }) === 'element')
  check('パース失敗 → element', selectSourceKind({ ...base, parsedOk: false }) === 'element')
  check('コーデック非対応 → element', selectSourceKind({ ...base, canDecode: false }) === 'element')
  check('逆再生 → element', selectSourceKind({ ...base, speed: -1 }) === 'element')
  check('speed 0 → element', selectSourceKind({ ...base, speed: 0 }) === 'element')
  check('高速でも順方向なら decoder', selectSourceKind({ ...base, speed: 8 }) === 'decoder')
  check('デコーダ上限到達 → element', selectSourceKind({ ...base, activeDecoders: 4 }) === 'element')
}

// ---------- エクスポートプロファイラ ----------
console.log('export profiler:')
{
  let now = 0
  const p = new ExportProfiler({ now: () => now })
  p.begin('a')
  now = 10
  p.end('a')
  p.begin('a')
  now = 25
  p.end('a')
  p.add('b', 5)
  const s = p.summary()
  check('累積 totalMs', approx(s.a.totalMs, 25))
  check('回数カウント', s.a.count === 2)
  check('平均', approx(s.a.avgMs, 12.5))
  check('add 直接加算', approx(s.b.totalMs, 5) && s.b.count === 1)
  check('begin なしの end は無視', (() => { p.end('zzz'); return !('zzz' in p.summary()) })())
  check('elapsedMs', approx(p.elapsedMs(), 25))
  check('oneLine に区間名', p.oneLine().includes('a '))
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


// ---------- v0.6: 追加トランジション ----------
console.log('transitions (v0.6):')
{
  const mk = (tin: string, tout = 'fade') => ({
    id: 'c', kind: 'video', trackId: 't', start: 0, duration: 4, opacity: 1,
    transitionIn: { type: tin, duration: 1 }, transitionOut: { type: tout, duration: 1 }
  } as unknown as Clip)

  const iris = sampleTransition(mk('iris'), 0.5)
  check('iris 50% → 円 r=0.5', iris.reveal?.kind === 'circle' && approx((iris.reveal as any).r, 0.5))
  const wipeRtl = sampleTransition(mk('wipe-rtl'), 0.25)
  check('wipe-rtl 25% → 右端 25% だけ表示',
    wipeRtl.reveal?.kind === 'rect' && approx((wipeRtl.reveal as any).x0, 0.75) && approx((wipeRtl.reveal as any).x1, 1))
  const split = sampleTransition(mk('split'), 0.5)
  check('split 50% → 中央 0.25..0.75',
    split.reveal?.kind === 'rect' && approx((split.reveal as any).x0, 0.25) && approx((split.reveal as any).x1, 0.75))
  const wipe = sampleTransition(mk('wipe'), 0.5)
  check('wipe (従来) 50% → 左半分', wipe.reveal?.kind === 'rect' && approx((wipe.reveal as any).x1, 0.5))
  const spinIn = sampleTransition(mk('spin', 'spin'), 0.5)
  const spinOut = sampleTransition(mk('spin', 'spin'), 3.5)
  check('spin 入り/出で回転方向が逆', spinIn.rotation > 0 && spinOut.rotation < 0)
  check('blur 入り開始時はぼかし最大', approx(sampleTransition(mk('blur'), 0).blur, 30))
  check('flash 入り開始時は明るさ 5 倍', approx(sampleTransition(mk('flash'), 0).brightness, 5))
  check('zoom-out 入り開始時は 1.6 倍', approx(sampleTransition(mk('zoom-out'), 0).scale, 1.6))
  check('中間は reveal なし', sampleTransition(mk('iris'), 2).reveal === null)
  const slideOut = sampleTransition(mk('fade', 'slide-right'), 3.5)
  check('slide-right の出は右へ抜ける', approx(slideOut.offsetX, 0.5))
}

// ---------- v0.6: 音声フェード ----------
console.log('audio fade:')
{
  const clip = { start: 10, duration: 4, opacity: 1, volume: 0.8, audioFade: { in: 1, out: 2 } } as unknown as Clip
  check('フェードイン 50%', approx(sampleAudioFade(clip, 0.5), 0.5))
  check('中間は 1', approx(sampleAudioFade(clip, 1.5), 1))
  check('フェードアウト残り 1s → 0.5', approx(sampleAudioFade(clip, 3), 0.5))
  check('末尾は 0', approx(sampleAudioFade(clip, 4), 0))
  check('audioFade なしは常に 1', approx(sampleAudioFade({ duration: 4 } as Clip, 0), 1))
  const { eff } = computeEffective(clip, 10.5)
  check('computeEffective の音量に反映 (0.8 × 0.5)', approx(eff.volume, 0.4))
  const withTrans = { ...clip, transitionIn: { type: 'fade', duration: 1 } } as unknown as Clip
  check('トランジション fade と掛け合わせ (0.8 × 0.5 × 0.5)', approx(computeEffective(withTrans, 10.5).eff.volume, 0.2))
}

// ---------- v0.6: クロップ / 表示サイズ ----------
console.log('crop geometry:')
{
  const r = cropRect({ left: 0.25, right: 0.25, top: 0, bottom: 0.5 }, 1920, 1080)
  check('cropRect ピクセル矩形', approx(r.sx, 480) && approx(r.sw, 960) && approx(r.sy, 0) && approx(r.sh, 540))
  check('crop なしは全体', cropRect(undefined, 100, 50).sw === 100)
  const n = normalizeCrop({ left: 0.7, right: 0.7, top: -1, bottom: NaN })
  check('normalizeCrop: 対辺合計 ≤ 0.95 / 負・NaN は 0',
    approx(n.left + n.right, 0.95) && n.top === 0 && n.bottom === 0)
  // 16:9 の中央 9:16 を切り抜いて 9:16 キャンバスに置くと全面を覆う
  const side = (1 - (1080 * 9) / 16 / 1920) / 2
  const size = visualDrawSize(1920, 1080, { left: side, right: side, top: 0, bottom: 0 }, 1080, 1920, 1)
  check('縦長キャンバスに中央切り抜きが全面フィット', approx(size.w, 1080, 1e-3) && approx(size.h, 1920, 1e-3))
  const plain = visualDrawSize(1920, 1080, undefined, 1080, 1920, 2)
  check('切り抜きなし 16:9 → 9:16 は幅合わせ × scale', approx(plain.w, 2160) && approx(plain.h, 1215))
  check('pxUnit: 1080p=1 / 縦長=1 / 720p=0.667',
    approx(pxUnit(1920, 1080), 1) && approx(pxUnit(1080, 1920), 1) && approx(pxUnit(1280, 720), 2 / 3))
}

// ---------- v0.6: 描画呼び出し (記録用 ctx) ----------
console.log('renderer calls:')
{
  const calls: Array<{ fn: string; args: any[] }> = []
  const makeCtx = () => new Proxy({} as any, {
    get(target, key) {
      if (key in target) return target[key]
      if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) =>
        ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
      if (key === 'measureText') return (s: string) => ({ width: s.length * 10 })
      return (...args: any[]) => { calls.push({ fn: String(key), args }) }
    },
    set(target, key, v) { target[key] = v; calls.push({ fn: `set:${String(key)}`, args: [v] }); return true }
  })
  ;(globalThis as any).document = {
    createElement: () => ({ width: 1, height: 1, getContext: () => makeCtx() })
  }
  const ctx = makeCtx()
  const target = { ctx, width: 1080, height: 1920, buffer: new LayerBuffer() }
  const src = { src: { tag: 'video' } as any, width: 1920, height: 1080 }
  const base = { id: 'v', kind: 'video', trackId: 't', assetId: 'a', start: 0, duration: 2, opacity: 1, x: 0.5, y: 0.5, scale: 1, rotation: 0 }

  calls.length = 0
  drawClip(target, { ...base, crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 } } as Clip, 1, src)
  const crop9 = calls.find(c => c.fn === 'drawImage')
  check('クロップ時は元画像の部分矩形を描く (9 引数)', crop9?.args.length === 9 && approx(crop9.args[1], 480) && approx(crop9.args[3], 960))

  calls.length = 0
  drawClip(target, { ...base, mask: { shape: 'ellipse', x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0, feather: 0, invert: true } } as Clip, 1, src)
  check('マスクは destination-out (反転) で合成', calls.some(c => c.fn === 'set:globalCompositeOperation' && c.args[0] === 'destination-out'))
  check('マスク楕円を描く', calls.some(c => c.fn === 'ellipse'))
  const draws = calls.filter(c => c.fn === 'drawImage')
  check('マスク時はバッファ経由で 2 回 drawImage', draws.length === 2 && draws[0].args[0] === src.src)

  calls.length = 0
  drawClip(target, { ...base, effects: { brightness: 1.5 }, transitionIn: { type: 'iris', duration: 1 } } as Clip, 0.5, src)
  check('iris は円でクリップする', calls.some(c => c.fn === 'arc') && calls.some(c => c.fn === 'clip'))
  check('レイヤー不要時はエフェクトのフィルタを直接掛ける',
    calls.some(c => c.fn === 'set:filter' && String(c.args[0]).includes('brightness(1.5)')))

  calls.length = 0
  drawClip(target, { ...base, pixelFx: { vignette: 0.5 }, effects: { brightness: 1.5 } } as Clip, 1, src)
  const filterSets = calls.filter(c => c.fn === 'set:filter').map(c => String(c.args[0]))
  check('ピクセル処理時はエフェクトのフィルタを二重に掛けない',
    filterSets.filter(f => f.includes('brightness(1.5)')).length === 1)

  calls.length = 0
  const text = {
    id: 'tx', kind: 'text', trackId: 't', start: 0, duration: 2, opacity: 1, text: 'あいう\nえお',
    fontFamily: 'sans-serif', fontSize: 60, color: '#fff', x: 0.5, y: 0.5, align: 'center', bold: false, italic: false
  } as Clip
  drawClip(target, text, 1, null)
  const fills = calls.filter(c => c.fn === 'fillText')
  check('改行で 2 行に分けて描く', fills.length === 2 && fills[0].args[0] === 'あいう' && fills[1].args[0] === 'えお')
  check('2 行は行の中心を挟んで上下に並ぶ', approx(fills[0].args[2], -39) && approx(fills[1].args[2], 39))
}

// ---------- v0.6: 字幕 (SRT / VTT) ----------
console.log('subtitles:')
{
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nこんにちは\r\n<i>世界</i>\r\n\r\n2\r\n00:01:00,05 --> 00:01:01,000\r\n二つ目\r\n\r\n3\r\n00:00:05,000 --> 00:00:04,000\r\n逆転は無視\r\n'
  const cues = parseSubtitles(srt)
  check('SRT 2 件 (時刻逆転は除外)', cues.length === 2)
  check('SRT 時刻と複数行テキスト', approx(cues[0].start, 1) && approx(cues[0].end, 2.5) && cues[0].text === 'こんにちは\n世界')
  check('ミリ秒 2 桁は右ゼロ埋め (,05 → 0.05)', approx(cues[1].start, 60.05))
  const vtt = 'WEBVTT\n\nNOTE メモ\n\ncue-1\n01:02.500 --> 01:04.000 align:start\nVTT の字幕\n'
  const v = parseSubtitles(vtt)
  check('VTT: 時省略・識別子・設定を読み飛ばす', v.length === 1 && approx(v[0].start, 62.5) && v[0].text === 'VTT の字幕')
  const round = parseSubtitles(toSrt(cues))
  check('SRT 書き出し → 読み込みで一致', JSON.stringify(round) === JSON.stringify(cues))
  check('SRT 書式', toSrt(cues).startsWith('1\n00:00:01,000 --> 00:00:02,500\nこんにちは\n世界\n\n2\n'))
  check('VTT 書式', toVtt(cues).startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n'))
  const clips = [
    { id: 'a', kind: 'text', trackId: 't1', start: 5, duration: 2, text: ' B ' },
    { id: 'b', kind: 'text', trackId: 't1', start: 1, duration: 2, text: 'A' },
    { id: 'c', kind: 'text', trackId: 't2', start: 3, duration: 1, text: '' },
    { id: 'd', kind: 'shape', trackId: 't1', start: 0, duration: 9 }
  ] as unknown as Clip[]
  const out = textClipsToCues(clips)
  check('テキストクリップ → 字幕 (空文字・図形は除外, 時刻順, trim)',
    out.length === 2 && out[0].text === 'A' && out[1].text === 'B')
  const ranged = textClipsToCues(clips, { rangeStart: 2, rangeEnd: 6 })
  check('範囲指定で時刻を詰めて切り詰める',
    approx(ranged[0].start, 0) && approx(ranged[0].end, 1) && approx(ranged[1].start, 3) && approx(ranged[1].end, 4))
}

// ---------- v0.6: H.264 Level 選択 ----------
console.log('avc level:')
{
  check('1080p30 → Level 4.0', avcCodecFor(1920, 1080, 30) === 'avc1.640028')
  check('1080p60 → Level 4.2', avcCodecFor(1920, 1080, 60) === 'avc1.64002A')
  check('縦 1080×1920 30fps → Level 4.0 (8160MB ≤ 8192)', avcCodecFor(1080, 1920, 30) === 'avc1.640028')
  check('21:9 2560×1080 → Level 5.0', avcCodecFor(2560, 1080, 30) === 'avc1.640032')
  check('4K60 → Level 5.2', avcCodecFor(3840, 2160, 60) === 'avc1.640034')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
