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
  TextDecor,
  TextAnim,
  TextAnimType,
  AudioEQ
} from '../types/project'
import { findKeyframeAt, neighborKeyframes } from '../engine/keyframes'
import EffectSlider from './EffectSlider.vue'

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
  store.updateClip(id, patch as any)
}

function updateEffects(patch: Partial<ClipEffects>) {
  const c = selectedClip.value
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) return
  const prev = (c as VideoClip | ImageClip).effects ?? {}
  store.setEffects(c.id, { ...prev, ...patch })
}

function hasTransform(c: Clip): c is VideoClip | ImageClip | TextClip {
  return c.kind === 'video' || c.kind === 'image' || c.kind === 'text'
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
  setTransition(side, { type: 'fade', duration: 0.5 })
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
function setReversed(v: boolean) {
  const c = selectedClip.value
  if (!c) return
  store.updateClip(c.id, { reversed: v } as any)
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
</script>

<template>
  <div class="panel-title">
    <span>Inspector</span>
  </div>

  <div class="inspector-body">
    <div v-if="!selectedClip" class="empty">
      <div class="empty-icon">◇</div>
      <div class="empty-text">クリップを選択してください</div>
    </div>

    <template v-else>
      <section class="section">
        <div class="kind-badge" :class="'k-' + selectedClip.kind">
          {{ selectedClip.kind }}
        </div>
      </section>

      <!-- 時間プロパティ -->
      <section class="section">
        <div class="section-head">時間</div>
        <div class="grid-2">
          <label class="field">
            <span>開始</span>
            <input
              type="number"
              step="0.01"
              :value="selectedClip.start.toFixed(2)"
              @change="(e) => update({ start: Math.max(0, Number((e.target as HTMLInputElement).value)) })"
            />
          </label>
          <label class="field">
            <span>長さ</span>
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
            <span>素材内オフセット</span>
            <input
              type="number"
              step="0.01"
              :value="(selectedClip.sourceIn ?? 0).toFixed(2)"
              @change="(e) => update({ sourceIn: Math.max(0, Number((e.target as HTMLInputElement).value)) })"
            />
          </label>
          <div class="field">
            <span>終了</span>
            <div class="value mono">{{ fmtSec(selectedClip.start + selectedClip.duration) }}</div>
          </div>
        </div>
      </section>

      <!-- 不透明度 -->
      <section v-if="hasTransform(selectedClip)" class="section">
        <div class="section-head">
          <span>表示</span>
          <button
            class="kf-btn"
            :class="{ on: kfExistsAt('opacity') }"
            :disabled="!playheadInClip"
            title="この時刻にキーフレームを追加/削除"
            @click="toggleKeyframe('opacity')"
          >◆</button>
        </div>
        <label class="field">
          <span>
            不透明度
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
      <section v-if="hasTransform(selectedClip)" class="section">
        <div class="section-head">配置</div>
        <div class="grid-2">
          <label class="field">
            <span>
              X (中央基準)
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
              Y (中央基準)
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
          v-if="selectedClip.kind === 'video' || selectedClip.kind === 'image' || selectedClip.kind === 'text'"
          class="grid-2"
        >
          <label v-if="selectedClip.kind !== 'text'" class="field">
            <span>
              スケール
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
          <label v-if="selectedClip.kind !== 'text'" class="field">
            <span>
              回転 (度)
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
              :value="(selectedClip as VideoClip | ImageClip).rotation"
              @change="(e) => update({ rotation: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
        </div>
      </section>

      <!-- テキスト固有 -->
      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">テキスト</div>
        <label class="field">
          <span>内容</span>
          <textarea
            rows="3"
            :value="(selectedClip as TextClip).text"
            @input="(e) => update({ text: (e.target as HTMLTextAreaElement).value })"
          />
        </label>
        <label class="field">
          <span>フォント</span>
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
            <span>サイズ (px)</span>
            <input
              type="number"
              min="8"
              step="1"
              :value="(selectedClip as TextClip).fontSize"
              @change="(e) => update({ fontSize: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>配置</span>
            <select
              :value="(selectedClip as TextClip).align"
              @change="(e) => update({ align: (e.target as HTMLSelectElement).value as any })"
            >
              <option value="left">左</option>
              <option value="center">中央</option>
              <option value="right">右</option>
            </select>
          </label>
        </div>
        <div class="grid-2">
          <label class="field">
            <span>文字色</span>
            <input
              type="color"
              :value="(selectedClip as TextClip).color"
              @input="(e) => update({ color: (e.target as HTMLInputElement).value })"
            />
          </label>
          <label class="field">
            <span>背景色</span>
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
          <span>音声</span>
          <button
            class="kf-btn"
            :class="{ on: kfExistsAt('volume') }"
            :disabled="!playheadInClip"
            @click="toggleKeyframe('volume')"
          >◆</button>
        </div>
        <label class="field">
          <span>
            音量 <span class="mono muted">{{ ((selectedClip.volume ?? 1) * 100).toFixed(0) }}%</span>
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
          <span>ミュート</span>
        </label>
      </section>

      <!-- エフェクト (映像/画像) -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>エフェクト</span>
          <button class="ghost tiny" @click="resetEffects">リセット</button>
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
          label="彩度" :value="selectedClip.effects?.saturation ?? 1"
          :min="0" :max="3" :step="0.01"
          @change="(v) => updateEffects({ saturation: v })"
        />
        <EffectSlider
          label="ブラー" :value="selectedClip.effects?.blur ?? 0"
          :min="0" :max="50" :step="0.5"
          @change="(v) => updateEffects({ blur: v })"
        />
        <EffectSlider
          label="色相回転" :value="selectedClip.effects?.hueRotate ?? 0"
          :min="-180" :max="180" :step="1"
          @change="(v) => updateEffects({ hueRotate: v })"
        />
        <EffectSlider
          label="グレースケール" :value="selectedClip.effects?.grayscale ?? 0"
          :min="0" :max="1" :step="0.01"
          @change="(v) => updateEffects({ grayscale: v })"
        />
        <EffectSlider
          label="反転" :value="selectedClip.effects?.invert ?? 0"
          :min="0" :max="1" :step="0.01"
          @change="(v) => updateEffects({ invert: v })"
        />
        <EffectSlider
          label="セピア" :value="selectedClip.effects?.sepia ?? 0"
          :min="0" :max="1" :step="0.01"
          @change="(v) => updateEffects({ sepia: v })"
        />
      </section>

      <!-- トランジション -->
      <section class="section">
        <div class="section-head">トランジション</div>
        <div class="sub-title">入り</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="selectedClip.transitionIn?.type ?? ''"
              @change="(e) => {
                const t = (e.target as HTMLSelectElement).value
                if (!t) clearTransition('in')
                else setTransition('in', { type: t as TransitionType, duration: selectedClip!.transitionIn?.duration ?? 0.5 })
              }"
            >
              <option value="">なし</option>
              <option value="fade">fade</option>
              <option value="slide-left">slide-left</option>
              <option value="slide-right">slide-right</option>
              <option value="slide-up">slide-up</option>
              <option value="slide-down">slide-down</option>
              <option value="zoom">zoom</option>
              <option value="wipe">wipe</option>
            </select>
          </label>
          <label class="field">
            <span>時間 (s)</span>
            <input
              type="number"
              min="0"
              step="0.1"
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
          <button class="ghost tiny" @click="applyFadePreset('in')">フェードイン</button>
        </div>

        <div class="sub-title">出</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="selectedClip.transitionOut?.type ?? ''"
              @change="(e) => {
                const t = (e.target as HTMLSelectElement).value
                if (!t) clearTransition('out')
                else setTransition('out', { type: t as TransitionType, duration: selectedClip!.transitionOut?.duration ?? 0.5 })
              }"
            >
              <option value="">なし</option>
              <option value="fade">fade</option>
              <option value="slide-left">slide-left</option>
              <option value="slide-right">slide-right</option>
              <option value="slide-up">slide-up</option>
              <option value="slide-down">slide-down</option>
              <option value="zoom">zoom</option>
              <option value="wipe">wipe</option>
            </select>
          </label>
          <label class="field">
            <span>時間 (s)</span>
            <input
              type="number"
              min="0"
              step="0.1"
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
          <button class="ghost tiny" @click="applyFadePreset('out')">フェードアウト</button>
        </div>
      </section>

      <!-- 速度 / 逆再生 / ブレンド -->
      <section v-if="selectedClip.kind !== 'text' && selectedClip.kind !== 'shape'" class="section">
        <div class="section-head">再生</div>
        <div class="grid-2">
          <label class="field">
            <span>速度 (×) <span class="mono muted">{{ (selectedClip.speed ?? 1).toFixed(2) }}</span></span>
            <input
              type="range"
              min="0.25"
              max="4"
              step="0.05"
              :value="selectedClip.speed ?? 1"
              @input="(e) => setSpeed(Number((e.target as HTMLInputElement).value))"
            />
          </label>
          <label class="toggle" style="align-self: end;">
            <input
              type="checkbox"
              :checked="!!selectedClip.reversed"
              @change="(e) => setReversed((e.target as HTMLInputElement).checked)"
            />
            <span>逆再生</span>
          </label>
        </div>
      </section>

      <section v-if="hasEffects(selectedClip) || selectedClip.kind === 'shape' || selectedClip.kind === 'text'" class="section">
        <div class="section-head">合成</div>
        <label class="field">
          <span>ブレンドモード</span>
          <select
            :value="selectedClip.blendMode ?? 'normal'"
            @change="(e) => setBlendMode((e.target as HTMLSelectElement).value as BlendMode)"
          >
            <option v-for="m in BLEND_MODES" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
      </section>

      <!-- カラーグレーディング -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>カラーグレード</span>
          <button class="ghost tiny" @click="resetGrade">リセット</button>
        </div>
        <div class="sub-title">Lift (シャドウ)</div>
        <div class="grid-3">
          <EffectSlider label="R" :value="videoOrImageClip?.colorGrade?.lift?.r ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="G" :value="videoOrImageClip?.colorGrade?.lift?.g ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="B" :value="videoOrImageClip?.colorGrade?.lift?.b ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ lift: { ...(videoOrImageClip?.colorGrade?.lift ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <div class="sub-title">Gamma (ミッドトーン)</div>
        <div class="grid-3">
          <EffectSlider label="R" :value="videoOrImageClip?.colorGrade?.gamma?.r ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="G" :value="videoOrImageClip?.colorGrade?.gamma?.g ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="B" :value="videoOrImageClip?.colorGrade?.gamma?.b ?? 0" :min="-1" :max="1" :step="0.01"
            @change="(v) => updateGrade({ gamma: { ...(videoOrImageClip?.colorGrade?.gamma ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <div class="sub-title">Gain (ハイライト)</div>
        <div class="grid-3">
          <EffectSlider label="R" :value="videoOrImageClip?.colorGrade?.gain?.r ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), r: v } })" />
          <EffectSlider label="G" :value="videoOrImageClip?.colorGrade?.gain?.g ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), g: v } })" />
          <EffectSlider label="B" :value="videoOrImageClip?.colorGrade?.gain?.b ?? 0" :min="-0.5" :max="0.5" :step="0.01"
            @change="(v) => updateGrade({ gain: { ...(videoOrImageClip?.colorGrade?.gain ?? { r: 0, g: 0, b: 0 }), b: v } })" />
        </div>
        <EffectSlider label="色温度" :value="videoOrImageClip?.colorGrade?.temperature ?? 0" :min="-1" :max="1" :step="0.01"
          @change="(v) => updateGrade({ temperature: v })" />
        <EffectSlider label="ティント" :value="videoOrImageClip?.colorGrade?.tint ?? 0" :min="-1" :max="1" :step="0.01"
          @change="(v) => updateGrade({ tint: v })" />
      </section>

      <!-- クロマキー -->
      <section v-if="hasEffects(selectedClip)" class="section">
        <div class="section-head">
          <span>クロマキー</span>
          <button class="ghost tiny" @click="clearChroma">解除</button>
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            :checked="!!videoOrImageClip?.chromaKey?.enabled"
            @change="(e) => updateChroma({ enabled: (e.target as HTMLInputElement).checked })"
          />
          <span>有効化</span>
        </label>
        <div v-if="videoOrImageClip?.chromaKey?.enabled" class="grid-2">
          <label class="field">
            <span>キーカラー</span>
            <input
              type="color"
              :value="videoOrImageClip?.chromaKey.color"
              @input="(e) => updateChroma({ color: (e.target as HTMLInputElement).value })"
            />
          </label>
          <div />
          <EffectSlider label="閾値" :value="videoOrImageClip?.chromaKey.threshold" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ threshold: v })" />
          <EffectSlider label="柔らかさ" :value="videoOrImageClip?.chromaKey.softness" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ softness: v })" />
          <EffectSlider label="スピル抑制" :value="videoOrImageClip?.chromaKey.spillSuppress" :min="0" :max="1" :step="0.01"
            @change="(v) => updateChroma({ spillSuppress: v })" />
        </div>
      </section>

      <!-- テキスト装飾 / アニメ -->
      <section v-if="selectedClip.kind === 'text'" class="section">
        <div class="section-head">
          <span>テキスト装飾</span>
          <button class="ghost tiny" @click="clearDecor">解除</button>
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
            <span>影 X</span>
            <input
              type="number"
              step="1"
              :value="textClip?.decor?.shadow?.offsetX ?? 0"
              @change="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 0, offsetX: 0, offsetY: 0, color: '#000000' }), offsetX: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>影 Y</span>
            <input
              type="number"
              step="1"
              :value="textClip?.decor?.shadow?.offsetY ?? 0"
              @change="(e) => updateDecor({ shadow: { ...(textClip?.decor?.shadow ?? { blur: 0, offsetX: 0, offsetY: 0, color: '#000000' }), offsetY: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>アウトライン色</span>
            <input
              type="color"
              :value="textClip?.decor?.outline?.color ?? '#000000'"
              @input="(e) => updateDecor({ outline: { ...(textClip?.decor?.outline ?? { color: '#000000', width: 0 }), color: (e.target as HTMLInputElement).value } })"
            />
          </label>
          <label class="field">
            <span>アウトライン幅</span>
            <input
              type="number"
              min="0" step="0.5"
              :value="textClip?.decor?.outline?.width ?? 0"
              @change="(e) => updateDecor({ outline: { ...(textClip?.decor?.outline ?? { color: '#000000', width: 0 }), width: Number((e.target as HTMLInputElement).value) } })"
            />
          </label>
          <label class="field">
            <span>字間 (px)</span>
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
        <div class="section-head">テキストアニメ</div>
        <div class="grid-2">
          <label class="field">
            <span>種類</span>
            <select
              :value="textClip?.anim?.type ?? 'none'"
              @change="(e) => setAnim((e.target as HTMLSelectElement).value as TextAnimType, textClip?.anim?.duration ?? 1)"
            >
              <option v-for="a in TEXT_ANIMS" :key="a" :value="a">{{ a }}</option>
            </select>
          </label>
          <label class="field">
            <span>時間 (s)</span>
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
        <div class="section-head">図形</div>
        <label class="field">
          <span>形状</span>
          <select
            :value="shapeClip!.shape"
            @change="(e) => updateShape({ shape: (e.target as HTMLSelectElement).value as ShapeKind })"
          >
            <option v-for="s in SHAPE_KINDS" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <div class="grid-2">
          <label class="field">
            <span>幅 (0..1)</span>
            <input
              type="number"
              step="0.01" min="0.01" max="2"
              :value="shapeClip!.width.toFixed(3)"
              @change="(e) => updateShape({ width: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>高さ (0..1)</span>
            <input
              type="number"
              step="0.01" min="0.01" max="2"
              :value="shapeClip!.height.toFixed(3)"
              @change="(e) => updateShape({ height: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field">
            <span>塗り</span>
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
            <span>線</span>
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
            <span>線幅</span>
            <input
              type="number"
              min="0" step="1"
              :value="shapeClip!.style.strokeWidth ?? 0"
              @change="(e) => updateShapeStyle({ strokeWidth: Number((e.target as HTMLInputElement).value) })"
            />
          </label>
          <label class="field" v-if="shapeClip!.shape === 'rect'">
            <span>角丸 (px)</span>
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
        <div class="section-head">EQ (3 バンド)</div>
        <div class="grid-3">
          <EffectSlider label="低" :value="audioLikeClip?.eq?.low ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ low: v })" />
          <EffectSlider label="中" :value="audioLikeClip?.eq?.mid ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ mid: v })" />
          <EffectSlider label="高" :value="audioLikeClip?.eq?.high ?? 0" :min="-24" :max="24" :step="0.5"
            @change="(v) => updateEQ({ high: v })" />
        </div>
      </section>

      <!-- リンク -->
      <section class="section">
        <div class="row gap-4">
          <button class="ghost tiny" :disabled="selection.selectedClipIds.value.length < 2" @click="linkSelection">🔗 リンク</button>
          <button class="ghost tiny" :disabled="!selectedClip.linkGroup" @click="unlinkSelection">🔗 解除</button>
          <span v-if="selectedClip.linkGroup" class="muted mono" style="font-size: 10px">リンク済</span>
        </div>
      </section>

      <!-- 削除 -->
      <section class="section">
        <button class="danger" @click="() => { if (selectedClip) { store.removeClip(selectedClip.id); selection.clearSelection() } }">
          クリップを削除
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
</style>
