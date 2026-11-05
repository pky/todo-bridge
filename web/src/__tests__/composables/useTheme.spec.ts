import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemePreference } from '@/composables/useTheme'

let prefersDark = false
let media: EventTarget
const storageListeners: EventListenerOrEventListenerObject[] = []

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  delete document.documentElement.dataset.theme
  document.head.innerHTML = '<meta name="theme-color" content="#3b82f6">'
  prefersDark = false
  media = new EventTarget()
  Object.defineProperty(media, 'matches', { get: () => prefersDark })
  vi.stubGlobal('matchMedia', vi.fn((query: string) => Object.assign(media, {
    media: query,
    onchange: null,
    addListener: (listener: EventListener) => media.addEventListener('change', listener),
    removeListener: (listener: EventListener) => media.removeEventListener('change', listener),
  })))
  // resetModules だけでは消えない前ケースのグローバル購読を後処理で外す。
  const addListener = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'storage') storageListeners.push(listener)
    addListener(type, listener, options)
  })
})

afterEach(() => {
  for (const listener of storageListeners.splice(0)) window.removeEventListener('storage', listener)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function start() {
  const theme = await import('@/composables/useTheme')
  expect(theme.THEME_STORAGE_KEY).toBe('rertm-theme')
  theme.initTheme()
  return { ...theme.useTheme(), key: theme.THEME_STORAGE_KEY }
}

function changeMedia(dark: boolean) {
  prefersDark = dark
  const event = new Event('change')
  Object.defineProperty(event, 'matches', { value: dark })
  media.dispatchEvent(event)
}

describe('テーマの状態と端末への保存', () => {
  it('未保存なら端末がダークでもライトで始まる', async () => {
    prefersDark = true
    const theme = await start()
    expect(theme.preference.value).toBe('light')
    expect(theme.resolvedTheme.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it.each<ThemePreference>(['light', 'dark'])('保存した %s を起動時に反映する', async (preference) => {
    localStorage.setItem('rertm-theme', preference)
    const theme = await start()
    expect(theme.preference.value).toBe(preference)
    expect(theme.resolvedTheme.value).toBe(preference)
    expect(document.documentElement.dataset.theme).toBe(preference)
  })

  it('ダークへの変更を即座に反映して保存し、metaも切り替える', async () => {
    const theme = await start()
    theme.setPreference('dark')
    expect(theme.preference.value).toBe('dark')
    expect(theme.resolvedTheme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(theme.key)).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#16161e')
    theme.setPreference('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(theme.key)).toBe('light')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#3b82f6')
  })

  it.each([true, false])('端末設定に合わせる（dark=%s）', async (dark) => {
    prefersDark = dark
    localStorage.setItem('rertm-theme', 'system')
    const theme = await start()
    expect(theme.preference.value).toBe('system')
    expect(theme.resolvedTheme.value).toBe(dark ? 'dark' : 'light')
    expect(document.documentElement.dataset.theme).toBe(dark ? 'dark' : 'light')
  })

  it('system選択を保存し、端末の変更に両方向で追従する', async () => {
    const theme = await start()
    theme.setPreference('system')
    expect(localStorage.getItem(theme.key)).toBe('system')
    changeMedia(true)
    expect(theme.preference.value).toBe('system')
    expect(theme.resolvedTheme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    changeMedia(false)
    expect(theme.resolvedTheme.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it.each<ThemePreference>(['light', 'dark'])('明示した %s は端末変更で上書きされない', async (preference) => {
    const theme = await start()
    theme.setPreference(preference)
    changeMedia(true)
    changeMedia(false)
    expect(theme.preference.value).toBe(preference)
    expect(theme.resolvedTheme.value).toBe(preference)
    expect(document.documentElement.dataset.theme).toBe(preference)
  })

  it.each(['invalid', '', 'DARK'])('不正な保存値 %j はライトに戻す', async (value) => {
    localStorage.setItem('rertm-theme', value)
    prefersDark = true
    const theme = await start()
    expect(theme.preference.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('読み取りが例外でも起動でき、ライトを反映する', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('読み取り不可') })
    prefersDark = true
    const theme = await start()
    expect(theme.preference.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('保存が例外でも選択と画面の切り替えを止めない', async () => {
    const theme = await start()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('保存不可') })
    expect(() => theme.setPreference('dark')).not.toThrow()
    expect(theme.preference.value).toBe('dark')
    expect(theme.resolvedTheme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#16161e')
  })

  it('別タブでの変更・削除・不正値に追従し、別キーは無視する', async () => {
    const theme = await start()
    const update = (key: string, newValue: string | null) => {
      if (newValue === null) localStorage.removeItem(key)
      else localStorage.setItem(key, newValue)
      window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea: localStorage }))
    }
    update(theme.key, 'dark')
    expect(theme.preference.value).toBe('dark')
    expect(theme.resolvedTheme.value).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#16161e')
    update('unrelated-setting', 'light')
    expect(theme.preference.value).toBe('dark')
    prefersDark = true
    update(theme.key, 'system')
    expect(theme.preference.value).toBe('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
    changeMedia(false)
    expect(document.documentElement.dataset.theme).toBe('light')
    update(theme.key, 'invalid')
    expect(theme.preference.value).toBe('light')
    update(theme.key, 'dark')
    update(theme.key, null)
    expect(theme.preference.value).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
