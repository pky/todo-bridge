import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

let wrapper: VueWrapper | undefined
const listeners: EventListenerOrEventListenerObject[] = []

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  delete document.documentElement.dataset.theme
  const media = new EventTarget()
  vi.stubGlobal('matchMedia', vi.fn(() => Object.assign(media, { matches: false, media: '(prefers-color-scheme: dark)' })))
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'storage') listeners.push(listener)
    add(type, listener, options)
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  for (const listener of listeners.splice(0)) window.removeEventListener('storage', listener)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(preference = 'light') {
  localStorage.setItem('rertm-theme', preference)
  const { initTheme } = await import('@/composables/useTheme')
  initTheme()
  const { default: ThemeSection } = await import('@/components/settings/ThemeSection.vue')
  wrapper = mount(ThemeSection)
  return wrapper
}

describe('表示テーマの選択', () => {
  it('見出しとテーマのグループに4つのradioを順番どおり表示する', async () => {
    const view = await render()
    expect(view.findAll('h1,h2,h3,h4,h5,h6').map((node) => node.text())).toContain('表示')
    const group = view.get('[role="radiogroup"][aria-label="テーマ"]')
    expect(group.findAll('[role="radio"]').map((node) => node.text())).toEqual(['ライト', 'ダーク', 'セピア', '端末に合わせる'])
  })

  it.each([['light', 'ライト'], ['dark', 'ダーク'], ['system', '端末に合わせる']])('現在値 %s だけを選択中にする', async (preference, label) => {
    const view = await render(preference)
    const radios = view.findAll('[role="radio"]')
    expect(radios.filter((node) => node.attributes('aria-checked') === 'true').map((node) => node.text())).toEqual([label])
    expect(radios.filter((node) => node.text() !== label).every((node) => node.attributes('aria-checked') === 'false')).toBe(true)
  })

  it('クリックで画面・選択状態・端末保存を切り替える', async () => {
    const view = await render()
    for (const [label, preference, resolved] of [
      ['ダーク', 'dark', 'dark'], ['端末に合わせる', 'system', 'light'], ['ライト', 'light', 'light'],
    ]) {
      const radio = view.findAll('[role="radio"]').find((node) => node.text() === label)
      expect(radio).toBeDefined()
      await radio!.trigger('click')
      expect(document.documentElement.dataset.theme).toBe(resolved)
      expect(localStorage.getItem('rertm-theme')).toBe(preference)
      expect(view.findAll('[role="radio"][aria-checked="true"]').map((node) => node.text())).toEqual([label])
    }
  })

  it('現在値が sepia ならセピアだけを選択中にする', async () => {
    const view = await render('sepia')
    const radios = view.findAll('[role="radio"]')
    expect(radios.filter((node) => node.attributes('aria-checked') === 'true').map((node) => node.text())).toEqual(['セピア'])
    expect(radios.filter((node) => node.text() !== 'セピア').every((node) => node.attributes('aria-checked') === 'false')).toBe(true)
  })

  it('セピアをクリックすると画面と選択状態が切り替わり端末に保存する', async () => {
    const view = await render('dark')
    const sepia = view.findAll('[role="radio"]').find((node) => node.text() === 'セピア')
    expect(sepia, 'セピアの選択肢').toBeDefined()
    await sepia!.trigger('click')
    expect(document.documentElement.dataset.theme).toBe('sepia')
    expect(localStorage.getItem('rertm-theme')).toBe('sepia')
    expect(view.findAll('[role="radio"][aria-checked="true"]').map((node) => node.text())).toEqual(['セピア'])
  })

  it.each(['ArrowRight', 'ArrowDown'])('%s でダークからセピアを経由して端末に合わせるへ進む', async (key) => {
    const view = await render('dark')
    document.body.append(view.element)
    const selected = () => view.get('[role="radio"][aria-checked="true"]')

    for (const label of ['セピア', '端末に合わせる']) {
      await selected().trigger('keydown', { key })
      expect(selected().text()).toBe(label)
      expect(document.activeElement).toBe(selected().element)
    }
  })

  it.each([
    ['ArrowRight', 'ArrowLeft'], ['ArrowDown', 'ArrowUp'],
  ])('Endで末尾に移動し、%s と %s で両端を循環してセピアへ戻れる', async (forward, back) => {
    const view = await render()
    document.body.append(view.element)
    const selected = () => view.get('[role="radio"][aria-checked="true"]')

    for (const [key, label] of [
      ['End', '端末に合わせる'], [forward, 'ライト'],
      [back, '端末に合わせる'], [back, 'セピア'],
    ]) {
      await selected().trigger('keydown', { key })
      expect(selected().text()).toBe(label)
      expect(document.activeElement).toBe(selected().element)
    }
  })
})
