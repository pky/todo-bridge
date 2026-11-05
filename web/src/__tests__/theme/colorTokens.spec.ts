import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const src = resolve(process.cwd(), 'src')
// 設計上必須のトークン。追加トークンにもライトとダークの両方を要求する。
const requiredTokens = [
  'canvas', 'surface', 'surface-muted', 'surface-alt', 'surface-strong', 'surface-stronger',
  'surface-hover', 'inverse', 'inverse-strong', 'scrim',
  'line-subtle', 'line', 'line-strong',
  'fg', 'fg-secondary', 'fg-muted', 'fg-subtle', 'fg-faint', 'on-solid', 'on-solid-muted',
  'accent', 'accent-hover', 'accent-strong', 'accent-soft', 'accent-soft-strong', 'accent-line',
  'danger', 'danger-faint', 'danger-strong', 'danger-soft', 'danger-soft-strong', 'danger-line',
  'success', 'success-hover', 'success-strong', 'success-soft', 'success-soft-strong', 'success-line',
  'warning', 'warning-hover', 'warning-strong', 'warning-soft', 'warning-soft-strong', 'warning-line',
  'special', 'special-hover', 'priority-high', 'priority-medium', 'priority-low',
  'deco-sky', 'deco-cyan', 'deco-emerald', 'deco-teal',
]
const utilities = '(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|divide(?:-[xy])?|from|via|to|outline|fill|stroke|placeholder|caret|decoration|accent|shadow)'
const palettes = '(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)'
const tokenFamilies = '(?:canvas|surface(?:-[a-z0-9]+)*|fg(?:-[a-z0-9]+)*|on-solid(?:-[a-z0-9]+)*|line(?:-[a-z0-9]+)*|inverse(?:-[a-z0-9]+)*|scrim|accent(?:-[a-z0-9]+)*|danger(?:-[a-z0-9]+)*|success(?:-[a-z0-9]+)*|warning(?:-[a-z0-9]+)*|special(?:-[a-z0-9]+)*|priority-[a-z0-9-]+|deco-[a-z0-9-]+)'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return []
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(vue|ts)$/.test(entry.name) ? [path] : []
  })
}

function findings(pattern: RegExp, allowed: Set<string> = new Set()): string[] {
  return sourceFiles(src).flatMap((path) => {
    const name = relative(src, path).replaceAll('\\', '/')
    if (allowed.has(name)) return []
    return readFileSync(path, 'utf8').split('\n').flatMap((line, index) =>
      [...line.matchAll(pattern)].map((match) => `${name}:${index + 1}: ${match[0]}`))
  })
}

function tokenDefinitions() {
  const css = postcss.parse(readFileSync(resolve(src, 'theme.css'), 'utf8'))
  const light = new Set<string>()
  const dark = new Set<string>()
  let resetsPalette = false
  css.walkAtRules('theme', (rule) => {
    rule.walkDecls((decl) => {
      if (decl.prop === '--color-*' && decl.value === 'initial') resetsPalette = true
      else if (decl.prop.startsWith('--color-') && decl.value.trim()) light.add(decl.prop.slice(8))
    })
  })
  css.walkRules((rule) => {
    if (!rule.selectors.some((selector) => /^:root\[data-theme\s*=\s*["']?dark["']?\]$/.test(selector.trim()))) return
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--color-') && decl.value.trim()) dark.add(decl.prop.slice(8))
    })
  })
  return { light, dark, resetsPalette }
}

describe('色トークンの一元管理', () => {
  it('VueとTypeScriptにTailwind既定パレットの色ユーティリティを残さない', () => {
    const pattern = new RegExp(`(?<![\\w-])${utilities}-${palettes}(?:-\\d{2,3})?(?![\\w-])`, 'g')
    expect(findings(pattern)).toEqual([])
  })

  it('既定パレットを無効にし、必須トークンと追加トークンを両テーマで定義する', () => {
    const { light, dark, resetsPalette } = tokenDefinitions()
    expect(resetsPalette).toBe(true)
    expect([...light].sort()).toEqual([...dark].sort())
    expect(requiredTokens.filter((token) => !light.has(token))).toEqual([])
    expect(requiredTokens.filter((token) => !dark.has(token))).toEqual([])
  })

  it('画面で使用するトークン系ユーティリティに未定義の色がない', () => {
    const { light } = tokenDefinitions()
    const pattern = new RegExp(`(?<![\\w-])${utilities}-(${tokenFamilies})(?![\\w-])`, 'g')
    const undefinedTokens = sourceFiles(src).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return [...source.matchAll(pattern)].filter((match) => !light.has(match[1]!))
        .map((match) => `${relative(src, path)}: ${match[0]}`)
    })
    expect(undefinedTokens).toEqual([])
  })

  it('許可された3ファイル以外に色の直書きを残さない', () => {
    const allowed = new Set(['views/LoginView.vue', 'components/NewsCard.vue', 'composables/useTheme.ts'])
    const pattern = /#[\da-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\s*\(/g
    expect(findings(pattern, allowed)).toEqual([])
  })
})
