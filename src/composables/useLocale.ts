import { ref, computed } from 'vue'

// ============================================================
// やさしい日本語 / ふつうの日本語 切替
// ============================================================
// localStorage に保存するキーはプレフィックス付き (GitHub Pages の
// 同一 origin (username.github.io) で他アプリと衝突しないように)。
// デフォルトは「やさしい日本語」。
// ============================================================

export type LocaleMode = 'easy' | 'normal'

const STORAGE_KEY = 'lve.locale.v1'

function loadStored(): LocaleMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'easy' || v === 'normal') return v
  } catch {
    // localStorage 不可 (Safari プライベート等) → デフォルト
  }
  return 'easy'
}

function persist(m: LocaleMode) {
  try {
    localStorage.setItem(STORAGE_KEY, m)
  } catch {
    // 書き込み失敗は黙殺 (永続化できないだけで動作はする)
  }
}

const mode = ref<LocaleMode>(loadStored())

const isEasy = computed(() => mode.value === 'easy')

function setMode(m: LocaleMode) {
  mode.value = m
  persist(m)
}

function toggle() {
  setMode(mode.value === 'easy' ? 'normal' : 'easy')
}

/**
 * (やさしい, ふつう) のペアを渡すと、現在モードに応じた文字列を返す。
 * テンプレートで {{ t('文字', 'テキスト') }} のように使う。
 */
function t(easy: string, normal: string): string {
  return mode.value === 'easy' ? easy : normal
}

export function useLocale() {
  return { mode, isEasy, setMode, toggle, t }
}

// 直接呼ぶ用 (script から)
export const localeT = (easy: string, normal: string) =>
  mode.value === 'easy' ? easy : normal

export const localeMode = mode
