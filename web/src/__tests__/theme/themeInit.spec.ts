import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

function initScript(): string {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  const init = scripts.filter((match) => /\bdata-theme-init(?:\s|=|$)/.test(match[1]!))
  expect(init, '描画前の初期化スクリプトが1つ存在する').toHaveLength(1)
  const script = init[0]!
  expect(script[1]).not.toMatch(/\bsrc\s*=/i)
  expect(script[1]).not.toMatch(/\btype\s*=\s*["']module["']/i)
  const firstStyle = html.search(/<(?:style\b|link\b[^>]*\brel\s*=\s*["']stylesheet["'])/i)
  if (firstStyle !== -1) expect(script.index).toBeLessThan(firstStyle)
  return script[2]!
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('アプリ読み込み前のテーマ初期化', () => {
  it.each([
    ['dark', false, 'dark'], ['light', true, 'light'],
    ['system', true, 'dark'], ['system', false, 'light'],
    [null, true, 'light'], ['invalid', true, 'light'], ['', true, 'light'],
  ])('保存値 %j、端末dark=%s で %s を適用する', (saved, dark, expected) => {
    localStorage.clear()
    if (saved !== null) localStorage.setItem('rertm-theme', saved)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: dark })))
    // 前の属性が残っていても、その端末の保存値から確実に上書きする。
    document.documentElement.dataset.theme = expected === 'dark' ? 'light' : 'dark'
    new Function(initScript())()
    expect(document.documentElement.dataset.theme).toBe(expected)
  })

  it('localStorageが読めなくても例外を出さずライトを適用する', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('読み取り不可') })
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    document.documentElement.dataset.theme = 'dark'
    const script = initScript()
    expect(() => new Function(script)()).not.toThrow()
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
