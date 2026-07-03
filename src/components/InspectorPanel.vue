<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { useSelection } from '../composables/useSelection'
import type {
  Clip,
  VideoClip,
  ImageClip,
  TextClip,
  AudioClip,
  ShapeClip,
  ShapeKind,
  KeyframeableProperty,
  Easing,
  TransitionType,
  ClipEffects,
  Transition,
  BlendMode,
  ColorGrade,
  ChromaKey,
  PixelEffects,
  Duotone,
  TextDecor,
  TextAnim,
  TextAnimType,
  AudioEQ
} from '../types/project'
import { findKeyframeAt, neighborKeyframes } from '../engine/keyframes'
import { EFFECT_PRESETS } from '../engine/effectPresets'
import { useLocale } from '../composables/useLocale'
import EffectSlider from './EffectSlider.vue'

const { t } = useLocale()

const store = useProjectStore()
const selection = useSelection()

const selectedClip = computed<Clip | null>(() => {
  const id = selection.selectedClipId.value
  if (!id) return null
  return store.state.clips.find(c => c.id === id) ?? null
})

// 型ガード済みの computed
const videoOrImageClip = computed<VideoClip | ImageClip | null>(() => {
  const c = selectedClip.value
  return c && (c.kind === 'video' || c.kind === 'image') ? c : null
})
const textClip = computed<TextClip | null>(() => {
  const c = selectedClip.value
  return c && c.kind === 'text' ? c : null
})
const shapeClip = computed<ShapeClip | null>(() => {
  const c = selectedClip.value
  return c && c.kind === 'shape' ? c : null
})
const audioLikeClip = computed<VideoClip | AudioClip | null>(() => {
  const c = selectedClip.value
  return c && (c.kind === 'video' || c.kind === 'audio') ? c : null
})

const localPlayhead = computed(() => {
  const c = selectedClip.value
  if (!c) return 0
  return store.state.timeline.playhead - c.start
})

const playheadInClip = computed(() => {
  const c = selectedClip.value
  if (!c) return false
  const lt = localPlayhead.value
  return lt >= 0 && lt <= c.duration
})

function update(patch: Partial<Clip>) {
  const id = selection.selectedClipId.value
  if (!id) return
  // 開始時間の変更はリンクされたクリップにも同じ移動量を適用する
  // (タイムラインのドラッグ移動と同じ挙動に揃える)
  if (typeof patch.start === 'number') {
    const c = store.getClip(id)
    if (c) {
      const delta = patch.start - c.start
      const linked = store.getLinkedClips(id)
      if (delta !== 0 && linked.length > 1) {
        for (const l of linked) {
          store.updateClip(
            l.id,
            { start: Math.max(0, l.start + delta) } as any,
            `insp-start:${id}`
          )
        }
        return
      }
    }
  }
  store.updateClip(id, patch as any)
}

function updateEffects(patch: Partial<ClipEffects>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).effects ?? {}
  store.setEffects(c.id, { ...prev, ...patch })
}

// 画面に映るクリップ (不透明度・位置 x/y を持つ)。図形も含む
function hasVisual(c: Clip): c is VideoClip | ImageClip | TextClip | ShapeClip {
  return (
    c.kind === 'video' ||
    c.kind === 'image' ||
    c.kind === 'text' ||
    c.kind === 'shape'
  )
}

// スケール・回転を持つクリップ (テキストは fontSize / 図形は width/height で
// サイズ管理するためスケールは対象外だが、回転は持つ)
function hasRotation(c: Clip): c is VideoClip | ImageClip | ShapeClip {
  return c.kind === 'video' || c.kind === 'image' || c.kind === 'shape'
}

function hasVolume(c: Clip): c is VideoClip | AudioClip {
  return c.kind === 'video' || c.kind === 'audio'
}

function hasEffects(c: Clip): c is VideoClip | ImageClip {
  return c.kind === 'video' || c.kind === 'image'
}

function fmtSec(s: number): string {
  return s.toFixed(2) + ' s'
}

// ---------- キーフレーム操作 ----------

function kfExistsAt(prop: KeyframeableProperty): boolean {
  const c = selectedClip.value
  if (!c) return false
  return !!findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
}

function toggleKeyframe(prop: KeyframeableProperty) {
  const c = selectedClip.value
  if (!c) return
  if (!playheadInClip.value) return
  const existing = findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
  if (existing) {
    store.removeKeyframe(c.id, prop, existing.time)
  } else {
    const value = store.currentEffectiveValue(c, prop)
    store.addKeyframe(c.id, prop, {
      time: localPlayhead.value,
      value,
      easing: 'linear'
    })
  }
}

function jumpToPrevKeyframe(prop: KeyframeableProperty) {
  const c = selectedClip.value
  if (!c) return
  const { prev } = neighborKeyframes(c.keyframes?.[prop], localPlayhead.value)
  if (prev) store.setPlayhead(c.start + prev.time)
}
function jumpToNextKeyframe(prop: KeyframeableProperty) {
  const c = selectedClip.value
  if (!c) return
  const { next } = neighborKeyframes(c.keyframes?.[prop], localPlayhead.value)
  if (next) store.setPlayhead(c.start + next.time)
}

function currentEasing(prop: KeyframeableProperty): Easing {
  const c = selectedClip.value
  if (!c) return 'linear'
  const k = findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
  return k?.easing ?? 'linear'
}

function setEasing(prop: KeyframeableProperty, easing: Easing) {
  const c = selectedClip.value
  if (!c) return
  const k = findKeyframeAt(c.keyframes?.[prop], localPlayhead.value)
  if (!k) return
  store.addKeyframe(c.id, prop, { ...k, easing })
}

// ---------- トランジション ----------

function setTransition(side: 'in' | 'out', tr: Transition | undefined) {
  const c = selectedClip.value
  if (!c) return
  store.setTransition(c.id, side, tr)
}

function applyFadePreset(side: 'in' | 'out') {
  // キビキビした印象になるよう既定は短め (以前は 0.5s で遅く感じた)
  setTransition(side, { type: 'fade', duration: 0.25 })
}

function clearTransition(side: 'in' | 'out') {
  setTransition(side, undefined)
}

// ---------- エフェクト ----------

function resetEffects() {
  const c = selectedClip.value
  if (!c || !hasEffects(c)) return
  store.setEffects(c.id, undefined)
}

// ---------- 速度 / 再生 / ブレンド ----------

function setSpeed(v: number) {
  const c = selectedClip.value
  if (!c) return
  store.updateClip(c.id, { speed: Math.max(0.125, Math.min(8, v)) } as any, `speed:${c.id}`)
}
function setBlendMode(m: BlendMode) {
  const c = selectedClip.value
  if (!c) return
  store.setBlendMode(c.id, m === 'normal' ? undefined : m)
}

// ---------- カラーグレード ----------

function updateGrade(patch: Partial<ColorGrade>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).colorGrade ?? {}
  store.setColorGrade(c.id, { ...prev, ...patch })
}
function resetGrade() {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  store.setColorGrade(c.id, undefined)
}

// ---------- クロマキー ----------

function updateChroma(patch: Partial<ChromaKey>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).chromaKey ?? {
    enabled: false,
    color: '#00ff00',
    threshold: 0.25,
    softness: 0.1,
    spillSuppress: 0.3
  }
  store.setChromaKey(c.id, { ...prev, ...patch })
}
function clearChroma() {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  store.setChromaKey(c.id, undefined)
}

// ---------- ピクセルエフェクト ----------

function updatePixelFx(patch: Partial<PixelEffects>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).pixelFx ?? {}
  store.setPixelEffects(c.id, { ...prev, ...patch })
}
function updateDuotone(patch: Partial<Duotone>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).pixelFx?.duotone ?? {
    enabled: false,
    shadow: '#1a1a4a',
    highlight: '#ffd98a'
  }
  updatePixelFx({ duotone: { ...prev, ...patch } })
}
function resetPixelFx() {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  store.setPixelEffects(c.id, undefined)
}

// ---------- プリセット ----------

function applyPreset(id: string) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  store.applyEffectPreset(c.id, id)
}

// ---------- テキスト装飾・アニメ ----------

function updateDecor(patch: Partial<TextDecor>) {
  const c = selectedClip.value
  if (!c || c.kind !== 'text') return
  const prev = (c as TextClip).decor ?? {}
  store.setTextDecor(c.id, { ...prev, ...patch })
}
function clearDecor() {
  const c = selectedClip.value
  if (!c || c.kind !== 'text') return
  store.setTextDecor(c.id, undefined)
}
function setAnim(type: TextAnimType, duration = 1) {
  const c = selectedClip.value
  if (!c || c.kind !== 'text') return
  if (type === 'none') store.setTextAnim(c.id, undefined)
  else store.setTextAnim(c.id, { type, duration })
}

// ---------- EQ ----------

function updateEQ(patch: Partial<AudioEQ>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'audio' && c.kind !== 'video')) return
  const prev = (c as AudioClip).eq ?? {}
  store.setAudioEQ(c.id, { ...prev, ...patch })
}

// ---------- 図形 ----------

function updateShape(patch: Partial<ShapeClip>) {
  const c = selectedClip.value
  if (!c || c.kind !== 'shape') return
  store.updateClip(c.id, patch as any)
}
function updateShapeStyle(patch: Partial<ShapeClip['style']>) {
  const c = selectedClip.value
  if (!c || c.kind !== 'shape') return
  const sc = c as ShapeClip
  store.updateClip(c.id, { style: { ...sc.style, ...patch } } as any)
}

// ---------- リンク ----------

function linkSelection() {
  const ids = selection.selectedClipIds.value
  if (ids.length >= 2) store.linkClips(ids)
}
function unlinkSelection() {
  const ids = selection.selectedClipIds.value
  if (ids.length > 0) store.unlinkClips(ids)
}

const BLEND_MODES: BlendMode[] = [
  'normal','multiply','screen','overlay','darken','lighten',
  'color-dodge','color-burn','hard-light','soft-light',
  'difference','exclusion','hue','saturation','color','luminosity','add'
]

const TEXT_ANIMS: TextAnimType[] = [
  'none','typewriter','fade-words','slide-chars','bounce','scale-pop','wave'
]

const SHAPE_KINDS: ShapeKind[] = ['rect','ellipse','triangle','star','arrow','line']

function blendLabelJa(m: BlendMode): string {
  const easy: Record<BlendMode, string> = {
    normal: '通常',
    multiply: '乗算 (重ねて暗く)',
    screen: 'スクリーン (重ねて明るく)',
    overlay: 'オーバーレイ (上に重ねる)',
    darken: '比較 (暗)',
    lighten: '比較 (明)',
    'color-dodge': '覆い焼き (明るく)',
    'color-burn': '焼き込み (暗く)',
    'hard-light': 'ハードライト (強い光)',
    'soft-light': 'ソフトライト (柔らかい光)',
    difference: '差の絶対値',
    exclusion: '除外',
    hue: '色相のみ',
    saturation: '彩度のみ',
    color: '色のみ',
    luminosity: '明るさのみ',
    add: '加算',
    subtract: '減算'
  }
  const norm: Record<BlendMode, string> = {
    normal: '通常',
    multiply: '乗算',
    screen: 'スクリーン',
    overlay: 'オーバーレイ',
    darken: '比較 (暗)',
    lighten: '比較 (明)',
    'color-dodge': '覆い焼き',
    'color-burn': '焼き込み',
    'hard-light': 'ハードライト',
    'soft-light': 'ソフトライト',
    difference: '差の絶対値',
    exclusion: '除外',
    hue: '色相',
    saturation: '彩度',
    color: 'カラー',
    luminosity: '輝度',
    add: '加算',
    subtract: '減算'
  }
  return t(easy[m] ?? m, norm[m] ?? m)
}

function animLabelJa(a: TextAnimType): string {
  const easy: Record<TextAnimType, string> = {
    none: 'なし',
    typewriter: 'タイプライター (1文字ずつ)',
    'fade-words': 'フェード (じわっと表示)',
    'slide-chars': 'スライド (下から表示)',
    bounce: 'バウンド (弾む)',
    'scale-pop': 'ポップ (跳び出す)',
    wave: 'ウェーブ (波打つ)'
  }
  const norm: Record<TextAnimType, string> = {
    none: 'なし',
    typewriter: 'タイプライター',
    'fade-words': 'フェード',
    'slide-chars': 'スライド',
    bounce: 'バウンド',
    'scale-pop': 'スケールポップ',
    wave: 'ウェーブ'
  }
  return t(easy[a] ?? a, norm[a] ?? a)
}

function shapeLabelJa(s: ShapeKind): string {
  const easy: Record<ShapeKind, string> = {
    rect: '四角', ellipse: '円', triangle: '三角',
    star: '星', arrow: '矢印', line: '線'
  }
  const norm: Record<ShapeKind, string> = {
    rect: '矩形', ellipse: '楕円', triangle: '三角形',
    star: '星', arrow: '矢印', line: '線'
  }
  return t(easy[s] ?? s, norm[s] ?? s)
}

function kindNameJa(kind: string): string {
  if (kind === 'video') return t('動画', '動画')
  if (kind === 'audio') return t('音声', '音声')
  if (kind === 'image') return t('画像', '画像')
  if (kind === 'text') return t('テキスト', 'テキスト')
  if (kind === 'shape') return t('図形', '図形')
  return kind
}
</script>

<template>
  <div class="panel-title">
    <span>Inspector</span>
  </div>

  <div class="inspector-body">
    <div v-if="!selectedClip" class="empty">
      <div class="empty-icon">◇</div>
      <div class="empty-text">{{ t('クリップを選んでください', 'クリップを選択してください') }}</div>
    </div>

    <template v-else>
      <section class="section">
        <div class="kind-badge" :class="'k-' + selectedClip.kind">
          {{ kindNameJa(selectedClip.kind) }}
        </div>
      </section>

      <!-- 時間プロパティ -->
      <section class="section">
        <div class="section-head">{{ t('時間', '時間') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>{{ t('開始', '開始') }}</span>
            <input
              type="number"
              step="0.01"
              :value="selectedClip.start.toFixed(2)"
              @change="(e) => update({ start: Math.max(0, Number((e.target as HTMLInputElement).value)) })"
            />
          </label>
          <label class="field">
            <span>{{ t('長さ', '長さ') }}</span>
            <input
              type="number"
              step="0.01"
              :value="selectedClip.duration.toFixed(2)"
              @change="(e) => update({ duration: Math.max(0.1, Number((e.target as HTMLInputElement).value)) })"
            />
          </label>
          <label
            v-if="selectedClip.kind === 'video' || selectedClip.kind === 'audio'"
            class="field"
          >
            <span>{{ t('素材の開始位置', '素材内オフセット') }}</span>
            <input
              type="number"
              step="0.01"
              :value="(selectedClip.sourceIn ?? 0).toFixed(2)"
              @change="(e) => update({ sourceIn: Math.max(0, Number((e.target as HTMLInputElement).value)) })"
            />
          </label>
          <div class="field">
            <span>{{ t('終了', '終了') }}</span>
            <div class="value mono">{{ fmtSec(selectedClip.start + selectedClip.duration) }}</div>
          </div>
        </div>
      </section>

      <!-- 不透明度 -->
      <section v-if="hasVisual(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('表示', '表示') }}</span>
          <button
            class="kf-btn"
            :class="{ on: kfExistsAt('opacity') }"
            :disabled="!playheadInClip"
            :title="t('この位置にキーフレームを追加/削除', 'この時刻にキーフレームを追加/削除')"
            @click="toggleKeyframe('opacity')"
          >◆</button>
        </div>
        <label class="field">
          <span>
            {{ t('透明度', '不透明度') }}
            <span class="mono muted">{{ (selectedClip.opacity * 100).toFixed(0) }}%</span>
          </span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="selectedClip.opacity"
            @input="(e) => update({ opacity: Number((e.target as HTMLInputElement).value) })"
          />
        </label>
        <div v-if="kfExistsAt('opacity')" class="kf-row">
          <button class="ghost tiny" @click="jumpToPrevKeyframe('opacity')">◀</button>
          <select
            :value="currentEasing('opacity')"
            @change="(e) => setEasing('opacity', (e.target as HTMLSelectElement).value as any)"
          >
            <option value="linear">linear</option>
            <option value="easeIn">easeIn</option>
            <option value="easeOut">easeOut</option>
            <option value="easeInOut">easeInOut</option>
          </select>
          <button class="ghost tiny" @click="jumpToNextKeyframe('opacity')">▶</button>
        </div>
      </section>

      <!-- 配置 -->
      <section v-if="hasVisual(selectedClip)" class="section">
        <div class="section-head">{{ t('配置', '配置') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>
              {{ t('横位置 (中央=0.5)', 'X (中央基準)') }}
              <button
                class="kf-btn inline"
                :class="{ on: kfExistsAt('x') }"
                :disabled="!playheadInClip"
                @click="toggleKeyframe('x')"
              >◆</button>
            </span>
            <input
              type="number"
              step="0.01"
              :value="selectedClip.x.toFixed(3)"
              @change="(e) => update({ x: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>
              {{ t('縦位置 (中央=0.5)', 'Y (中央基準)') }}
              <button
                class="kf-btn inline"
                :class="{ on: kfExistsAt('y') }"
                :disabled="!playheadInClip"
                @click="toggleKeyframe('y')"
              >◆</button>
            </span>
            <input
              type="number"
              step="0.01"
              :value="selectedClip.y.toFixed(3)"
              @change="(e) => update({ y: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
        <div
          v-if="hasRotation(selectedClip)"
          class="grid-2"
        >
          <!-- スケール: 図形は width/height でサイズ管理するため出さない -->
          <label v-if="selectedClip.kind === 'video' || selectedClip.kind === 'image'" class="field">
            <span>
              {{ t('大きさ', 'スケール') }}
              <button
                class="kf-btn inline"
                :class="{ on: kfExistsAt('scale') }"
                :disabled="!playheadInClip"
                @click="toggleKeyframe('scale')"
              >◆</button>
            </span>
            <input
              type="number"
              step="0.01"
              :value="(selectedClip as VideoClip | ImageClip).scale.toFixed(2)"
              @change="(e) => update({ scale: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>
              {{ t('回転 (度)', '回転 (度)') }}
              <button
                class="kf-btn inline"
                :class="{ on: kfExistsAt('rotation') }"
                :disabled="!playheadInClip"
                @click="toggleKeyframe('rotation')"
              >◆</button>
            </span>
            <input
              type="number"
              step="1"
              :value="(selectedClip as VideoClip | ImageClip | ShapeClip).rotation"
              @change="(e) => update({ rotation: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
      </section>

      <!-- テキスト固有 -->
      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">{{ t('文字', 'テキスト') }}</div>
        <label class="field">
          <span>{{ t('内容', '内容') }}</span>
          <textarea
            rows="3"
            :value="(selectedClip as TextClip).text"
            @input="(e) => update({ text: (e.target as HTMLTextAreaElement).value })"
          />
        </label>
        <label class="field">
          <span>フォント (書体)</span>
          <select
            :value="(selectedClip as TextClip).fontFamily"
            @change="(e) => update({ fontFamily: (e.target as HTMLSelectElement).value })"
          >
            <option value="sans-serif">sans-serif</option>
            <option value="serif">serif</option>
            <option value="'IBM Plex Sans'">IBM Plex Sans</option>
            <option value="'IBM Plex Mono'">IBM Plex Mono</option>
            <option value="'Instrument Serif'">Instrument Serif</option>
            <option value="'Noto Sans JP'">Noto Sans JP</option>
            <option value="'Noto Serif JP'">Noto Serif JP</option>
          </select>
        </label>
        <div class="grid-2">
          <label class="field">
            <span>文字の大きさ</span>
            <input
              type="number"
              min="8"
              step="1"
              :value="(selectedClip as TextClip).fontSize"
              @change="(e) => update({ fontSize: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>そろえ方</span>
            <select
              :value="(selectedClip as TextClip).align"
              @change="(e) => update({ align: (e.target as HTMLSelectElement).value as any })"
            >
              <option value="left">左揃え</option>
              <option value="center">中央揃え</option>
              <option value="right">右揃え</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label class="field">
            <span>文字の色</span>
            <input
              type="color"
              :value="(selectedClip as TextClip).color"
              @input="(e) => update({ color: (e.target as HTMLInputElement).value })"
            />
          </label>
          <label class="field">
            <span>背景の色</span>
            <div class="row gap-4">
              <input
                type="color"
                :value="(selectedClip as TextClip).backgroundColor ?? '#000000'"
                @input="(e) => update({ backgroundColor: (e.target as HTMLInputElement).value })"
              />
              <button
                class="ghost"
                @click="update({ backgroundColor: undefined })"
              >なし</button>
            </div>
          </label>
        </div>
        <div class="row gap-4">
          <label class="toggle">
            <input
              type="checkbox"
              :checked="(selectedClip as TextClip).bold"
              @change="(e) => update({ bold: (e.target as HTMLInputElement).checked })"
            />
            <span>太字</span>
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              :checked="(selectedClip as TextClip).italic"
              @change="(e) => update({ italic: (e.target as HTMLInputElement).checked })"
            />
            <span>斜体</span>
          </label>
        </div>
      </section>

      <!-- 音量 -->
      <section v-if="hasVolume(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('音声', '音声') }}</span>
          <button
            class="kf-btn"
            :class="{ on: kfExistsAt('volume') }"
            :disabled="!playheadInClip"
            @click="toggleKeyframe('volume')"
          >◆</button>
        </div>
        <label class="field">
          <span>
            {{ t('音量', '音量') }} <span class="mono muted">{{ ((selectedClip.volume ?? 1) * 100).toFixed(0) }}%</span>
          </span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.01"
            :value="selectedClip.volume ?? 1"
            @input="(e) => update({ volume: Number((e.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="!!selectedClip.muted"
            @change="(e) => update({ muted: (e.target as HTMLInputElement).checked })"
          />
          <span>おとを けす</span>
        </label>
      </section>

      <!-- プリセット (ワンタッチ) -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">{{ t('プリセット (ワンタッチ)', 'プリセット') }}</div>
        <div class="preset-grid">
          <button
            v-for="p in EFFECT_PRESETS"
            :key="p.id"
            class="preset-chip"
            @click="applyPreset(p.id)"
          >{{ t(p.labelEasy, p.labelNormal) }}</button>
        </div>
        <div class="section-hint">
          {{ t(
            '※ 選ぶと、下のエフェクト・カラーグレード・特殊効果がまとめて置き換わります',
            '※ 適用するとエフェクト / カラーグレード / ピクセルエフェクトが置き換わります'
          ) }}
        </div>
      </section>

      <!-- エフェクト (映像/画像) -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('効果', 'エフェクト') }}</span>
          <button class="ghost tiny" @click="resetEffects">{{ t('リセット', 'リセット') }}</button>
        </div>
        <EffectSlider
          label="明るさ" :value="selectedClip.effects?.brightness ?? 1"
          :min="0" :max="3" :step="0.01"
          @change="(v) => updateEffects({ brightness: v })"
        />
        <EffectSlider
          label="コントラスト" :value="selectedClip.effects?.contrast ?? 1"
          :min="0" :max="3" :step="0.01"
          @change="(v) => updateEffects({ contrast: v })"
        />
        <EffectSlider
          :label="t('色の濃さ', '彩度')" :value="selectedClip.effects?.saturation ?? 1"
          :min="0" :max="3" :step="0.01"
          @change="(v) => updateEffects({ saturation: v })"
        />
        <EffectSlider
          label="ぼかし" :value="selectedClip.effects?.blur ?? 0"
          :min="0" :max="50" :step="0.5"
          @change="(v) => updateEffects({ blur: v })"
        />
        <EffectSlider
          :label="t('色あい', '色相')" :value="selectedClip.effects?.hueRotate ?? 0"
          :min="-180" :max="180" :step="1"
          @change="(v) => updateEffects({ hueRotate: v })"
        />
        <EffectSlider
          :label="t('白黒', 'グレースケール')" :value="selectedClip.effects?.grayscale ?? 0"
          :min="0" :max="1" :step="0.01"
          @change="(v) => updateEffects({ grayscale: v })"
        />
        <EffectSlider
          label="色を反転" :value="selectedClip.effects?.invert ?? 0"
          :min="0" :max="1" :step="0.01"
          @change="(v) => updateEffects({ invert: v })"
        />
        <EffectSlider
          :label="t('セピア (古い写真風)', 'セピア')" :value="selectedClip.effects?.sepia ?? 0"
          :min="0" :max="1" :step="0.01"
          @change="(v) => updateEffects({ sepia: v })"
        />
      </section>

      <!-- トランジション -->
      <!-- 音声クリップは映像用の効果 (スライド/ズーム/ワイプ) が意味を持たないため、
           音量フェード専用のメニューを表示する -->
      <section class="section">
        <div class="section-head">
          {{ selectedClip.kind === 'audio'
            ? t('フェード (音量)', 'オーディオフェード')
            : t('トランジション (つなぎ)', 'トランジション') }}
        </div>
        <div class="sub-title">{{ t('入り', '入り') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="selectedClip.transitionIn?.type ?? ''"
              @change="(e) => {
                const t = (e.target as HTMLSelectElement).value
                if (!t) clearTransition('in')
                else setTransition('in', { type: t as TransitionType, duration: selectedClip!.transitionIn?.duration ?? 0.3 })
              }"
            >
              <option value="">なし</option>
              <option value="fade">{{ selectedClip.kind === 'audio' ? 'フェードイン (音が徐々に大きく)' : 'フェードイン (じわっと出る)' }}</option>
              <template v-if="selectedClip.kind !== 'audio'">
                <option value="slide-left">右から入る</option>
                <option value="slide-right">左から入る</option>
                <option value="slide-up">下から入る</option>
                <option value="slide-down">上から入る</option>
                <option value="zoom">ズームイン (大きくなる)</option>
                <option value="wipe">ワイプ (拭って出る)</option>
              </template>
            </select>
          </label>
          <label class="field">
            <span>長さ (秒)</span>
            <input
              type="number"
              min="0"
              step="0.05"
              :value="selectedClip.transitionIn?.duration ?? 0"
              :disabled="!selectedClip.transitionIn"
              @change="(e) => {
                if (!selectedClip!.transitionIn) return
                setTransition('in', { ...selectedClip!.transitionIn, duration: Math.max(0, Number((e.target as HTMLInputElement).value)) })
              }"
            />
          </label>
        </div>
        <div class="row gap-4" style="margin-bottom: 8px;">
          <button class="ghost tiny" @click="applyFadePreset('in')">フェードインを設定</button>
        </div>

        <div class="sub-title">{{ t('出', '出') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="selectedClip.transitionOut?.type ?? ''"
              @change="(e) => {
                const t = (e.target as HTMLSelectElement).value
                if (!t) clearTransition('out')
                else setTransition('out', { type: t as TransitionType, duration: selectedClip!.transitionOut?.duration ?? 0.3 })
              }"
            >
              <option value="">なし</option>
              <option value="fade">{{ selectedClip.kind === 'audio' ? 'フェードアウト (音が徐々に小さく)' : 'フェードアウト (じわっと消える)' }}</option>
              <template v-if="selectedClip.kind !== 'audio'">
                <option value="slide-left">左へ出る</option>
                <option value="slide-right">右へ出る</option>
                <option value="slide-up">上へ出る</option>
                <option value="slide-down">下へ出る</option>
                <option value="zoom">ズームアウト (小さくなる)</option>
                <option value="wipe">ワイプ (拭って消える)</option>
              </template>
            </select>
          </label>
          <label class="field">
            <span>長さ (秒)</span>
            <input
              type="number"
              min="0"
              step="0.05"
              :value="selectedClip.transitionOut?.duration ?? 0"
              :disabled="!selectedClip.transitionOut"
              @change="(e) => {
                if (!selectedClip!.transitionOut) return
                setTransition('out', { ...selectedClip!.transitionOut, duration: Math.max(0, Number((e.target as HTMLInputElement).value)) })
              }"
            />
          </label>
        </div>
        <div class="row gap-4">
          <button class="ghost tiny" @click="applyFadePreset('out')">フェードアウトを設定</button>
        </div>
      </section>

      <!-- 速度 (実素材を持つ動画・音声のみ。静止画/図形/テキストには無意味) -->
      <section v-if="hasVolume(selectedClip)" class="section">
        <div class="section-head">{{ t('再生', '再生') }}</div>
        <label class="field">
          <span>速さ (倍) <span class="mono muted">{{ (selectedClip.speed ?? 1).toFixed(2) }}</span></span>
          <input
            type="range"
            min="0.25"
            max="8"
            step="0.05"
            :value="selectedClip.speed ?? 1"
            @input="(e) => setSpeed(Number((e.target as HTMLInputElement).value))"
          />
        </label>
        <div class="section-hint">
          {{ t(
            '※ 速さを変えてもクリップの長さは変わらず、再生される素材の範囲が変わります',
            '※ 速度変更でクリップ長は変わらず、消費される素材範囲が変わります'
          ) }}
        </div>
      </section>

      <section v-if="hasEffects(selectedClip) || selectedClip.kind === 'shape' || selectedClip.kind === 'text'" class="section">
        <div class="section-head">{{ t('合成', '合成') }}</div>
        <label class="field">
          <span>{{ t('ブレンド', 'ブレンドモード') }}</span>
          <select
            :value="selectedClip.blendMode ?? 'normal'"
            @change="(e) => setBlendMode((e.target as HTMLSelectElement).value as BlendMode)"
          >
            <option v-for="m in BLEND_MODES" :key="m" :value="m">{{ blendLabelJa(m) }}</option>
          </select>
        </label>
      </section>

      <!-- カラーグレーディング -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('カラーグレード (色調整)', 'カラーグレード') }}</span>
          <button class="ghost tiny" @click="resetGrade">{{ t('リセット', 'リセット') }}</button>
        </div>
        <div class="sub-title">暗い部分 (シャドウ)</div>
        <div class="grid-3">
          <EffectSlider label="赤" :value="videoOrImageClip?.colorGrade?.lift?.r ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="緑" :value="videoOrImageClip?.colorGrade?.lift?.g ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="青" :value="videoOrImageClip?.colorGrade?.lift?.b ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <div class="sub-title">中間 (ガンマ)</div>
        <div class="grid-3">
          <EffectSlider label="赤" :value="videoOrImageClip?.colorGrade?.gamma?.r ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="緑" :value="videoOrImageClip?.colorGrade?.gamma?.g ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="青" :value="videoOrImageClip?.colorGrade?.gamma?.b ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <div class="sub-title">明るい部分 (ハイライト)</div>
        <div class="grid-3">
          <EffectSlider label="赤" :value="videoOrImageClip?.colorGrade?.gain?.r ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="緑" :value="videoOrImageClip?.colorGrade?.gain?.g ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="青" :value="videoOrImageClip?.colorGrade?.gain?.b ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <EffectSlider :label="t('暖かさ', '色温度')" :value="videoOrImageClip?.colorGrade?.temperature ?? 0" :min="-1" :max="1" :step="0.01"
          @change="(v) => updateGrade({ temperature: v })" />
        <EffectSlider :label="t('緑〜紫', 'ティント')" :value="videoOrImageClip?.colorGrade?.tint ?? 0" :min="-1" :max="1" :step="0.01"
          @change="(v) => updateGrade({ tint: v })" />
      </section>

      <!-- クロマキー -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('クロマキー (色を透明に)', 'クロマキー') }}</span>
          <button class="ghost tiny" @click="clearChroma">{{ t('解除', '解除') }}</button>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="!!videoOrImageClip?.chromaKey?.enabled"
            @change="(e) => updateChroma({ enabled: (e.target as HTMLInputElement).checked })"
          />
          <span>使う</span>
        </label>
        <div v-if="videoOrImageClip?.chromaKey?.enabled" class="grid-2">
          <label class="field">
            <span>けす いろ</span>
            <input
              type="color"
              :value="videoOrImageClip?.chromaKey.color"
              @input="(e) => updateChroma({ color: (e.target as HTMLInputElement).value })"
            />
          </label>
          <div />
          <EffectSlider :label="t('消す範囲', 'しきい値')" :value="videoOrImageClip?.chromaKey.threshold" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ threshold: v })" />
          <EffectSlider label="ふちの柔らかさ" :value="videoOrImageClip?.chromaKey.softness" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ softness: v })" />
          <EffectSlider label="色残りを減らす" :value="videoOrImageClip?.chromaKey.spillSuppress" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ spillSuppress: v })" />
        </div>
      </section>

      <!-- ピクセルエフェクト (特殊効果) -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>{{ t('特殊効果', 'ピクセルエフェクト') }}</span>
          <button class="ghost tiny" @click="resetPixelFx">{{ t('リセット', 'リセット') }}</button>
        </div>
        <EffectSlider
          :label="t('ビネット (周辺を暗く)', 'ビネット')"
          :value="videoOrImageClip?.pixelFx?.vignette ?? 0" :min="0" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ vignette: v })" />
        <EffectSlider
          :label="t('シャープ (くっきり)', 'シャープ')"
          :value="videoOrImageClip?.pixelFx?.sharpen ?? 0" :min="0" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ sharpen: v })" />
        <EffectSlider
          :label="t('バイブランス (自然な鮮やかさ)', 'バイブランス')"
          :value="videoOrImageClip?.pixelFx?.vibrance ?? 0" :min="-1" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ vibrance: v })" />
        <EffectSlider
          :label="t('フィルムグレイン (ざらつき)', 'フィルムグレイン')"
          :value="videoOrImageClip?.pixelFx?.grain ?? 0" :min="0" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ grain: v })" />
        <EffectSlider
          :label="t('モザイク', 'モザイク')"
          :value="videoOrImageClip?.pixelFx?.pixelate ?? 0" :min="0" :max="40" :step="1"
          @change="(v) => updatePixelFx({ pixelate: v })" />
        <EffectSlider
          :label="t('ポスタライズ (階調を減らす)', 'ポスタライズ')"
          :value="videoOrImageClip?.pixelFx?.posterize ?? 0" :min="0" :max="16" :step="1"
          @change="(v) => updatePixelFx({ posterize: v })" />
        <EffectSlider
          :label="t('二値化 (白黒2階調)', '二値化しきい値')"
          :value="videoOrImageClip?.pixelFx?.threshold ?? 0" :min="0" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ threshold: v })" />
        <EffectSlider
          :label="t('走査線 (横じま)', '走査線')"
          :value="videoOrImageClip?.pixelFx?.scanlines ?? 0" :min="0" :max="1" :step="0.01"
          @change="(v) => updatePixelFx({ scanlines: v })" />
        <EffectSlider
          :label="t('色収差 (RGBずれ)', '色収差')"
          :value="videoOrImageClip?.pixelFx?.chromaticAberration ?? 0" :min="0" :max="10" :step="0.5"
          @change="(v) => updatePixelFx({ chromaticAberration: v })" />
        <label class="toggle" style="margin-top: 6px;">
          <input
            type="checkbox"
            :checked="!!videoOrImageClip?.pixelFx?.duotone?.enabled"
            @change="(e) => updateDuotone({ enabled: (e.target as HTMLInputElement).checked })"
          />
          <span>{{ t('デュオトーン (2色)', 'デュオトーン') }}</span>
        </label>
        <div v-if="videoOrImageClip?.pixelFx?.duotone?.enabled" class="grid-2">
          <label class="field">
            <span>{{ t('暗い部分の色', '暗部の色') }}</span>
            <input
              type="color"
              :value="videoOrImageClip?.pixelFx?.duotone?.shadow ?? '#1a1a4a'"
              @input="(e) => updateDuotone({ shadow: (e.target as HTMLInputElement).value })"
            />
          </label>
          <label class="field">
            <span>{{ t('明るい部分の色', '明部の色') }}</span>
            <input
              type="color"
              :value="videoOrImageClip?.pixelFx?.duotone?.highlight ?? '#ffd98a'"
              @input="(e) => updateDuotone({ highlight: (e.target as HTMLInputElement).value })"
            />
          </label>
        </div>
      </section>

      <!-- テキスト装飾 / アニメ -->
      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">
          <span>{{ t('文字の飾り', 'テキスト装飾') }}</span>
          <button class="ghost tiny" @click="clearDecor">{{ t('解除', '解除') }}</button>
        </div>
        <div class="grid-2">
          <label class="field">
            <span>影の色</span>
            <input
              type="color"
              :value="textClip?.decor?.shadow?.color ?? '#000000'"
              @input="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 8, offsetX: 2, offsetY: 2, color: '#000000' }), color: (e.target as HTMLInputElement).value } })"
            />
          </label>
          <label class="field">
            <span>影のぼかし</span>
            <input
              type="number"
              min="0" step="1"
              :value="textClip?.decor?.shadow?.blur ?? 0"
              @change="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 0, offsetX: 0, offsetY: 0, color: '#000000' }), blur: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>影 (横)</span>
            <input
              type="number"
              step="1"
              :value="textClip?.decor?.shadow?.offsetX ?? 0"
              @change="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 0, offsetX: 0, offsetY: 0, color: '#000000' }), offsetX: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>影 (縦)</span>
            <input
              type="number"
              step="1"
              :value="textClip?.decor?.shadow?.offsetY ?? 0"
              @change="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 0, offsetX: 0, offsetY: 0, color: '#000000' }), offsetY: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>ふちの色</span>
            <input
              type="color"
              :value="textClip?.decor?.outline?.color ?? '#000000'"
              @input="(e) => updateDecor({ outline: { ...(textClip?.decor?.outline ?? { color: '#000000', width: 0 }), color: (e.target as HTMLInputElement).value } })"
            />
          </label>
          <label class="field">
            <span>ふちの太さ</span>
            <input
              type="number"
              min="0" step="0.5"
              :value="textClip?.decor?.outline?.width ?? 0"
              @change="(e) => updateDecor({ outline: { ...(textClip?.decor?.outline ?? { color: '#000000', width: 0 }), width: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>字間</span>
            <input
              type="number"
              step="0.5"
              :value="textClip?.decor?.letterSpacing ?? 0"
              @change="(e) => updateDecor({ letterSpacing: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>行間 (倍)</span>
            <input
              type="number"
              min="1" max="3" step="0.05"
              :value="textClip?.decor?.lineHeight ?? 1.3"
              @change="(e) => updateDecor({ lineHeight: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
      </section>

      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">{{ t('文字のアニメーション', 'テキストアニメ') }}</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="textClip?.anim?.type ?? 'none'"
              @change="(e) => setAnim((e.target as HTMLSelectElement).value as TextAnimType, textClip?.anim?.duration ?? 1)"
            >
              <option v-for="a in TEXT_ANIMS" :key="a" :value="a">{{ animLabelJa(a) }}</option>
            </select>
          </label>
          <label class="field">
            <span>長さ (秒)</span>
            <input
              type="number"
              min="0.1" step="0.1"
              :value="textClip?.anim?.duration ?? 1"
              :disabled="!textClip?.anim"
              @change="(e) => setAnim(textClip?.anim?.type ?? 'none', Number((e.target as HTMLInputElement).value))"
            />
          </label>
        </div>
      </section>

      <!-- 図形 -->
      <section v-if="selectedClip.kind === 'shape'" class="section">
        <div class="section-head">{{ t('図形', '図形') }}</div>
        <label class="field">
          <span>{{ t('図形', '形状') }}</span>
          <select
            :value="shapeClip!.shape"
            @change="(e) => updateShape({ shape: (e.target as HTMLSelectElement).value as ShapeKind })"
          >
            <option v-for="s in SHAPE_KINDS" :key="s" :value="s">{{ shapeLabelJa(s) }}</option>
          </select>
        </label>
        <div class="grid-2">
          <label class="field">
            <span>横幅</span>
            <input
              type="number"
              step="0.01" min="0.01" max="2"
              :value="shapeClip!.width.toFixed(3)"
              @change="(e) => updateShape({ width: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>高さ</span>
            <input
              type="number"
              step="0.01" min="0.01" max="2"
              :value="shapeClip!.height.toFixed(3)"
              @change="(e) => updateShape({ height: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>塗りの色</span>
            <div class="row gap-4">
              <input
                type="color"
                :value="shapeClip!.style.fill ?? '#e8a838'"
                @input="(e) => updateShapeStyle({ fill: (e.target as HTMLInputElement).value })"
              />
              <button class="ghost" @click="updateShapeStyle({ fill: undefined })">なし</button>
            </div>
          </label>
          <label class="field">
            <span>線の色</span>
            <div class="row gap-4">
              <input
                type="color"
                :value="shapeClip!.style.stroke ?? '#ffffff'"
                @input="(e) => updateShapeStyle({ stroke: (e.target as HTMLInputElement).value })"
              />
              <button class="ghost" @click="updateShapeStyle({ stroke: undefined })">なし</button>
            </div>
          </label>
          <label class="field">
            <span>線の太さ</span>
            <input
              type="number"
              min="0" step="1"
              :value="shapeClip!.style.strokeWidth ?? 0"
              @change="(e) => updateShapeStyle({ strokeWidth: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field" v-if="shapeClip!.shape === 'rect'">
            <span>角の丸み</span>
            <input
              type="number"
              min="0" step="1"
              :value="shapeClip!.style.cornerRadius ?? 0"
              @change="(e) => updateShapeStyle({ cornerRadius: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
      </section>

      <!-- EQ (音声/映像) -->
      <section v-if="hasVolume(selectedClip)" class="section">
        <div class="section-head">{{ t('イコライザー (低・中・高音)', 'EQ (3 バンド)') }}</div>
        <div class="grid-3">
          <EffectSlider label="低音" :value="audioLikeClip?.eq?.low ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ low: v })" />
          <EffectSlider label="中音" :value="audioLikeClip?.eq?.mid ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ mid: v })" />
          <EffectSlider label="高音" :value="audioLikeClip?.eq?.high ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ high: v })" />
        </div>
      </section>

      <!-- リンク -->
      <section class="section">
        <div class="row gap-4">
          <button class="ghost tiny" :disabled="selection.selectedClipIds.value.length < 2" @click="linkSelection">🔗 {{ t('リンク', 'リンク') }}</button>
          <button class="ghost tiny" :disabled="!selectedClip.linkGroup" @click="unlinkSelection">🔗 {{ t('リンク解除', '解除') }}</button>
          <span v-if="selectedClip.linkGroup" class="muted mono" style="font-size: 10px">{{ t('リンク中', 'リンク済') }}</span>
        </div>
      </section>

      <!-- 削除 -->
      <section class="section">
        <button class="danger" @click="() => { if (selectedClip) { store.removeClip(selectedClip.id); selection.clearSelection() } }">
          {{ t('このクリップを削除', 'クリップを削除') }}
        </button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.inspector-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px 20px;
  min-height: 0;
}

.empty {
  height: 60%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fg-3);
}
.empty-icon { font-size: 28px; color: var(--line-strong); }
.empty-text { font-size: 11px; }

.section {
  padding: 10px 0;
  border-bottom: 1px dashed var(--line-weak);
}
.section:last-child { border-bottom: none; }

.section-head {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--fg-2);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sub-title {
  font-size: 10px;
  color: var(--fg-2);
  margin: 6px 0 4px;
  letter-spacing: 0.04em;
}

.kind-badge {
  display: inline-block;
  padding: 3px 8px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #1a1408;
  font-weight: 700;
}
.kind-badge.k-video { background: var(--video); }
.kind-badge.k-audio { background: var(--audio); }
.kind-badge.k-image { background: var(--image); }
.kind-badge.k-text  { background: var(--text); }

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 8px;
}
.grid-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 6px;
  margin-bottom: 6px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
}
.field > span {
  color: var(--fg-2);
  display: flex;
  align-items: center;
  gap: 6px;
}
.field .value {
  font-size: 12px;
  padding: 6px 8px;
  background: var(--bg-1);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  color: var(--fg-1);
}
.field input[type="color"] {
  padding: 2px;
  height: 30px;
  width: 100%;
}
.field textarea {
  resize: vertical;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fg-1);
  cursor: pointer;
}
.gap-4 { gap: 8px; }

button.danger {
  color: var(--danger);
  border-color: var(--line);
  width: 100%;
}
button.danger:hover {
  background: rgba(224, 86, 86, 0.1);
  border-color: var(--danger);
}
button.tiny {
  padding: 2px 6px;
  font-size: 10px;
  min-width: 22px;
}

.kf-btn {
  background: none;
  border: 1px solid var(--line);
  color: var(--fg-3);
  padding: 2px 6px;
  font-size: 11px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: color 120ms, background 120ms;
}
.kf-btn:hover:not(:disabled) {
  color: var(--fg-0);
  background: var(--bg-2);
}
.kf-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.kf-btn.on {
  color: var(--accent-hi);
  border-color: var(--accent);
  background: rgba(232, 168, 56, 0.1);
}
.kf-btn.inline {
  padding: 0 5px;
  font-size: 10px;
}

.kf-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.kf-row select {
  flex: 1;
  font-size: 11px;
}
.row {
  display: flex;
  align-items: center;
}

.section-hint {
  font-size: 10px;
  color: var(--fg-3);
  line-height: 1.5;
  margin-top: 6px;
}

.preset-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.preset-chip {
  font-size: 11px;
  padding: 6px 8px;
  background: var(--bg-2);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  color: var(--fg-1);
  cursor: pointer;
  text-align: center;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.preset-chip:hover {
  background: var(--bg-3);
  border-color: var(--accent);
  color: var(--accent-hi);
}
</style>
