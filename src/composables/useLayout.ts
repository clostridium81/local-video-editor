import { ref, watch } from 'vue'

// ============================================================
// レイアウト寸法 (左右パネル幅 / タイムライン高さ)
// ============================================================
// エリア境界のドラッグで調整でき、localStorage に保存して
// 次回起動時も維持する。ダブルクリックで初期値に戻せる。
// ============================================================

const STORAGE_KEY = 'lve.layout.v1'

type LayoutKey = 'leftWidth' | 'rightWidth' | 'timelineHeight'

export const LAYOUT_DEFAULTS = {
  leftWidth: 260,
  rightWidth: 300,
  // 以前は 340px 固定でプレビューが圧迫されていたため、
  // デフォルトを下げてプレビューに縦幅を譲る
  timelineHeight: 280
} as const

const LIMITS: Record<LayoutKey, { min: number; max: number }> = {
  leftWidth: { min: 170, max: 480 },
  rightWidth: { min: 230, max: 560 },
  timelineHeight: { min: 150, max: 640 }
}


function clampValue(key: LayoutKey, v: number): number {
  let { min, max } = LIMITS[key]
  // タイムラインはプレビュー領域を最低限残す (トップバー+プレビュー+操作列)
  if (key === 'timelineHeight' && typeof window !== 'undefined') {
    max = Math.min(max, Math.max(min, window.innerHeight - 280))
  }
  return Math.max(min, Math.min(max, Math.round(v)))
}

function loadStored(): Partial<Record<LayoutKey, number>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

const stored = loadStored()

const leftWidth = ref(
  clampValue('leftWidth', stored.leftWidth ?? LAYOUT_DEFAULTS.leftWidth)
)
const rightWidth = ref(
  clampValue('rightWidth', stored.rightWidth ?? LAYOUT_DEFAULTS.rightWidth)
)
const timelineHeight = ref(
  clampValue('timelineHeight', stored.timelineHeight ?? LAYOUT_DEFAULTS.timelineHeight)
)

watch([leftWidth, rightWidth, timelineHeight], () => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        leftWidth: leftWidth.value,
        rightWidth: rightWidth.value,
        timelineHeight: timelineHeight.value
      })
    )
  } catch {
    // 保存できなくても動作は継続
  }
})

export function useLayout() {
  function setLeftWidth(v: number) {
    leftWidth.value = clampValue('leftWidth', v)
  }
  function setRightWidth(v: number) {
    rightWidth.value = clampValue('rightWidth', v)
  }
  function setTimelineHeight(v: number) {
    timelineHeight.value = clampValue('timelineHeight', v)
  }
  function reset(key: LayoutKey) {
    if (key === 'leftWidth') leftWidth.value = LAYOUT_DEFAULTS.leftWidth
    else if (key === 'rightWidth') rightWidth.value = LAYOUT_DEFAULTS.rightWidth
    else timelineHeight.value = LAYOUT_DEFAULTS.timelineHeight
  }
  return {
    leftWidth,
    rightWidth,
    timelineHeight,
    setLeftWidth,
    setRightWidth,
    setTimelineHeight,
    reset
  }
}
