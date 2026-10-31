import { expect } from 'e2e'
import { test, itemKey, itemTitle, readResolved } from './fixture'

test('確認優先の記事を対応済みにしてから戻せる', async ({ app, browser, screen, demoUser }) => {
  await app.open('/news/mobile')
  await expect(screen.getByRole('heading', '今日の重要事項')).toBeVisible()
  await expect(screen.getByTestId('important-title')).toHaveText(itemTitle)
  await expect(screen.getByText('要対応')).toBeVisible()
  expect(await readResolved(demoUser.uid)).toEqual({})
  await app.screenshot('01-action-required')

  await screen.getByRole('button', '対応済み', { exact: true }).tap()
  await expect(screen.getByTestId('important-title')).toHaveCount(0)
  await expect(screen.getByRole('button', '対応済み 1件')).toBeVisible()
  const resolved = await readResolved(demoUser.uid)
  expect(resolved[itemKey]).toMatchObject({ mapValue: { fields: { state: { stringValue: 'done' } } } })
  await app.screenshot('02-marked-done')

  // ニュース用キャッシュを除き、Firestoreの保存結果を新しい画面で読み直す。
  await browser.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('rertm-news-cache-') || key.startsWith('rertm-mobile-action-items-')) localStorage.removeItem(key)
    }
    return null
  })
  await browser.reload()
  await expect(screen.getByRole('button', '対応済み 1件')).toBeVisible()
  await screen.getByRole('button', '対応済み 1件').tap()
  await expect(screen.getByRole('link', itemTitle)).toBeVisible()
  await app.screenshot('03-resolved-list')

  await screen.getByRole('button', '戻す', { exact: true }).tap()
  await expect(screen.getByTestId('important-title')).toHaveText(itemTitle)
  await expect(screen.getByRole('button', '対応済み 1件')).toHaveCount(0)
  expect(await readResolved(demoUser.uid)).toEqual({})
  await app.screenshot('04-restored')
})
