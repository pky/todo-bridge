import { expect } from 'e2e'
import { test } from './fixture'

const functionsOrigin = 'http://127.0.0.1:15001'

test('表示テーマを保存し、再読み込みと端末設定の変更に追従する', async ({ app, screen, browser, demoUser }) => {
  expect(demoUser.uid).toBeTruthy()
  await browser.addInitScript(({ uid }) => {
    // テーマ検証では個人スペースへの初回移行処理を起動しない。
    localStorage.setItem(`rertm-personal-space-migrated-${uid}`, 'true')
  }, { uid: demoUser.uid })
  // 設定画面が呼ぶ設定取得だけを、専用Functions無しでローカル応答する。
  await browser.route(`${functionsOrigin}/**/getGoogleCalendarServiceConfig`, async (route) => {
    await route.fulfill({
      json: { data: { serviceAccountEmail: '' } },
      headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    })
  })
  await browser.emulateMedia({ colorScheme: 'dark' })
  await app.open('/settings')
  const html = browser.locator('html')
  const account = screen.getByTestId('settings-account')
  const group = account.getByRole('radiogroup', 'テーマ')
  const dark = group.getByRole('radio', 'ダーク', { exact: true })
  await expect(html).toHaveAttribute('data-theme', 'light')
  await expect(group.getByRole('radio', 'ライト', { exact: true })).toHaveAttribute('aria-checked', 'true')
  await dark.tap()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => browser.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(22, 22, 30)')
  expect(await browser.evaluate(() => localStorage.getItem('rertm-theme'))).toBe('dark')
  await app.screenshot('theme-dark')

  await browser.reload()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(dark).toHaveAttribute('aria-checked', 'true')
  expect(await browser.evaluate(() => localStorage.getItem('rertm-theme'))).toBe('dark')
  await group.getByRole('radio', 'ライト', { exact: true }).tap()
  await expect(html).toHaveAttribute('data-theme', 'light')
  expect(await browser.evaluate(() => localStorage.getItem('rertm-theme'))).toBe('light')

  await group.getByRole('radio', '端末に合わせる', { exact: true }).tap()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  expect(await browser.evaluate(() => localStorage.getItem('rertm-theme'))).toBe('system')
  await browser.emulateMedia({ colorScheme: 'light' })
  await expect(html).toHaveAttribute('data-theme', 'light')
  await browser.emulateMedia({ colorScheme: 'dark' })
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(group.getByRole('radio', '端末に合わせる', { exact: true })).toHaveAttribute('aria-checked', 'true')
})

test('アプリのJavaScriptを遮断しても描画前に保存済みダークを適用する', async ({ app, browser, demoUser }) => {
  expect(demoUser.uid).toBeTruthy()
  await browser.addInitScript(() => { localStorage.setItem('rertm-theme', 'dark') })
  let blockedScripts = 0
  // ビルド後のハッシュ付きJSと開発時のTSのどちらにも対応する。
  await browser.route('**/*', async (route) => {
    if (/\.(?:[cm]?js|ts)$/.test(new URL(route.request.url).pathname)) {
      blockedScripts += 1
      await route.abort()
    } else await route.fallback()
  })
  await app.open('/settings')
  await expect(browser.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(blockedScripts).toBeGreaterThan(0)
  expect(await browser.evaluate(() => document.querySelector('#app')?.childElementCount ?? null)).toBe(0)
  await app.screenshot('theme-before-app')
})
