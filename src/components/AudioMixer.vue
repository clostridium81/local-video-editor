<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { loadAssetBlob } from '../persistence/assetStore'
import { getOrGeneratePeaks } from '../engine/waveform'
import { useLocale } from '../composables/useLocale'

const { t } = useLocale()

defineEmits<{ close: [] }>()

const store = useProjectStore()

// リアルタイム VU メーター用の AudioContext
// Offline ではなく現在の再生に対してモニタしたいが、プレビューエンジンの <audio>/<video>
// から解析するには MediaElementAudioSourceNode が必要で、1 度限り。
// 今回は「シーク中の音量スナップショット」を簡易表示する:
// - 各音声クリップの current localTime に対して waveform peaks から RMS を推定。
// - 100ms 毎に更新。

const liveLevels = ref<Map<string, number>>(new Map())

let tick: number | null = null

function sampleNow() {
  const t = store.state.timeline.playhead
  const next = new Map<string, number>()
  for (const tr of store.state.tracks) {
    if (tr.kind !== 'audio') continue
    let maxAmp = 0
    // このトラック上でアクティブな音声/映像クリップを考慮
    for (const c of store.state.clips) {
      if (c.trackId !== tr.id) continue
      if (c.kind !== 'audio' && c.kind !== 'video') continue
      if (t < c.start || t > c.start + c.duration) continue
      const assetId = (c as any).assetId as string
      const peaksWrap = peaksCache.value.get(assetId)
      if (!peaksWrap) continue
      const peaks = peaksWrap
      const speed = c.speed ?? 1
      const local = (t - c.start) * speed + (c.sourceIn ?? 0)
      const bucket = Math.floor(local * peaks.peaksPerSecond)
      const b = Math.max(0, Math.min(peaks.min.length - 1, bucket))
      const amp = Math.max(Math.abs(peaks.min[b]), Math.abs(peaks.max[b]))
      const vol = (c.volume ?? 1) * (tr.volume ?? 1) * (store.state.timeline.masterVolume ?? 1)
      maxAmp = Math.max(maxAmp, amp * vol)
    }
    next.set(tr.id, maxAmp)
  }
  liveLevels.value = next
}

// peaks キャッシュ参照
const peaksCache = ref<Map<string, any>>(new Map())
async function ensureAllPeaks() {
  const ids = new Set<string>()
  for (const c of store.state.clips) {
    if (c.kind === 'audio' || c.kind === 'video') ids.add((c as any).assetId)
  }
  for (const id of ids) {
    if (peaksCache.value.has(id)) continue
    const peaks = await getOrGeneratePeaks(id, () => loadAssetBlob(store.meta.id, id))
    if (peaks) {
      peaksCache.value.set(id, peaks)
      peaksCache.value = new Map(peaksCache.value)
    }
  }
}

onMounted(() => {
  ensureAllPeaks()
  tick = window.setInterval(sampleNow, 80)
})
onBeforeUnmount(() => {
  if (tick) window.clearInterval(tick)
})

watch(
  () => store.state.clips.map(c => (c as any).assetId).filter(Boolean),
  () => ensureAllPeaks()
)

function levelPct(v: number) {
  return Math.max(0, Math.min(100, v * 100))
}
function levelColor(v: number) {
  if (v > 0.9) return 'linear-gradient(180deg, #e05656 0%, #9a3232 100%)'
  if (v > 0.7) return 'linear-gradient(180deg, #e8a838 0%, #b87d1c 100%)'
  return 'linear-gradient(180deg, #7dd67d 0%, #3f9f3f 100%)'
}

const audioTracks = computed(() => store.state.tracks.filter(t => t.kind === 'audio'))
</script>

<template>
  <div class="mixer-panel">
    <div class="head">
      <div class="title">{{ t('音声ミキサー', 'オーディオミキサー') }}</div>
      <button class="ghost" @click="$emit('close')">×</button>
    </div>
    <div class="strips">
      <div class="strip master">
        <div class="name mono">{{ t('全体', 'MASTER') }}</div>
        <div class="meter">
          <div class="meter-fill" :style="{ height: levelPct(Array.from(liveLevels.values()).reduce((a, b) => Math.max(a, b), 0)) + '%', background: levelColor(Array.from(liveLevels.values()).reduce((a, b) => Math.max(a, b), 0)) }" />
        </div>
        <input
          type="range"
          orient="vertical"
          min="0" max="2" step="0.01"
          :value="store.state.timeline.masterVolume ?? 1"
          @input="(e) => store.setMasterVolume(Number((e.target as HTMLInputElement).value))"
        />
        <div class="val mono">{{ ((store.state.timeline.masterVolume ?? 1) * 100).toFixed(0) }}%</div>
      </div>
      <div
        v-for="tr in audioTracks"
        :key="tr.id"
        class="strip"
        :class="{ muted: tr.muted, solo: tr.solo }"
      >
        <div class="name mono">{{ tr.name }}</div>
        <div class="meter">
          <div class="meter-fill" :style="{ height: levelPct(liveLevels.get(tr.id) ?? 0) + '%', background: levelColor(liveLevels.get(tr.id) ?? 0) }" />
        </div>
        <input
          type="range"
          orient="vertical"
          min="0" max="2" step="0.01"
          :value="tr.volume ?? 1"
          @input="(e) => store.updateTrack(tr.id, { volume: Number((e.target as HTMLInputElement).value) })"
        />
        <div class="val mono">{{ ((tr.volume ?? 1) * 100).toFixed(0) }}%</div>
        <div class="buttons">
          <button class="ghost tiny" :class="{ active: tr.solo }" @click="store.updateTrack(tr.id, { solo: !tr.solo })">S</button>
          <button class="ghost tiny" :class="{ active: tr.muted }" @click="store.updateTrack(tr.id, { muted: !tr.muted })">M</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mixer-panel {
  position: fixed;
  right: 20px;
  bottom: 20px;
  width: 560px;
  max-height: 420px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  z-index: 7000;
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line-weak);
}
.title {
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-1);
}
.strips {
  display: flex;
  gap: 8px;
  padding: 12px;
  overflow-x: auto;
  flex: 1;
  min-height: 0;
}
.strip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 6px;
  background: var(--bg-2);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
  min-width: 64px;
}
.strip.master {
  background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
  border-color: var(--accent-dim);
}
.strip.muted { opacity: 0.5; }
.strip.solo { border-color: var(--accent); }
.name {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--fg-2);
}
.meter {
  width: 12px;
  height: 180px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  border-radius: 3px;
  position: relative;
  overflow: hidden;
}
.meter-fill {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  transition: height 80ms;
}
input[type="range"][orient="vertical"] {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 12px;
  height: 80px;
  accent-color: var(--accent);
}
.val {
  font-size: 10px;
  color: var(--fg-2);
}
.buttons {
  display: flex;
  gap: 4px;
}
button.tiny {
  padding: 2px 6px;
  font-size: 10px;
  min-width: 22px;
}
button.tiny.active {
  background: var(--accent-dim);
  color: var(--accent-hi);
  border-color: var(--accent);
}
</style>
