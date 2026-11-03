import { expect } from 'e2e'
import { test, dismissTitle, readLaterTitle } from './ai-news-viewer.fixture'

test('viewerの実claimでログインし、管理操作なしでStorage記事を読む', async ({ app, screen, viewerDemo }) => {
  await app.open('/news/ai')
  await expect(screen.getByRole('heading', 'AIニュース')).toBeVisible()
  await expect(screen.getByText(dismissTitle, { visible: true })).toBeVisible()
  await expect(screen.getByText(readLaterTitle, { visible: true })).toBeVisible()
  await expect(screen.getByRole('button', 'あとで読む', { exact: true })).toHaveCount(0)
  await expect(screen.getByRole('button', '興味なし')).toHaveCount(0)
  await expect(screen.getByRole('button', 'あとで読むを開く')).toHaveCount(0)
  expect(viewerDemo.storageGets.length).toBeGreaterThan(0)
  expect(viewerDemo.accessValidations).toEqual([])
  expect(viewerDemo.actions).toEqual([])
  await app.screenshot('01-viewer-feed')
})

test('viewerはHomeのURLを直接開いてもAIニュースへ戻る', async ({ app, screen, browser, viewerDemo }) => {
  await app.open('/')
  await expect(browser).toHaveURL(/\/news\/ai$/)
  await expect(screen.getByText(dismissTitle, { visible: true })).toBeVisible()
  expect(viewerDemo.accessValidations).toEqual([])
  expect(viewerDemo.actions).toEqual([])
  await app.screenshot('02-viewer-redirect')
})

test('viewerはAIニュース画面からログアウトしてログイン画面へ移る', async ({ app, screen, browser }) => {
  await app.open('/news/ai')
  await expect(screen.getByText(dismissTitle, { visible: true })).toBeVisible()
  await screen.getByRole('button', 'ログアウト').click()
  await expect(browser).toHaveURL(/\/login$/)
  await app.screenshot('03-viewer-logout')
})
