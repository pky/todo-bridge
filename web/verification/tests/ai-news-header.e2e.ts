import { expect } from 'e2e'
import { test, dismissTitle, readLaterTitle } from './ai-news.fixture'

test('375px幅でAIニュースの更新ボタンが1段のヘッダーに収まり更新後も記事が残る', async ({ app, screen, browser, aiDemo }) => {
  await browser.setViewport({ width: 375, height: 667 })
  await app.open('/news/ai')
  await expect(screen.getByRole('heading', 'AIニュース')).toBeVisible()
  await expect(screen.getByText(dismissTitle, { visible: true })).toBeVisible()
  await expect(screen.getByText(readLaterTitle, { visible: true })).toBeVisible()
  await expect(screen.getByRole('button', 'あとで読むを開く')).toBeVisible()

  const refresh = screen.getByRole('button', 'ニュースを更新')
  await expect(refresh).toBeVisible()
  // 配置が未対応でも更新操作まで進め、記事の維持を独立して確認する。
  await expect.soft(browser.locator('header').getByRole('button', 'ニュースを更新')).toBeVisible()
  const layout = await browser.evaluate(() => {
    const header = document.querySelector('header')
    const button = Array.from(document.querySelectorAll('button')).find(element =>
      (element.getAttribute('aria-label') ?? element.textContent?.trim()) === 'ニュースを更新')
    if (!header || !button) throw new Error('ニュースのヘッダーまたは更新ボタンがありません')
    const headerRect = header.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    return {
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      headerHeight: headerRect.height,
      pageTopPadding: Number.parseFloat(getComputedStyle(header.parentElement!).paddingTop),
      buttonInsideHeader: header.contains(button),
      buttonInsideViewport: buttonRect.width > 0 && buttonRect.height > 0
        && buttonRect.left >= 0 && buttonRect.top >= 0
        && buttonRect.right <= window.innerWidth && buttonRect.bottom <= window.innerHeight,
    }
  })
  expect(layout.viewportWidth).toBe(375)
  expect(layout.viewportHeight).toBe(667)
  expect.soft(layout.buttonInsideHeader).toBe(true)
  expect.soft(layout.buttonInsideViewport).toBe(true)
  expect(layout.pageTopPadding).toBe(88)
  expect.soft(layout.headerHeight).toBeLessThanOrEqual(layout.pageTopPadding)
  await app.screenshot('01-ai-header-375')

  const getsBeforeRefresh = aiDemo.storageGets.length
  await refresh.click()
  await expect.poll(() => aiDemo.storageGets.length).toBeGreaterThan(getsBeforeRefresh)
  await expect(screen.getByText(dismissTitle, { visible: true })).toBeVisible()
  await expect(screen.getByText(readLaterTitle, { visible: true })).toBeVisible()
  expect(aiDemo.actions).toEqual([])
  await app.screenshot('02-ai-header-refreshed')
})
