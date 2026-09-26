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
import { PositionedBlobWriter } from '../src/engine/positionedBlob'
import * as Mp4 from 'mp4-muxer'
import * as Webm from 'webm-muxer'
import {
  preRoll,
  visualStart,
  compareDrawOrder,
  speedAt,
  sourceAdvance,
  clipSourceSpan,
  splitSpeedCurve,
  trimSpeedCurveLeft,
  trimSpeedCurveRight,
  durationForSourceSpan
} from '../src/engine/frameTiming'
import { rmsFromChannels, buildDuckActivity, duckGain, duckTriggers, hasDucking } from '../src/engine/ducking'
import { TEXT_STYLE_PRESETS, textStylePatch, getTextStyle } from '../src/engine/textStyles'
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

// ---------- v0.7: トランジション 30 種 / 重ねるトランジション ----------
console.log('transitions (v0.7):')
{
  const ALL = [
    'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'wipe',
    'wipe-rtl', 'wipe-up', 'wipe-down', 'split', 'iris', 'zoom-out', 'spin', 'blur', 'flash',
    'wipe-diag', 'split-v', 'clock', 'diamond', 'heart', 'blinds', 'checker', 'flip-x', 'flip-y',
    'bounce', 'shake', 'glitch', 'pixelate', 'zoom-blur'
  ]
  const mk = (type: string, overlap = false) => ({
    id: 'c', kind: 'video', trackId: 't', start: 10, duration: 4, opacity: 1,
    transitionIn: { type, duration: 1, overlap }, transitionOut: { type, duration: 1 }
  } as unknown as Clip)
  const neutral = JSON.stringify(sampleTransition(mk('fade'), 12))
  const changed = ALL.filter(ty =>
    JSON.stringify(sampleTransition(mk(ty), 10.3)) !== neutral &&
    JSON.stringify(sampleTransition(mk(ty), 13.7)) !== neutral)
  check('30 種すべてが入り・出で変化する', changed.length === 30, ALL.filter(x => !changed.includes(x)).join(','))
  check('30 種すべてが完了時点で元に戻る', ALL.every(ty => JSON.stringify(sampleTransition(mk(ty), 11)) === neutral))

  const clock = sampleTransition(mk('clock'), 10.25)
  check('clock 25% → 90° の扇形', clock.reveal?.kind === 'sector' && approx((clock.reveal as any).sweep, Math.PI / 2))
  const blinds = sampleTransition(mk('blinds'), 10.5)
  check('blinds 50% → 8 本の帯が半分ずつ',
    blinds.reveal?.kind === 'rects' && (blinds.reveal as any).rects.length === 8 && approx((blinds.reveal as any).rects[0].y1, 1 / 16))
  const checker = sampleTransition(mk('checker'), 10.25)
  check('checker 25% → 半分のマスだけ出始める', checker.reveal?.kind === 'rects' && (checker.reveal as any).rects.length === 20)
  const diag = sampleTransition(mk('wipe-diag'), 10.5)
  check('wipe-diag 50% → 正規化多角形で右上〜左下の対角線まで', diag.reveal?.kind === 'npoly' &&
    (diag.reveal as any).points.some(([x, y]: number[]) => approx(x, 1) && approx(y, 0)))
  check('flip-x 開始時は横幅 0', approx(sampleTransition(mk('flip-x'), 10).scaleX, 0))
  check('pixelate 開始時は粗さ 80', approx(sampleTransition(mk('pixelate'), 10).pixelate, 80))
  const g1 = sampleTransition(mk('glitch'), 10.4)
  const g2 = sampleTransition(mk('glitch'), 10.4)
  check('glitch は同じ時刻で同じ結果 (プレビューと書き出しが一致)', JSON.stringify(g1) === JSON.stringify(g2))
  check('bounce は途中で 1 を超えて弾む',
    [0.5, 0.6, 0.7, 0.8].some(p => sampleTransition(mk('bounce'), 10 + p).scale > 1.01))

  // 重ねる (overlap): 開始の 1 秒前から始まり開始位置で完了
  const ov = mk('fade', true)
  check('重ねる: 開始 0.5 秒前で 50%', approx(sampleTransition(ov, 9.5).alpha, 0.5))
  check('重ねる: 開始位置で完了', approx(sampleTransition(ov, 10).alpha, 1))
  check('重ねない: 開始位置で 0', approx(sampleTransition(mk('fade'), 10).alpha, 0))
  check('preRoll / visualStart', preRoll(ov) === 1 && visualStart(ov) === 9)
  check('音声クリップは前倒ししない', preRoll({ ...ov, kind: 'audio' } as any) === 0)
  check('前倒し区間はアクティブ', isClipActiveAt(ov, 9.2) && !isClipActiveAt(ov, 8.9) && !isClipActiveAt(mk('fade'), 9.5))
  const plan = clipSourceTimestamps({ ...ov, sourceIn: 0.25 } as any, 9, 10, 20)!
  check('前倒し区間の素材時刻は 0 で止まり単調非減少',
    plan.timestamps[0] === 0 && plan.timestamps.every((v, i, a) => i === 0 || v >= a[i - 1]) && approx(plan.timestamps[10], 0.25))
  const order = new Map([['t', 0], ['u', 1]])
  const A = { trackId: 't', start: 0, duration: 10 }
  const B = { trackId: 't', start: 10, duration: 5 }
  const C = { trackId: 'u', start: 0, duration: 5 }
  check('同じトラックは開始が遅い方が手前、トラック順が優先',
    compareDrawOrder(A, B, order) < 0 && compareDrawOrder(C, B, order) > 0)
}

// ---------- v0.7: 描画 (扇形 / 伸縮 / モザイク) ----------
console.log('renderer calls (v0.7):')
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
  ;(globalThis as any).document = { createElement: () => ({ width: 1, height: 1, getContext: () => makeCtx() }) }
  const target = { ctx: makeCtx(), width: 1920, height: 1080, buffer: new LayerBuffer() }
  const src = { src: { tag: 'img' } as any, width: 640, height: 360 }
  const clip = (type: string) => ({
    id: 'v', kind: 'image', trackId: 't', assetId: 'a', start: 0, duration: 4, opacity: 1,
    x: 0.5, y: 0.5, scale: 1, rotation: 0, transitionIn: { type, duration: 1 }
  } as Clip)

  calls.length = 0
  drawClip(target, clip('clock'), 0.25, src)
  const arc = calls.find(c => c.fn === 'arc')
  check('clock は 12 時から時計回りの扇形', !!arc && approx(arc.args[3], -Math.PI / 2) && approx(arc.args[4], 0))
  calls.length = 0
  drawClip(target, clip('flip-x'), 0.5, src)
  const sc = calls.find(c => c.fn === 'scale')
  check('flip-x は横だけ縮める', !!sc && sc.args[0] < 1 && approx(sc.args[1], 1))
  calls.length = 0
  drawClip(target, clip('pixelate'), 0.2, src)
  check('pixelate はバッファ経由 (ピクセル処理) で描く',
    calls.some(c => c.fn === 'putImageData') && calls.filter(c => c.fn === 'drawImage').length === 2)
  calls.length = 0
  drawClip(target, clip('blinds'), 0.5, src)
  check('blinds は 8 個の矩形でクリップ', calls.filter(c => c.fn === 'rect').length === 8 && calls.some(c => c.fn === 'clip'))
}

// ---------- v0.8: 速度カーブ ----------
console.log('speed curve:')
{
  // 4 秒のクリップ: 0→0.5 (2s) は 1x→3x、0.5→1 は 3x 一定
  const c = { start: 10, duration: 4, sourceIn: 1, speedCurve: [{ x: 0, speed: 1 }, { x: 0.5, speed: 3 }, { x: 1, speed: 3 }] }
  check('speedAt 途中の補間 (1s → 2x)', approx(speedAt(c, 1), 2))
  check('sourceAdvance 台形の積分 (2s → 4)', approx(sourceAdvance(c, 2), 4))
  check('sourceAdvance 末尾 (4s → 4 + 6 = 10)', approx(clipSourceSpan(c), 10))
  check('mapClipTimeToSource に反映 (sourceIn 1 + 積分)', approx(mapClipTimeToSource(c, 11), 1 + 1.5))
  check('範囲外は端の速度で延長', approx(sourceAdvance(c, -1), -1) && approx(sourceAdvance(c, 5), 13))
  check('カーブなしは従来の speed', approx(sourceAdvance({ start: 0, duration: 4, speed: 2 }, 1.5), 3))
  const unsorted = { start: 0, duration: 2, speedCurve: [{ x: 1, speed: 2 }, { x: 0.5, speed: 50 }] }
  check('並べ替え・上限 10x・先頭を補う', approx(speedAt(unsorted, 0), 10) && approx(speedAt(unsorted, 1), 10))
  const plan = clipSourceTimestamps({ ...c, start: 0 }, 0, 10, 40)!
  check('素材時刻は単調増加 (シーケンシャルデコード可能)', plan.timestamps.every((v, i, a) => i === 0 || v > a[i - 1]))

  // 分割: 左右の素材の進みが元と一致する
  const f = 0.25
  const { left, right } = splitSpeedCurve(c.speedCurve, f)
  const L = { start: 0, duration: 1, speedCurve: left }
  const R = { start: 0, duration: 3, speedCurve: right }
  check('分割: 左の消費量 = 元の 0..1s', approx(clipSourceSpan(L), sourceAdvance(c, 1)))
  check('分割: 右の消費量 = 元の 1..4s', approx(clipSourceSpan(R), clipSourceSpan(c) - sourceAdvance(c, 1)))
  check('分割: 境界の速度が連続', approx(speedAt(L, 1), speedAt(R, 0)) && approx(speedAt(R, 0), 2))
  check('カーブなしの分割はそのまま', splitSpeedCurve(undefined, 0.5).left === undefined)
}

// ---------- v0.8: ダッキング ----------
console.log('ducking:')
{
  // 1 kHz サイン: 0..1s 無音、1..2s 大きい音 (sampleRate 1000)
  const sr = 1000
  const ch = new Float32Array(3 * sr)
  for (let i = sr; i < 2 * sr; i++) ch[i] = 0.5 * Math.sin(i)
  const r = rmsFromChannels([ch], sr, 20)
  check('RMS: 無音は -120dB、音ありは -9dB 付近', r.db[5] === -120 && r.db[30] > -12 && r.db[30] < -6)

  const state = {
    tracks: [
      { id: 'v', kind: 'video', name: 'V', muted: false, locked: false, order: 1 },
      { id: 'a', kind: 'audio', name: 'A', muted: false, locked: false, order: 0 }
    ],
    clips: [
      { id: 'voice', kind: 'audio', trackId: 'v', assetId: 'speech', start: 2, duration: 3, opacity: 1 },
      { id: 'bgm', kind: 'audio', trackId: 'a', assetId: 'music', start: 0, duration: 8, opacity: 1, ducking: { amount: 0.8 } }
    ]
  } as any
  check('ダッキング対象の検出', hasDucking(state.clips))
  check('きっかけは対象クリップ以外', duckTriggers(state).map((c: any) => c.id).join() === 'voice')
  const act = buildDuckActivity(state, new Map([['speech', r], ['music', rmsFromChannels([new Float32Array(8 * sr).fill(0.5)], sr)]]))
  const bgm = state.clips[1]
  // voice の素材 1..2s が鳴る → タイムライン 3..4s
  check('無音の間は下げない', approx(duckGain(act, bgm, 2.5), 1, 0.02))
  check('鳴っている間は 1 - 0.8 = 0.2 まで下がる', approx(duckGain(act, bgm, 3.6), 0.2, 0.03))
  check('先読みで鳴る直前から下がり始める', duckGain(act, bgm, 2.97) < 0.9)
  check('鳴り終わると徐々に戻る', duckGain(act, bgm, 4.3) > 0.25 && duckGain(act, bgm, 6) > 0.95)
  check('対象外のクリップは常に 1', approx(duckGain(act, state.clips[0], 3.5), 1))
  const mutedVoice = { ...state, tracks: state.tracks.map((t: any) => t.id === 'v' ? { ...t, muted: true } : t) }
  check('ミュートしたトラックはきっかけにしない', duckTriggers(mutedVoice).length === 0)
}

// ---------- v0.8: 背景ぼかし塗り ----------
console.log('bg fill:')
{
  const calls: Array<{ fn: string; args: any[] }> = []
  const makeCtx = () => new Proxy({} as any, {
    get(target, key) {
      if (key in target) return target[key]
      return (...args: any[]) => { calls.push({ fn: String(key), args }) }
    },
    set(target, key, v) { target[key] = v; calls.push({ fn: `set:${String(key)}`, args: [v] }); return true }
  })
  ;(globalThis as any).document = { createElement: () => ({ width: 1, height: 1, getContext: () => makeCtx() }) }
  const target = { ctx: makeCtx(), width: 1080, height: 1920, buffer: new LayerBuffer(), bgBuffer: new LayerBuffer() }
  const src = { src: { tag: 'video' } as any, width: 1920, height: 1080 }
  const base = { id: 'v', kind: 'video', trackId: 't', assetId: 'a', start: 0, duration: 2, opacity: 1, x: 0.5, y: 0.5, scale: 1, rotation: 0 }
  calls.length = 0
  drawClip(target, { ...base, bgFill: { blur: 40, dim: 0.2 } } as Clip, 1, src)
  const draws = calls.filter(c => c.fn === 'drawImage')
  check('背景 (縮小 cover) → 拡大ぼかし → 本体 の 3 回描く', draws.length === 3 && draws[0].args[0] === src.src && draws[2].args[0] === src.src)
  check('縮小バッファは画面の 1/8 に cover で描く', approx(draws[0].args[7], 1920 / 8 * 1920 / 1080, 1) && approx(draws[0].args[8], 240))
  check('拡大時はぼかし幅の 2 倍はみ出して描く', approx(draws[1].args[1], -80) && approx(draws[1].args[3], 1080 + 160))
  check('ぼかしと暗さのフィルタ', calls.some(c => c.fn === 'set:filter' && String(c.args[0]) === 'blur(40.0px) brightness(0.800)'))
  calls.length = 0
  drawClip(target, { ...base, scale: 1.8, bgFill: { blur: 40, dim: 0 } } as Clip, 1, src)
  // scale 1.8 だと縦 1920 に届かない (607.5×1.8=1093) → 背景は必要
  check('画面を覆わないなら背景を描く', calls.filter(c => c.fn === 'drawImage').length === 3)
  calls.length = 0
  drawClip(target, { ...base, scale: 3.2, bgFill: { blur: 40, dim: 0 } } as Clip, 1, src)
  check('画面を覆うなら背景を省く', calls.filter(c => c.fn === 'drawImage').length === 1)
}

// ---------- v0.8: テキストのスタイル集 ----------
console.log('text styles:')
{
  check('スタイル 13 種・ID 一意', TEXT_STYLE_PRESETS.length === 13 && new Set(TEXT_STYLE_PRESETS.map(p => p.id)).size === 13)
  const patch = textStylePatch(getTextStyle('subtitle-band')!)
  check('帯字幕: 背景色あり・ふちなし', patch.backgroundColor === '#000000b3' && !patch.decor?.outline)
  const plain = textStylePatch(getTextStyle('subtitle')!)
  check('背景なしのスタイルは背景を消す', 'backgroundColor' in plain && plain.backgroundColor === undefined)
  check('アニメを持つスタイルだけ anim を設定', !('anim' in plain) && textStylePatch(getTextStyle('pop')!).anim?.type === 'scale-pop')
  check('位置・内容は含まない', !('x' in patch) && !('y' in patch) && !('text' in patch))
  const p1 = textStylePatch(getTextStyle('neon-pink')!)
  p1.decor!.shadow!.blur = 999
  check('装飾はコピー (プリセットを書き換えない)', getTextStyle('neon-pink')!.style.decor!.shadow!.blur === 32)
}

// ---------- 監査対応: 速度カーブのトリム / バッファ上限 ----------
console.log('audit fixes:')
{
  // 10 秒・0.5x→3x のカーブ
  const c = { start: 0, duration: 10, sourceIn: 0, speedCurve: [{ x: 0, speed: 0.5 }, { x: 1, speed: 3 }] }
  // 左を 5 秒トリム: 残りの素材対応は元と一致する
  const d = 5
  const L = { start: d, duration: 5, sourceIn: sourceAdvance(c, d), speedCurve: trimSpeedCurveLeft(c.speedCurve, 10, d) }
  check('左トリム後も残り部分の素材時刻が変わらない',
    [5, 6.5, 7.5, 9.9].every(t => approx(mapClipTimeToSource(L, t), mapClipTimeToSource(c, t), 1e-9)))
  // 左を 2 秒延長: 元の部分は一致、延長分は先頭速度
  const E = { start: -2, duration: 12, sourceIn: sourceAdvance(c, -2) + 0, speedCurve: trimSpeedCurveLeft(c.speedCurve, 10, -2) }
  check('左延長後も元の部分の素材時刻が変わらない',
    [0, 3, 9.5].every(t => approx(mapClipTimeToSource(E, t), mapClipTimeToSource(c, t), 1e-9)))
  // 右を 6 秒に短縮 / 13 秒に延長
  const R1 = { ...c, duration: 6, speedCurve: trimSpeedCurveRight(c.speedCurve, 10, 6) }
  const R2 = { ...c, duration: 13, speedCurve: trimSpeedCurveRight(c.speedCurve, 10, 13) }
  check('右トリム (短縮・延長) で元の部分の素材時刻が変わらない',
    [1, 4, 5.9].every(t => approx(mapClipTimeToSource(R1, t), mapClipTimeToSource(c, t), 1e-9)) &&
    [1, 9.9].every(t => approx(mapClipTimeToSource(R2, t), mapClipTimeToSource(c, t), 1e-9)) &&
    approx(speedAt(R2, 12), 3))
  const span = 8
  const Dm = durationForSourceSpan(c, span)
  check('素材を使い切る長さ (カーブ内)', approx(sourceAdvance(c, Dm), span, 1e-6))
  const Dx = durationForSourceSpan(c, clipSourceSpan(c) + 6)
  check('素材を使い切る長さ (末尾速度で延長)', approx(Dx, 12))
  check('カーブなしは span / speed', approx(durationForSourceSpan({ start: 0, duration: 4, speed: 2 }, 10), 5))

  // 大きく拡大したマスク付きクリップでもバッファは素材解像度で頭打ち
  const sizes: number[][] = []
  ;(globalThis as any).document = {
    createElement: () => {
      const cv: any = { _w: 1, _h: 1, getContext: () => new Proxy({}, { get: (t: any, k) => k in t ? t[k] : (k === 'getImageData' ? (_a: number, _b: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}), set: (t: any, k, v) => { t[k] = v; return true } }) }
      Object.defineProperty(cv, 'width', { get: () => cv._w, set: v => { cv._w = v; sizes.push([cv._w, cv._h]) } })
      Object.defineProperty(cv, 'height', { get: () => cv._h, set: v => { cv._h = v; sizes.push([cv._w, cv._h]) } })
      return cv
    }
  }
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true })
  const target = { ctx: ctx as any, width: 1920, height: 1080, buffer: new LayerBuffer() }
  drawClip(target, {
    id: 'v', kind: 'image', trackId: 't', assetId: 'a', start: 0, duration: 2, opacity: 1, x: 0.5, y: 0.5, scale: 10, rotation: 0,
    mask: { shape: 'ellipse', x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0, feather: 0.2, invert: false },
    pixelFx: { vignette: 0.3 }
  } as Clip, 1, { src: {} as any, width: 1280, height: 720 })
  const maxSide = Math.max(...sizes.flat())
  check('拡大 10 倍でもバッファは素材解像度 (1280) 以下', maxSide <= 1280, `max=${maxSide}`)
}

// ---------- 監査対応: 書き出しの逐次 Blob 化 ----------
console.log('streamed muxing:')
{
  // 同じ入力を ArrayBufferTarget と StreamTarget + PositionedBlobWriter で書いて一致を確認
  // (head / tail をファイルより小さく・クラスタより大きくして、確定・書き直しの経路を通す)
  const frames = Array.from({ length: 120 }, (_, i) => {
    const b = new Uint8Array(3000 + (i % 7) * 900)
    for (let k = 0; k < b.length; k++) b[k] = (i * 31 + k) & 0xff
    return b
  })
  const run = async (kind: 'mp4' | 'webm', streamed: boolean) => {
    const M: any = kind === 'mp4' ? Mp4 : Webm
    const writer = new PositionedBlobWriter(4096, 250000)
    const target = streamed
      ? new M.StreamTarget({ onData: (d: Uint8Array, p: number) => writer.write(d, p), chunked: true, chunkSize: 16384 })
      : new M.ArrayBufferTarget()
    const muxer = kind === 'mp4'
      ? new M.Muxer({ target, video: { codec: 'avc', width: 320, height: 240, frameRate: 30 }, fastStart: false, firstTimestampBehavior: 'offset' })
      : new M.Muxer({ target, video: { codec: 'V_VP9', width: 320, height: 240, frameRate: 30 }, firstTimestampBehavior: 'offset' })
    frames.forEach((f, i) => {
      const key = i % 30 === 0
      const meta = i === 0 ? { decoderConfig: { codec: kind === 'mp4' ? 'avc1.640028' : 'vp09.00.10.08', codedWidth: 320, codedHeight: 240, description: new Uint8Array([1, 100, 0, 40, 255, 225, 0, 0]) } } : undefined
      if (kind === 'mp4') muxer.addVideoChunkRaw(f, key ? 'key' : 'delta', Math.round(i * 1e6 / 30), Math.round(1e6 / 30), meta)
      else muxer.addVideoChunkRaw(f, key ? 'key' : 'delta', Math.round(i * 1e6 / 30), meta)
    })
    muxer.finalize()
    return streamed ? new Uint8Array(await writer.toBlob('x').arrayBuffer()) : new Uint8Array(target.buffer)
  }
  for (const kind of ['mp4', 'webm'] as const) {
    const a = await run(kind, false)
    const b = await run(kind, true)
    check(`${kind}: 逐次 Blob 化した出力が従来と 1 バイトも違わない (${a.length} bytes)`,
      a.length === b.length && a.every((v, i) => v === b[i]))
  }
  const w = new PositionedBlobWriter(8, 16)
  w.write(new Uint8Array(40).fill(1), 0)
  w.write(new Uint8Array(40).fill(2), 40)
  let threw = false
  try { w.write(new Uint8Array([9]), 20) } catch { threw = true }
  check('確定済みの位置への書き直しは例外 (壊れたファイルを黙って出さない)', threw)
  w.write(new Uint8Array([7, 7]), 3)
  w.write(new Uint8Array([5]), 79)
  const out = new Uint8Array(await w.toBlob('x').arrayBuffer())
  check('先頭・直近の書き直しは反映される', out[3] === 7 && out[4] === 7 && out[79] === 5 && out.length === 80)
}

// ---------- 監査対応: 字幕の空行 ----------
console.log('srt blank lines:')
{
  const cues = [{ start: 0, end: 1, text: 'a\n\nb\n \nc' }, { start: 2, end: 3, text: 'd' }]
  const back = parseSubtitles(toSrt(cues))
  check('本文の空行で字幕が分断されない', back.length === 2 && back[0].text === 'a\nb\nc')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
