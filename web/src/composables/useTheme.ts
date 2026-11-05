import { computed, readonly, ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'
export const THEME_STORAGE_KEY = 'rertm-theme'

const preference = ref<ThemePreference>('light')
const prefersDark = ref(false)
const resolvedTheme = computed<'light' | 'dark'>(() =>
  preference.value === 'system' ? (prefersDark.value ? 'dark' : 'light') : preference.value,
)
let initialized = false
let media: MediaQueryList | undefined

function parsePreference(value: string | null): ThemePreference {
  return value === 'dark' || value === 'system' ? value : 'light'
}

function applyTheme(): void {
  if (media) prefersDark.value = media.matches
  const theme = resolvedTheme.value
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content', theme === 'dark' ? '#16161e' : '#3b82f6',
  )
}

export function initTheme(): void {
  if (initialized) return
  initialized = true
  try {
    preference.value = parsePreference(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    preference.value = 'light'
  }

  if (typeof window.matchMedia === 'function') {
    media = window.matchMedia('(prefers-color-scheme: dark)')
    prefersDark.value = media.matches
    media.addEventListener('change', () => {
      applyTheme()
    })
  }
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
    preference.value = parsePreference(event.newValue)
    applyTheme()
  })
  applyTheme()
}

function setPreference(value: ThemePreference): void {
  preference.value = value
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // 保存できなくても、この画面で選んだテーマは反映する。
  }
  applyTheme()
}

export function useTheme() {
  return { preference: readonly(preference), resolvedTheme, setPreference }
}
