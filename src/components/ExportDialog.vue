<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { toast } from '../composables/useToast'
import { useLocale } from '../composables/useLocale'

const { t } = useLocale()
import {
  canEncodeVideo,
  canEncodeAudio,
  AVC_CODECS,
  AAC_CODEC,
  VP9_CODEC,
  OPUS_CODEC,
  hasWebCodecs
} from '../engine/capabilities'
import { exportProject, downloadBlob, type ExportOptions } from '../engine/exportEngine'

const emit = defineEmits<{ close: [] }>()
const store = useProjectStore()

const format = ref<'mp4' | 'webm' | 'gif'>('mp4')
const useRange = ref<'full' | 'inout' | 'custom'>(
  store.state.timeline.inPoint != null || store.state.timeline.outPoint != null ? 'inout' : 'full'
)
const customStart = ref(0)
const customEnd = ref(store.state.timeline.duration)
const fps = ref<number>(store.state.meta.fps)
const resolutionPreset = ref<'project' | '1080p' | '720p' | '480p'>('project')
const bitratePreset = ref<'low' | 'medium' | 'high'>('medium')
const customBitrate = ref<number | null>(null)
const includeAudio = ref<boolean>(true)

const running = ref(false)
const progressPhase = ref('')
const progressDone = ref(0)
const progressTotal = ref(1)
const progressMessage = ref('')
const startTime = ref(0)

const mp4Supported = ref(true)
const webmSupported = ref(true)

const resolution = computed(() => {
  if (resolutionPreset.value === 'project') {
    return { width: store.state.meta.width, height: store.state.meta.height }
  }
  if (resolutionPreset.value === '1080p') return { width: 1920, height: 1080 }
  if (resolutionPreset.value === '720p') return { width: 1280, height: 720 }
  return { width: 854, height: 480 }
})

const resolvedBitrate = computed(() => {
  if (customBitrate.value != null && customBitrate.value > 0) {
    return customBitrate.value * 1000 // kbps → bps
  }
  const { width, height } = resolution.value
  const pixels = width * height
  const scale = Math.max(1, pixels / (1920 * 1080))
  if (bitratePreset.value === 'low') return Math.round(3_000_000 * scale)
  if (bitratePreset.value === 'high') return Math.round(12_000_000 * scale)
  return Math.round(6_000_000 * scale)
})

const abortCtrl = ref<AbortController | null>(null)

// 実際に書き出される長さ (秒)。エンジン側のデフォルト範囲と同じ計算
const exportLength = computed(() => {
  const dur = store.state.timeline.duration
  if (useRange.value === 'inout') {
    const s = store.state.timeline.inPoint ?? 0
    const e = store.state.timeline.outPoint ?? dur
    return Math.max(0, e - s)
  }
  if (useRange.value === 'custom') {
    return Math.max(0, Math.min(dur, customEnd.value) - Math.max(0, customStart.value))
  }
  const clips = store.state.clips
  const contentEnd = clips.length > 0
    ? Math.max(...clips.map(c => c.start + c.duration))
    : dur
  return Math.min(dur, contentEnd)
})

onMounted(async () => {
  if (!hasWebCodecs) {
    mp4Supported.value = false
    webmSupported.value = false
    return
  }
  const w = store.state.meta.width
  const h = store.state.meta.height
  const f = store.state.meta.fps
  mp4Supported.value = await canEncodeVideo({
    codec: AVC_CODECS.high_1080p,
    width: w,
    height: h,
    framerate: f,
    bitrate: 6_000_000
  })
  webmSupported.value = await canEncodeVideo({
    codec: VP9_CODEC,
    width: w,
    height: h,
    framerate: f,
    bitrate: 6_000_000
  })
  if (!mp4Supported.value && webmSupported.value) format.value = 'webm'
  const audioOk =
    format.value === 'mp4'
      ? await canEncodeAudio({ codec: AAC_CODEC, sampleRate: 48000, numberOfChannels: 2 })
      : await canEncodeAudio({ codec: OPUS_CODEC, sampleRate: 48000, numberOfChannels: 2 })
  if (!audioOk) includeAudio.value = false
})

const progressPct = computed(() => {
  if (progressTotal.value <= 0) return 0
  return Math.min(100, Math.round((progressDone.value / progressTotal.value) * 100))
})

const etaSec = computed(() => {
  if (!running.value || progressDone.value <= 0) return null
  const elapsed = (Date.now() - startTime.value) / 1000
  const rate = progressDone.value / elapsed
  if (rate <= 0) return null
  const remaining = (progressTotal.value - progressDone.value) / rate
  return Math.max(0, Math.round(remaining))
})

function fmtEta(s: number | null) {
  if (s == null) return '—'
  if (s < 60) return `あと ${s}びょう`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `あと ${m}ふん ${r}びょう`
}

async function onStart() {
  if (running.value) return

  let rangeStart: number | undefined = undefined
  let rangeEnd: number | undefined = undefined
  if (useRange.value === 'inout') {
    rangeStart = store.state.timeline.inPoint ?? 0
    rangeEnd = store.state.timeline.outPoint ?? store.state.timeline.duration
  } else if (useRange.value === 'custom') {
    rangeStart = Math.max(0, customStart.value)
    rangeEnd = Math.min(store.state.timeline.duration, customEnd.value)
  }
  if (rangeStart != null && rangeEnd != null && rangeEnd <= rangeStart) {
    toast.warn(t(
      '「おわり」は「はじめ」より あとに してね',
      '終了時刻は開始時刻より後にしてください'
    ))
    return
  }

  running.value = true
  startTime.value = Date.now()
  progressPhase.value = 'prepare'
  progressDone.value = 0
  progressTotal.value = 1
  progressMessage.value = '準備中…'

  const ctrl = new AbortController()
  abortCtrl.value = ctrl
  store.suspendAutosave()

  const opts: ExportOptions = {
    format: format.value,
    width: resolution.value.width,
    height: resolution.value.height,
    fps: fps.value,
    videoBitrate: resolvedBitrate.value,
    audioBitrate: 192_000,
    includeAudio: includeAudio.value && format.value !== 'gif',
    startTime: rangeStart,
    endTime: rangeEnd,
    signal: ctrl.signal,
    onProgress: p => {
      progressPhase.value = p.phase
      progressDone.value = p.done
      progressTotal.value = p.total
      if (p.message) progressMessage.value = p.message
    }
  }

  try {
    const { blob, filename } = await exportProject(store.serialize(), opts)
    await downloadBlob(blob, filename)
    toast.success(`できたよ: ${filename}`)
    emit('close')
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      toast.info('かきだしを やめたよ')
    } else {
      console.error(err)
      toast.error('かきだしが できなかったよ: ' + (err?.message ?? err))
    }
  } finally {
    running.value = false
    abortCtrl.value = null
    store.resumeAutosave()
  }
}

function onCancel() {
  if (running.value) {
    abortCtrl.value?.abort()
  } else {
    emit('close')
  }
}

function phaseLabel(p: string) {
  if (p === 'prepare') return 'じゅんびちゅう'
  if (p === 'video') return 'えいぞうを つくっているよ'
  if (p === 'audio') return 'おとを ちょうせいしているよ'
  if (p === 'mux') return 'まとめているよ'
  if (p === 'done') return 'できた'
  return p
}

function fmtPhaseMessage(m: string): string {
  if (!m) return ''
  // exportEngine から来る日本語メッセージはそのまま、英語は簡易訳
  if (m === '準備中…') return 'じゅんびちゅう…'
  if (m === '映像エンコード中…') return 'えいぞうを つくっているよ…'
  if (m === '音声をミックス中…') return 'おとを ちょうせいちゅう…'
  if (m === '出力中…') return 'まとめているよ…'
  if (m === '完了') return 'できた'
  if (m === 'GIF を合成中…') return 'GIF を つくっているよ…'
  return m
}
</script>

<template>
  <div class="modal-backdrop" @click.self="onCancel">
    <div class="modal">
      <div class="modal-head">
        <div class="title">{{ t('どうがで かきだす', 'エクスポート') }}</div>
        <button class="ghost close" :disabled="running" @click="emit('close')">×</button>
      </div>

      <div v-if="!running" class="modal-body">
        <div class="row-2">
          <label class="field">
            <span>かたち</span>
            <select v-model="format">
              <option value="mp4" :disabled="!mp4Supported">MP4 (どうが)</option>
              <option value="webm" :disabled="!webmSupported">WebM (どうが)</option>
              <option value="gif">GIF (うごく え)</option>
            </select>
          </label>
          <label class="field">
            <span>1びょうあたりの コマすう</span>
            <select v-model.number="fps">
              <option :value="24">24 コマ</option>
              <option :value="30">30 コマ</option>
              <option :value="60">60 コマ</option>
              <option :value="store.state.meta.fps">
                さくひんと おなじ ({{ store.state.meta.fps }} コマ)
              </option>
            </select>
          </label>
        </div>

        <div class="row-2">
          <label class="field">
            <span>がめんの おおきさ</span>
            <select v-model="resolutionPreset">
              <option value="project">
                さくひんと おなじ ({{ store.state.meta.width }}×{{ store.state.meta.height }})
              </option>
              <option value="1080p">1920 × 1080 (おおきい)</option>
              <option value="720p">1280 × 720 (ふつう)</option>
              <option value="480p">854 × 480 (ちいさい)</option>
            </select>
          </label>
          <label class="field">
            <span>きれいさ</span>
            <select v-model="bitratePreset">
              <option value="low">ふつう</option>
              <option value="medium">きれい</option>
              <option value="high">とても きれい</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>もっと こまかく きめる (kbps)</span>
          <input
            type="number"
            :value="customBitrate ?? ''"
            placeholder="からっぽで OK"
            @change="(e) => {
              const v = (e.target as HTMLInputElement).value
              customBitrate = v ? Number(v) : null
            }"
          />
        </label>

        <label class="toggle" v-if="format !== 'gif'">
          <input type="checkbox" v-model="includeAudio" />
          <span>おとを いれる</span>
        </label>

        <div class="field">
          <span>はんい</span>
          <div class="row-3">
            <label class="toggle">
              <input type="radio" value="full" v-model="useRange" />
              <span>ぜんぶ</span>
            </label>
            <label class="toggle">
              <input type="radio" value="inout" v-model="useRange" />
              <span>はじめ〜おわり</span>
            </label>
            <label class="toggle">
              <input type="radio" value="custom" v-model="useRange" />
              <span>じぶんで きめる</span>
            </label>
          </div>
        </div>
        <div v-if="useRange === 'custom'" class="row-2">
          <label class="field">
            <span>はじめ (びょう)</span>
            <input type="number" step="0.1" min="0"
              :max="store.state.timeline.duration"
              v-model.number="customStart" />
          </label>
          <label class="field">
            <span>おわり (びょう)</span>
            <input type="number" step="0.1" min="0"
              :max="store.state.timeline.duration"
              v-model.number="customEnd" />
          </label>
        </div>

        <div class="summary muted">
          <div>できあがり: {{ resolution.width }} × {{ resolution.height }} / {{ fps }} コマ</div>
          <div>きれいさ: {{ Math.round(resolvedBitrate / 1000) }} kbps</div>
          <div>ながさ: {{ exportLength.toFixed(1) }} びょう</div>
        </div>

        <div class="actions">
          <button class="ghost" @click="emit('close')">{{ t('やめる', 'キャンセル') }}</button>
          <button class="primary" @click="onStart">{{ t('かきだしを はじめる', 'エクスポート開始') }}</button>
        </div>
      </div>

      <div v-else class="modal-body">
        <div class="phase-label">
          {{ phaseLabel(progressPhase) }} — {{ fmtPhaseMessage(progressMessage) }}
        </div>
        <div class="progress-outer">
          <div class="progress-inner" :style="{ width: progressPct + '%' }" />
        </div>
        <div class="progress-meta muted">
          <span>{{ progressDone }} / {{ progressTotal }}</span>
          <span>{{ progressPct }}%</span>
          <span>{{ fmtEta(etaSec) }}</span>
        </div>
        <div class="actions">
          <button class="ghost danger" @click="onCancel">{{ t('やめる', 'キャンセル') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  z-index: 9500;
}
.modal {
  width: 460px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line-weak);
}
.title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.close {
  background: none;
  border: none;
  color: var(--fg-2);
  font-size: 18px;
  cursor: pointer;
}
.modal-body {
  padding: 16px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.row-3 {
  display: flex;
  gap: 10px;
  align-items: center;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
}
.field > span {
  color: var(--fg-2);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.summary {
  font-size: 11px;
  line-height: 1.6;
  padding: 8px 10px;
  background: var(--bg-2);
  border: 1px solid var(--line-weak);
  border-radius: var(--radius-sm);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
button.danger {
  color: var(--danger);
}
.progress-outer {
  height: 8px;
  background: var(--bg-2);
  border: 1px solid var(--line-weak);
  border-radius: 4px;
  overflow: hidden;
}
.progress-inner {
  height: 100%;
  background: linear-gradient(90deg, var(--accent) 0%, var(--accent-hi) 100%);
  transition: width 120ms;
}
.progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-family: var(--font-mono);
}
.phase-label {
  font-size: 13px;
  letter-spacing: 0.04em;
}
</style>
