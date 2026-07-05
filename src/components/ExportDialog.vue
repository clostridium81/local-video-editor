<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
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

// 用途プリセット: 選ぶと形式/解像度/fps/画質をまとめて設定する
type UsagePreset = 'custom' | 'youtube' | 'youtube60' | 'archive' | 'web' | 'gif'
const usagePreset = ref<UsagePreset>('custom')

// プリセット適用によるフィールド変更を「手動変更」と誤検知しないためのフラグ
let applyingPreset = false

function applyUsagePreset(p: UsagePreset) {
  if (p === 'custom') return // カスタムは何も変更しない
  applyingPreset = true
  if (p === 'youtube') {
    format.value = 'mp4'
    resolutionPreset.value = '1080p'
    fps.value = 30
    bitratePreset.value = 'medium'
  } else if (p === 'youtube60') {
    format.value = 'mp4'
    resolutionPreset.value = '1080p'
    fps.value = 60
    bitratePreset.value = 'high'
  } else if (p === 'archive') {
    format.value = 'mp4'
    resolutionPreset.value = 'project'
    fps.value = store.state.meta.fps
    bitratePreset.value = 'high'
  } else if (p === 'web') {
    format.value = 'webm'
    resolutionPreset.value = '720p'
    fps.value = 30
    bitratePreset.value = 'low'
  } else if (p === 'gif') {
    format.value = 'gif'
    resolutionPreset.value = '480p'
    fps.value = 12
  }
  // プリセットではビットレートは自動計算に任せる
  customBitrate.value = null
  // 同一フラッシュ内で走る手動変更 watch を除外してからフラグを戻す
  nextTick(() => {
    applyingPreset = false
  })
}

watch(usagePreset, p => applyUsagePreset(p))

// 個別項目を手動で変更したらプリセット表示を「カスタム」に戻す
watch([format, fps, resolutionPreset, bitratePreset, customBitrate], () => {
  if (applyingPreset) return
  if (usagePreset.value !== 'custom') usagePreset.value = 'custom'
})

// fps 候補: 定番 + 作品の fps + 現在値 (GIF プリセットの 12 など)。重複は除外
const fpsOptions = computed(() => {
  const base = [24, 30, 60]
  return [...new Set([...base, store.state.meta.fps, fps.value])].sort(
    (a, b) => a - b
  )
})

// In/Out 点が設定されているか (未設定なら「開始〜終了」radio を無効化)
const hasInOut = computed(
  () =>
    store.state.timeline.inPoint != null ||
    store.state.timeline.outPoint != null
)

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

// 推定ファイルサイズ (MB)。映像ビットレート + 音声 192 kbps を長さ分積算
// GIF はビットレートベースの計算が成立しないため対象外 (表示側で目安なしと明示)
const estimatedSizeMB = computed(() => {
  const audioBps =
    includeAudio.value && format.value !== 'gif' ? 192_000 : 0
  return ((resolvedBitrate.value + audioBps) * exportLength.value) / 8 / 1e6
})

// 推定サイズの表示用フォーマット (大きい値は小数を出さない)
function fmtSizeMB(mb: number): string {
  if (mb >= 100) return Math.round(mb).toLocaleString()
  return mb.toFixed(1)
}

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
  if (s < 60) return `残り ${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `残り ${m} 分 ${r} 秒`
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
      '終了は開始より後にしてください',
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
    toast.success(`完成しました: ${filename}`)
    emit('close')
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      toast.info('書き出しを中止しました')
    } else {
      console.error(err)
      toast.error('書き出しに失敗しました: ' + (err?.message ?? err))
    }
  } finally {
    running.value = false
    abortCtrl.value = null
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
  if (p === 'prepare') return '準備中'
  if (p === 'video') return '映像を作成中'
  if (p === 'audio') return '音声を調整中'
  if (p === 'mux') return 'まとめています'
  if (p === 'done') return '完了'
  return p
}

function fmtPhaseMessage(m: string): string {
  if (!m) return ''
  // exportEngine から来る日本語メッセージはそのまま、英語は簡易訳
  if (m === '準備中…') return '準備中…'
  if (m === '映像エンコード中…') return '映像を作成中…'
  if (m === '音声をミックス中…') return '音声を調整中…'
  if (m === '出力中…') return 'まとめています…'
  if (m === '完了') return '完了'
  if (m === 'GIF を合成中…') return 'GIF を作成中…'
  return m
}
</script>

<template>
  <!-- 実行中は背景クリックで閉じない (誤クリックで書き出しが中断されるのを防ぐ)。
       中断は明示的な「キャンセル」ボタンのみ -->
  <div class="modal-backdrop" @click.self="() => { if (!running) emit('close') }">
    <div class="modal">
      <div class="modal-head">
        <div class="title">{{ t('動画を書き出す', '動画書き出し') }}</div>
        <button class="ghost close" :disabled="running" @click="emit('close')">×</button>
      </div>

      <div v-if="!running" class="modal-body">
        <label class="field preset-field">
          <span>{{ t('用途プリセット (よく使う設定をまとめて選べます)', '用途プリセット') }}</span>
          <select v-model="usagePreset">
            <option value="custom">カスタム (手動設定)</option>
            <option value="youtube">YouTube (1080p / 30fps / 高画質 MP4)</option>
            <option value="youtube60">YouTube 60fps (1080p / 60fps / 最高画質 MP4)</option>
            <option value="archive">高画質アーカイブ (作品サイズ / 最高画質)</option>
            <option value="web">Web 軽量 (720p / 30fps / 標準 WebM)</option>
            <option value="gif">GIF アニメ (480p / 12fps)</option>
          </select>
        </label>

        <div class="row-2">
          <label class="field">
            <span>形式</span>
            <select v-model="format">
              <option value="mp4" :disabled="!mp4Supported">MP4 (動画)</option>
              <option value="webm" :disabled="!webmSupported">WebM (動画)</option>
              <option value="gif">GIF (動く画像)</option>
            </select>
          </label>
          <label class="field">
            <span>フレームレート (1秒のコマ数)</span>
            <select v-model.number="fps">
              <option v-for="f in fpsOptions" :key="f" :value="f">
                {{ f }} fps{{ f === store.state.meta.fps ? ' (作品と同じ)' : '' }}
              </option>
            </select>
          </label>
        </div>

        <div class="row-2">
          <label class="field">
            <span>画面サイズ (解像度)</span>
            <select v-model="resolutionPreset">
              <option value="project">
                作品と同じ ({{ store.state.meta.width }}×{{ store.state.meta.height }})
              </option>
              <option value="1080p">1920 × 1080 (大)</option>
              <option value="720p">1280 × 720 (中)</option>
              <option value="480p">854 × 480 (小)</option>
            </select>
          </label>
          <label class="field">
            <span>画質</span>
            <select v-model="bitratePreset">
              <option value="low">標準</option>
              <option value="medium">高画質</option>
              <option value="high">最高画質</option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>ビットレートを指定 (kbps)</span>
          <input
            type="number"
            :value="customBitrate ?? ''"
            placeholder="空欄で自動"
            @change="(e) => {
              const v = (e.target as HTMLInputElement).value
              customBitrate = v ? Number(v) : null
            }"
          />
        </label>

        <label class="toggle" v-if="format !== 'gif'">
          <input type="checkbox" v-model="includeAudio" />
          <span>音声を含める</span>
        </label>

        <div class="field">
          <span>範囲</span>
          <div class="row-3">
            <label class="toggle">
              <input type="radio" value="full" v-model="useRange" />
              <span>全体</span>
            </label>
            <label class="toggle" :class="{ dim: !hasInOut }" :title="hasInOut ? '' : t('タイムラインで I / O キーを押して範囲を設定すると選べます', 'タイムラインで In/Out 点を設定すると選択できます')">
              <input type="radio" value="inout" v-model="useRange" :disabled="!hasInOut" />
              <span>開始〜終了 (In〜Out)</span>
            </label>
            <label class="toggle">
              <input type="radio" value="custom" v-model="useRange" />
              <span>範囲を指定</span>
            </label>
          </div>
        </div>
        <div v-if="useRange === 'custom'" class="row-2">
          <label class="field">
            <span>開始 (秒)</span>
            <input type="number" step="0.1" min="0"
              :max="store.state.timeline.duration"
              v-model.number="customStart" />
          </label>
          <label class="field">
            <span>終了 (秒)</span>
            <input type="number" step="0.1" min="0"
              :max="store.state.timeline.duration"
              v-model.number="customEnd" />
          </label>
        </div>

        <div class="summary muted">
          <div>出力: {{ resolution.width }} × {{ resolution.height }} / {{ fps }} fps</div>
          <div>画質: {{ Math.round(resolvedBitrate / 1000) }} kbps</div>
          <div>長さ: {{ exportLength.toFixed(1) }} 秒</div>
          <div v-if="format === 'gif'">推定サイズ: — (GIF は目安なし)</div>
          <div v-else>推定サイズ: 約 {{ fmtSizeMB(estimatedSizeMB) }} MB</div>
        </div>

        <div class="actions">
          <button class="ghost" @click="emit('close')">{{ t('キャンセル', 'キャンセル') }}</button>
          <button class="primary" @click="onStart">{{ t('書き出しを開始', '動画書き出しを開始') }}</button>
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
          <button class="ghost danger" @click="onCancel">{{ t('キャンセル', 'キャンセル') }}</button>
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
/* 用途プリセット: 最上部で目立つようアクセント枠で囲む */
.preset-field {
  padding: 8px 10px;
  background: var(--bg-2);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
}
.preset-field > span {
  color: var(--accent);
  font-weight: 600;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.toggle.dim {
  opacity: 0.4;
  cursor: not-allowed;
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
