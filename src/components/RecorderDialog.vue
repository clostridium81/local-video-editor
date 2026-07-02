<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { useProjectStore } from '../stores/projectStore'
import { toast } from '../composables/useToast'
import { useLocale } from '../composables/useLocale'

const locale = useLocale()
const { t } = locale

const emit = defineEmits<{ close: [] }>()
const store = useProjectStore()

type Mode = 'camera' | 'screen' | 'mic' | 'tts'
const mode = ref<Mode>('camera')
const recording = ref(false)
const elapsed = ref(0)
let timer: number | null = null
let mediaRecorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []
const previewRef = ref<HTMLVideoElement>()

// TTS
const ttsText = ref('')
const ttsRate = ref(1)
const ttsPitch = ref(1)
const ttsVoice = ref<string>('')
const voices = ref<SpeechSynthesisVoice[]>([])
function loadVoices() {
  const list = window.speechSynthesis?.getVoices() ?? []
  voices.value = list
  if (list.length > 0 && !ttsVoice.value) ttsVoice.value = list[0].name
}
if (typeof window !== 'undefined' && window.speechSynthesis) {
  loadVoices()
  window.speechSynthesis.onvoiceschanged = loadVoices
}

async function startRecording() {
  if (recording.value) return
  chunks = []
  try {
    if (mode.value === 'camera') {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    } else if (mode.value === 'screen') {
      stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: true })
    } else if (mode.value === 'mic') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } else {
      toast.warn('「読み上げを作る」ボタンを使ってください')
      return
    }
    if (previewRef.value && stream && mode.value !== 'mic') {
      previewRef.value.srcObject = stream
      previewRef.value.play().catch(() => {})
    }
    const mimeType =
      mode.value === 'mic'
        ? (MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm')
        : (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm')
    if (!stream) throw new Error('カメラ・マイクの映像を取得できませんでした')
    mediaRecorder = new MediaRecorder(stream, { mimeType })
    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    })
    mediaRecorder.addEventListener('stop', handleRecorderStop)
    mediaRecorder.start(250)
    recording.value = true
    elapsed.value = 0
    const t0 = Date.now()
    timer = window.setInterval(() => {
      elapsed.value = (Date.now() - t0) / 1000
    }, 100)
  } catch (err: any) {
    console.error(err)
    toast.error('録画・録音ができませんでした: ' + (err?.message ?? ''))
    stopStream()
  }
}

function stopRecording() {
  if (!recording.value || !mediaRecorder) return
  mediaRecorder.stop()
}

async function handleRecorderStop() {
  if (timer) window.clearInterval(timer), (timer = null)
  recording.value = false
  const ext = mode.value === 'mic' ? 'webm' : 'webm'
  const name = `${mode.value}-record__${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`
  const blob = new Blob(chunks, { type: mediaRecorder?.mimeType ?? 'video/webm' })
  chunks = []
  stopStream()
  try {
    const file = new File([blob], name, { type: blob.type })
    await store.addAssetFromFile(file)
    toast.success(`録画を素材に追加しました: ${name}`)
  } catch (err) {
    console.error(err)
    toast.error('素材に追加できませんでした')
  }
  emit('close')
}

function stopStream() {
  if (stream) {
    for (const t of stream.getTracks()) t.stop()
    stream = null
  }
  if (previewRef.value) previewRef.value.srcObject = null
  if (mediaRecorder) mediaRecorder = null
}

// ---------- TTS ----------

async function generateTTS() {
  const text = ttsText.value.trim()
  if (!text) {
    toast.warn('読み上げる文章を入力してください')
    return
  }
  if (!window.speechSynthesis) {
    toast.error('この端末では読み上げが使えません')
    return
  }

  // AudioContext + MediaStreamDestination + MediaRecorder で captureStream 相当
  // ただし SpeechSynthesis は Web Audio に直接ルートできない。
  // 回避: 発話中の AudioContext 出力をキャプチャできないため、
  // Utterance を鳴らしつつ MediaRecorder でタブの音声をキャプチャする
  // — ただし getUserMedia({ audio: { ... } }) ではマイクしか取れない。
  //
  // 実用策: getDisplayMedia({ audio: true }) で「タブの音声」を許可してもらう方式。
  try {
    const stream = await (navigator.mediaDevices as any).getDisplayMedia({
      video: true, audio: true
    })
    // video トラックは捨てる
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t: MediaStreamTrack) => t.stop())
      toast.warn('「音声も共有する」にチェックを入れてください')
      return
    }
    const audioStream = new MediaStream(audioTracks)
    // video は録画不要なので停止
    stream.getVideoTracks().forEach((t: MediaStreamTrack) => t.stop())

    const rec = new MediaRecorder(audioStream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    })
    const ttsChunks: Blob[] = []
    rec.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) ttsChunks.push(e.data)
    })
    const done: Promise<void> = new Promise(res => {
      rec.addEventListener('stop', () => res(), { once: true })
    })
    rec.start(250)

    const u = new SpeechSynthesisUtterance(text)
    u.rate = ttsRate.value
    u.pitch = ttsPitch.value
    const v = voices.value.find(x => x.name === ttsVoice.value)
    if (v) u.voice = v
    await new Promise<void>((resolve) => {
      u.onend = () => resolve()
      u.onerror = () => resolve()
      window.speechSynthesis.speak(u)
    })
    // すこしバッファ分待ってから止める
    await new Promise(r => setTimeout(r, 400))
    rec.stop()
    await done
    audioStream.getTracks().forEach(t => t.stop())

    const blob = new Blob(ttsChunks, { type: 'audio/webm' })
    const file = new File([blob], `tts__${Date.now()}.webm`, { type: 'audio/webm' })
    await store.addAssetFromFile(file)
    toast.success('読み上げの音声を素材に追加しました')
    emit('close')
  } catch (err: any) {
    console.error(err)
    toast.error('読み上げができませんでした: ' + (err?.message ?? ''))
  }
}

onBeforeUnmount(() => stopStream())

function fmt(s: number) {
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = (s % 60).toFixed(1).padStart(4, '0')
  return `${mm}:${ss}`
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <div class="title">{{ t('録画・録音 / ナレーション', '録音・録画 / ナレーション') }}</div>
        <button class="ghost close" :disabled="recording" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <div class="tabs">
          <button class="ghost" :class="{ active: mode === 'camera' }" @click="mode = 'camera'">{{ t('カメラ', 'カメラ') }}</button>
          <button class="ghost" :class="{ active: mode === 'screen' }" @click="mode = 'screen'">{{ t('画面', '画面') }}</button>
          <button class="ghost" :class="{ active: mode === 'mic' }" @click="mode = 'mic'">{{ t('マイク', 'マイク') }}</button>
          <button class="ghost" :class="{ active: mode === 'tts' }" @click="mode = 'tts'">{{ t('読み上げ', 'TTS') }}</button>
        </div>

        <div v-if="mode !== 'tts'">
          <video ref="previewRef" class="preview" muted autoplay playsinline />
          <div class="state mono">{{ recording ? (t('録画中', 'REC') + ' ' + fmt(elapsed)) : t('待機中', '待機中') }}</div>
          <div class="actions">
            <button class="ghost" @click="emit('close')" :disabled="recording">{{ t('閉じる', '閉じる') }}</button>
            <button
              v-if="!recording"
              class="primary"
              @click="startRecording"
            >{{ mode === 'mic' ? t('録音開始', '録音開始') : t('録画開始', '録画開始') }}</button>
            <button v-else class="danger" @click="stopRecording">{{ t('停止して素材に追加', '停止して素材に追加') }}</button>
          </div>
        </div>

        <div v-else class="tts">
          <label class="field">
            <span>{{ t('読み上げる文章', '読み上げテキスト') }}</span>
            <textarea rows="3" v-model="ttsText" placeholder="こんにちは。" />
          </label>
          <div class="row-2">
            <label class="field">
              <span>{{ t('声', '音声') }}</span>
              <select v-model="ttsVoice">
                <option v-for="v in voices" :key="v.name" :value="v.name">{{ v.name }} ({{ v.lang }})</option>
              </select>
            </label>
            <label class="field">
              <span>{{ t('速さ', '速度') }} <span class="mono">{{ ttsRate.toFixed(2) }}</span></span>
              <input type="range" min="0.5" max="2" step="0.1" v-model.number="ttsRate" />
            </label>
            <label class="field">
              <span>{{ t('声の高さ', 'ピッチ') }} <span class="mono">{{ ttsPitch.toFixed(2) }}</span></span>
              <input type="range" min="0.5" max="2" step="0.1" v-model.number="ttsPitch" />
            </label>
          </div>
          <div class="hint muted">
            <template v-if="locale.isEasy.value">
              ※「読み上げを作る」を押すと、画面を選ぶウィンドウが出ます。<br />
              「音声も共有する」にチェックを入れて、好きな画面を選んでください。
            </template>
            <template v-else>
              ※ 生成時に「タブの音声を共有」を選んでください (ブラウザが音声キャプチャを要求します)。
            </template>
          </div>
          <div class="actions">
            <button class="ghost" @click="emit('close')">{{ t('閉じる', '閉じる') }}</button>
            <button class="primary" @click="generateTTS">{{ t('読み上げを作る', 'TTS 生成') }}</button>
          </div>
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
  z-index: 9400;
}
.modal {
  width: 520px;
  max-width: 92vw;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line-weak);
}
.title { font-size: 14px; font-weight: 600; }
.close { background: none; border: none; color: var(--fg-2); font-size: 18px; cursor: pointer; }
.modal-body { padding: 12px 18px 16px; }
.tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 10px;
}
.tabs button.active {
  background: var(--accent-dim);
  color: var(--accent-hi);
  border-color: var(--accent);
}
.preview {
  width: 100%;
  max-height: 240px;
  background: #000;
  border-radius: var(--radius-sm);
}
.state {
  margin: 8px 0;
  text-align: center;
  color: var(--fg-1);
  font-size: 12px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
button.danger { color: var(--danger); }
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  margin-bottom: 6px;
}
.field > span { color: var(--fg-2); }
.field textarea { resize: vertical; }
.row-2 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
}
.hint {
  font-size: 11px;
  margin-top: 6px;
}
</style>
