import { expect } from 'e2e'
import { test, dismissTitle, readLaterTitle } from './ai-news.fixture'

test('StorageのAI記事は興味なしで消え、あとで読む追加後も残る', async ({ app, screen, aiDemo }) => {
  await app.open('/news/ai')
  await expect(screen.getByRole('heading', 'AIニュース')).toBeVisible()
  await expect(screen.getByText(dismissTitle)).toBeVisible()
  await expect(screen.getByText(readLaterTitle)).toBeVisible()
  expect(aiDemo.storageGets).toEqual(['/v0/b/demo-rertm.appspot.com/o/news%2Fv2%2Fai%2Flatest.json'])
  await app.screenshot('01-ai-feed')

  await screen.getByRole('button', '興味なし').first().tap()
  await expect(screen.getByText(dismissTitle)).toHaveCount(0)
  await expect(screen.getByText(readLaterTitle)).toBeVisible()
  await app.screenshot('02-ai-dismissed')

  await screen.getByRole('button', 'あとで読む', { exact: true }).first().tap()
  await expect(screen.getByRole('button', '追加済み')).toBeVisible()
  await expect(screen.getByRole('button', '追加済み')).toBeDisabled()
  await expect(screen.getByText(readLaterTitle)).toBeVisible()
  expect(aiDemo.actions.map(({ articleId, action }) => ({ articleId, action }))).toEqual([
    { articleId: 'demo-dismiss', action: 'dismiss' }, { articleId: 'demo-read-later', action: 'readLater' },
  ])
  expect(aiDemo.storageGets).toHaveLength(1)
  await app.screenshot('03-ai-read-later-added')
})
