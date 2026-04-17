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
  KeyframeableProperty,
  Easing,
  TransitionType,
  ClipEffects,
  Transition
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
