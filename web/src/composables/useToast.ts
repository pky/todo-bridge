import { ref } from 'vue'

export interface ToastMessage {
  id: number
  message: string
  type: 'error' | 'info'
}

const toasts = ref<ToastMessage[]>([])
let nextId = 0

export function useToast() {
  function showError(message: string, durationMs = 3000) {
    const id = ++nextId
    toasts.value.push({ id, message, type: 'error' })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, durationMs)
  }

  function showInfo(message: string, durationMs = 2000) {
    const id = ++nextId
    toasts.value.push({ id, message, type: 'info' })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, durationMs)
  }

  return { toasts, showError, showInfo }
}
