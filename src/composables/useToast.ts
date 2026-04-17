import { ref, readonly, type Ref } from 'vue'
import { nanoid } from 'nanoid'

// ============================================================
// Toast 通知
// ============================================================
// モジュールシングルトンで、コンポーネント外(ストア等)からも呼べる。
// ============================================================

export type ToastLevel = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: string
  level: ToastLevel
  message: string
  duration: number // ms
  createdAt: number
}

const toastsRef = ref<Toast[]>([])

function push(level: ToastLevel, message: string, duration = 4000) {
  const id = nanoid()
  const toast: Toast = {
    id,
    level,
    message,
    duration,
    createdAt: Date.now()
  }
  toastsRef.value = [...toastsRef.value, toast]
  if (duration > 0) {
    window.setTimeout(() => dismiss(id), duration)
  }
  return id
}

function dismiss(id: string) {
  toastsRef.value = toastsRef.value.filter(t => t.id !== id)
}

function clear() {
  toastsRef.value = []
}

export function useToast() {
  return {
    toasts: readonly(toastsRef) as Readonly<Ref<Toast[]>>,
    info: (msg: string, duration?: number) => push('info', msg, duration),
    success: (msg: string, duration?: number) => push('success', msg, duration),
    warn: (msg: string, duration?: number) => push('warn', msg, duration),
    error: (msg: string, duration?: number) =>
      push('error', msg, duration ?? 6000),
    dismiss,
    clear
  }
}

// 直接呼ぶ用の短縮
export const toast = {
  info: (msg: string, duration?: number) => push('info', msg, duration),
  success: (msg: string, duration?: number) => push('success', msg, duration),
  warn: (msg: string, duration?: number) => push('warn', msg, duration),
  error: (msg: string, duration?: number) => push('error', msg, duration ?? 6000),
  dismiss,
  clear
}
