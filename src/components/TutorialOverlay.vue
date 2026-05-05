<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useTutorial } from '../composables/useTutorial'
import { useLocale } from '../composables/useLocale'

const locale = useLocale()

interface Step {
  target?: string
  title: string
  body: string
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center'
}

const STEPS_EASY: Step[] = [
  {
    title: 'ようこそ 👋',
    body:
      'こんにちは！「どうがメーカー」へ ようこそ。\n' +
      'すこし つかいかたを いっしょに みていこう。1ぷんで おわるよ。',
    placement: 'center'
  },
  {
    target: '[data-tour="media-library"]',
    title: '① そざい (どうが・え・おと)',
    body:
      'ここに どうがや え、おとを いれます。\n' +
      'パソコンの ファイルを ここに ドラッグして いれてもいいし、＋ ボタンから えらんでもいいよ。',
    placement: 'right'
  },
  {
    target: '[data-tour="preview"]',
    title: '② みるところ (プレビュー)',
    body:
      'できあがった どうがを ここで みれるよ。\n' +
      'スペースキーで さいせい / とめる。えらんだ クリップは ここで ドラッグして うごかしたり、おおきさを かえたり できるよ。',
    placement: 'right'
  },
  {
    target: '[data-tour="timeline-body"]',
    title: '③ ならべるところ (タイムライン)',
    body:
      'クリップを ドラッグで うごかせるよ。クリップの はしっこを ひっぱると、ながさも かえられる。\n' +
      'S キーで ふたつに わけられる。けすときは Delete キー。',
    placement: 'top'
  },
  {
    target: '[data-tour="timeline-toolbar"]',
    title: '④ どうぐばこ',
    body:
      'もじ や かたち を ふやしたり、めじるしを たてたり できるよ。\n' +
      '🧲 で「ぴったり あわせる」、🚩 で「めじるしを たてる」が つかえるよ。',
    placement: 'bottom'
  },
  {
    target: '[data-tour="inspector"]',
    title: '⑤ こまかい せってい',
    body:
      'えらんだ クリップの いろ・おおきさ・おとの おおきさ などを ここで かえれるよ。\n' +
      '◆ ボタンで「うごきポイント」を たてると、じかんが すすむと いっしょに かわるよ。',
    placement: 'left'
  },
  {
    target: '[data-tour="topbar-actions"]',
    title: '⑥ うえの メニュー',
    body:
      '↶↷ で「もとに もどす / やりなおす」。\n' +
      '📂 さくひんの きりかえ、🎙 ろくが・ろくおん、🎚 おとの ちょうせい、? しょうとかっと、▼ どうがで かきだす。\n' +
      'いちばん みぎの あ ボタンで、ふつうの 日本語に きりかえも できるよ。',
    placement: 'bottom'
  },
  {
    title: 'じゅんび OK ✨',
    body:
      'さあ、すきな どうがを つくってみよう！\n' +
      'もう いちど みたい ときは、うえの 🎓 ボタンを おしてね。',
    placement: 'center'
  }
]

const STEPS_NORMAL: Step[] = [
  {
    title: 'ようこそ 👋',
    body:
      'Local Video Editor へようこそ。ブラウザだけで動く完全ローカルな動画編集アプリです。\n' +
      '数ステップで主要機能を案内します。所要時間は 1 分ほど。',
    placement: 'center'
  },
  {
    target: '[data-tour="media-library"]',
    title: '① 素材ライブラリ',
    body:
      'ここに動画・画像・音声ファイルをドラッグ&ドロップ、または ＋ ボタンで追加します。\n' +
      'フォルダで整理し、検索もできます。素材はブラウザの IndexedDB に保存され、外部には送信されません。',
    placement: 'right'
  },
  {
    target: '[data-tour="preview"]',
    title: '② プレビュー画面',
    body:
      'スペースで再生/一時停止。選択中のクリップはプレビュー上で直接ドラッグ・拡縮・回転できます。\n' +
      '範囲指定中は In/Out 内でループ再生します。',
    placement: 'right'
  },
  {
    target: '[data-tour="timeline-body"]',
    title: '③ タイムライン',
    body:
      'クリップをドラッグで移動、端をドラッグでトリム。S で分割、Cmd/Ctrl+C/V でコピー/貼り付け、\n' +
      'Shift+クリックで複数選択、Delete で削除。ルーラー上のマーカーは M キーで追加。',
    placement: 'top'
  },
  {
    target: '[data-tour="timeline-toolbar"]',
    title: '④ タイムラインツール',
    body:
      'テキスト/図形の追加、トラック追加、スナップ(🧲)・リップル(⇆)・マーカー(🚩)・\n' +
      'In/Out 点(I/O)の設定ボタンがここにあります。右端のスライダで拡大率を変更。',
    placement: 'bottom'
  },
  {
    target: '[data-tour="inspector"]',
    title: '⑤ インスペクタ',
    body:
      '選択中クリップの時間・配置・音量・エフェクト・カラーグレード・クロマキー・\n' +
      'トランジション・テキストアニメなどをここで編集。◆ ボタンでキーフレームを追加できます。',
    placement: 'left'
  },
  {
    target: '[data-tour="topbar-actions"]',
    title: '⑥ メニュー',
    body:
      '左から Undo/Redo、プロジェクト管理、録画・ナレーション録音、オーディオミキサー、\n' +
      'キーボードショートカット、エクスポート(MP4/WebM/GIF)。\n' +
      '右端の「あ/漢」ボタンで、やさしい日本語と通常表示を切替えできます。',
    placement: 'bottom'
  },
  {
    title: '準備完了 ✨',
    body:
      'さあ、プロジェクトを始めましょう。ツアーはいつでも TopBar の 🎓 ボタンから再表示できます。',
    placement: 'center'
  }
]

const STEPS = computed<Step[]>(() => locale.isEasy.value ? STEPS_EASY : STEPS_NORMAL)

const tour = useTutorial()
const step = ref(0)
const targetRect = ref<DOMRect | null>(null)
const targetMissing = ref(false)
const dontShowAgain = ref(false)

const current = computed(() => STEPS.value[step.value])
const isFirst = computed(() => step.value === 0)
const isLast = computed(() => step.value === STEPS.value.length - 1)

function resolveTarget() {
  const s = current.value
  if (!s.target) {
    targetRect.value = null
    targetMissing.value = false
    return
  }
  const el = document.querySelector(s.target) as HTMLElement | null
  if (!el) {
    targetRect.value = null
    targetMissing.value = true
    return
  }
  targetMissing.value = false
  try {
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  } catch {}
  targetRect.value = el.getBoundingClientRect()
}

function next() {
  if (!isLast.value) step.value++
  else finish()
}
function prev() {
  if (step.value > 0) step.value--
}
function finish() {
  if (isLast.value && dontShowAgain.value) tour.markSeen()
  else tour.markSeen()
  tour.close()
}
function skipAll() {
  tour.markSeen()
  tour.close()
}

let ro: ResizeObserver | null = null
let rafId: number | null = null
function scheduleUpdate() {
  if (rafId != null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    resolveTarget()
  })
}

onMounted(async () => {
  // フォーム類のアニメーションが落ち着くまで待つ
  await nextTick()
  resolveTarget()
  window.addEventListener('resize', scheduleUpdate)
  window.addEventListener('scroll', scheduleUpdate, true)
  ro = new ResizeObserver(() => scheduleUpdate())
  ro.observe(document.body)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleUpdate)
  window.removeEventListener('scroll', scheduleUpdate, true)
  ro?.disconnect()
  ro = null
  window.removeEventListener('keydown', onKey)
  if (rafId != null) cancelAnimationFrame(rafId)
})

watch(step, () => nextTick(resolveTarget))

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    skipAll()
  } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
    e.preventDefault()
    next()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    prev()
  }
}

// スポットライト (切り抜き) スタイル
const highlightStyle = computed(() => {
  const r = targetRect.value
  if (!r) return { display: 'none' }
  return {
    left: `${r.left - 6}px`,
    top: `${r.top - 6}px`,
    width: `${r.width + 12}px`,
    height: `${r.height + 12}px`
  }
})

// 吹き出しの位置
const bubbleStyle = computed(() => {
  const r = targetRect.value
  const placement = current.value.placement ?? 'bottom'
  const BUBBLE_W = 360
  const BUBBLE_H_APPROX = 200
  const PAD = 14
  if (!r || placement === 'center' || targetMissing.value) {
    return {
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)'
    }
  }
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = 0
  let top = 0
  if (placement === 'bottom') {
    left = r.left + r.width / 2 - BUBBLE_W / 2
    top = r.bottom + PAD
  } else if (placement === 'top') {
    left = r.left + r.width / 2 - BUBBLE_W / 2
    top = r.top - PAD - BUBBLE_H_APPROX
  } else if (placement === 'left') {
    left = r.left - PAD - BUBBLE_W
    top = r.top + r.height / 2 - BUBBLE_H_APPROX / 2
  } else {
    left = r.right + PAD
    top = r.top + r.height / 2 - BUBBLE_H_APPROX / 2
  }
  // 画面外にはみ出さないよう補正
  left = Math.max(10, Math.min(vw - BUBBLE_W - 10, left))
  top = Math.max(10, Math.min(vh - BUBBLE_H_APPROX - 10, top))
  return {
    left: `${left}px`,
    top: `${top}px`,
    transform: 'none'
  }
})

// 矢印の位置 (吹き出しから target へ向ける)
const arrowStyle = computed(() => {
  const r = targetRect.value
  const placement = current.value.placement ?? 'bottom'
  if (!r || placement === 'center' || targetMissing.value) return { display: 'none' }
  const base: Record<string, string> = {}
  if (placement === 'bottom') {
    base.top = '-6px'
    base.left = '50%'
    base.transform = 'translateX(-50%) rotate(45deg)'
    base.borderWidth = '1px 0 0 1px'
  } else if (placement === 'top') {
    base.bottom = '-6px'
    base.left = '50%'
    base.transform = 'translateX(-50%) rotate(45deg)'
    base.borderWidth = '0 1px 1px 0'
  } else if (placement === 'left') {
    base.right = '-6px'
    base.top = '50%'
    base.transform = 'translateY(-50%) rotate(45deg)'
    base.borderWidth = '1px 1px 0 0'
  } else {
    base.left = '-6px'
    base.top = '50%'
    base.transform = 'translateY(-50%) rotate(45deg)'
    base.borderWidth = '0 0 1px 1px'
  }
  return base
})

const pct = computed(() => ((step.value + 1) / STEPS.value.length) * 100)
</script>

<template>
  <!-- target が無い (またはセンター) ときは全体をディム -->
  <div
    v-if="!targetRect || current.placement === 'center' || targetMissing"
    class="tour-backdrop"
  />
  <!-- target があれば穴開きマスク -->
  <div
    v-else
    class="tour-spotlight"
    :style="highlightStyle"
  />

  <div class="tour-bubble" :style="bubbleStyle">
    <div class="tour-arrow" :style="arrowStyle" />
    <div class="tour-head">
      <div class="tour-title">{{ current.title }}</div>
      <button class="tour-skip" title="つかいかたを とじる (Esc)" @click="skipAll">とじる</button>
    </div>
    <div class="tour-body" style="white-space: pre-line">{{ current.body }}</div>
    <div class="tour-progress-wrap">
      <div class="tour-progress-bar">
        <div class="tour-progress-fill" :style="{ width: pct + '%' }" />
      </div>
      <div class="tour-progress-label mono">{{ step + 1 }} / {{ STEPS.length }}</div>

    </div>
    <div class="tour-foot">
      <label v-if="isLast" class="tour-dsa">
        <input type="checkbox" v-model="dontShowAgain" />
        <span>つぎから ださない</span>
      </label>
      <div class="spacer" />
      <button v-if="!isFirst" class="ghost" @click="prev">← もどる</button>
      <button class="primary" @click="next">
        {{ isLast ? 'はじめる' : 'つぎへ →' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tour-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.58);
  z-index: 9600;
  pointer-events: auto;
  animation: fadeIn 160ms ease;
}
.tour-spotlight {
  position: fixed;
  z-index: 9601;
  border-radius: 10px;
  border: 2px solid var(--accent);
  /* 外側を真っ暗くして内側だけを強調 */
  box-shadow:
    0 0 0 9999px rgba(0, 0, 0, 0.58),
    0 0 24px rgba(232, 168, 56, 0.45);
  pointer-events: none;
  transition: left 220ms ease, top 220ms ease, width 220ms ease, height 220ms ease;
}
.tour-bubble {
  position: fixed;
  z-index: 9602;
  width: 360px;
  max-width: 92vw;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  padding: 14px 16px 12px;
  color: var(--fg-0);
  animation: pop 200ms ease;
}
.tour-arrow {
  position: absolute;
  width: 12px;
  height: 12px;
  background: var(--bg-1);
  border: 0 solid var(--line);
}
.tour-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.tour-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--fg-0);
}
.tour-skip {
  background: none;
  border: none;
  color: var(--fg-2);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
}
.tour-skip:hover { color: var(--fg-0); }
.tour-body {
  margin: 4px 0 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--fg-1);
}
.tour-progress-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.tour-progress-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-2);
  border-radius: 2px;
  overflow: hidden;
}
.tour-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent) 0%, var(--accent-hi) 100%);
  transition: width 220ms ease;
}
.tour-progress-label {
  font-size: 10px;
  color: var(--fg-2);
  min-width: 36px;
  text-align: right;
}
.tour-foot {
  display: flex;
  align-items: center;
  gap: 6px;
}
.spacer { flex: 1; }
.tour-dsa {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--fg-2);
  cursor: pointer;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes pop {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
</style>
