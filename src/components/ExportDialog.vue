<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { toast } from '../composables/useToast'
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

const format = ref<'mp4' | 'webm'>('mp4')
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
  if (s < 60) return `残り ${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `残り ${m}分 ${r}s`
}

async function onStart() {
  if (running.value) return
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
    includeAudio: includeAudio.value,
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
    toast.success(`エクスポート完了: ${filename}`)
    emit('close')
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      toast.info('エクスポートをキャンセルしました')
    } else {
      console.error(err)
      toast.error('エクスポートに失敗しました: ' + (err?.message ?? err))
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
  if (p === 'prepare') return '準備'
  if (p === 'video') return '映像'
  if (p === 'audio') return '音声'
  if (p === 'mux') return '合成'
  if (p === 'done') return '完了'
  return p
}
</script>

<template>
  <div class="modal-backdrop" @click.self="onCancel">
    <div class="modal">
      <div class="modal-head">
        <div class="title">エクスポート</div>
        <button class="ghost close" :disabled="running" @click="emit('close')">×</button>
      </div>

      <div v-if="!running" class="modal-body">
        <div class="row-2">
          <label class="field">
            <span>フォーマット</span>
            <select v-model="format">
              <option value="mp4" :disabled="!mp4Supported">MP4 (H.264 + AAC)</option>
              <option value="webm" :disabled="!webmSupported">WebM (VP9 + Opus)</option>
            </select>
          </label>
          <label class="field">
            <span>FPS</span>
            <select v-model.number="fps">
              <option :value="24">24</option>
              <option :value="30">30</option>
              <option :value="60">60</option>
              <option :value="store.state.meta.fps">
                プロジェクト ({{ store.state.meta.fps }})
              </option>
            </select>
          </label>
        </div>

        <div class="row-2">
          <label class="field">
            <span>解像度</span>
            <select v-model="resolutionPreset">
              <option value="project">
                プロジェクト ({{ store.state.meta.width }}×{{ store.state.meta.height }})
              </option>
              <option value="1080p">1920 × 1080</option>
              <option value="720p">1280 × 720</option>
              <option value="480p">854 × 480</option>
            </select>
          </label>
          <label class="field">
            <span>品質</span>
            <select v-model="bitratePreset">
              <option value="low">低 (3 Mbps)</option>
              <option value="medium">中 (6 Mbps)</option>
              <option value="high">高 (12 Mbps)</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>カスタムビットレート (kbps, 空欄でプリセット使用)</span>
          <input
            type="number"
            :value="customBitrate ?? ''"
            placeholder="例: 8000"
            @change="(e) => {
              const v = (e.target as HTMLInputElement).value
              customBitrate = v ? Number(v) : null
            }"
          />
        </label>

        <label class="toggle">
          <input type="checkbox" v-model="includeAudio" />
          <span>音声を含める</span>
        </label>

        <div class="summary muted">
          <div>最終: {{ resolution.width }} × {{ resolution.height }} @ {{ fps }}fps</div>
          <div>ビットレート: {{ Math.round(resolvedBitrate / 1000) }} kbps</div>
          <div>長さ: {{ store.state.timeline.duration.toFixed(1) }}s</div>
        </div>

        <div class="actions">
          <button class="ghost" @click="emit('close')">キャンセル</button>
          <button class="primary" @click="onStart">エクスポート開始</button>
        </div>
      </div>

      <div v-else class="modal-body">
        <div class="phase-label">
          {{ phaseLabel(progressPhase) }} — {{ progressMessage }}
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
          <button class="ghost danger" @click="onCancel">キャンセル</button>
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
