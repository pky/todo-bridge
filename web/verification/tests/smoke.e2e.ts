import { expect } from 'e2e'
import { test, itemTitle } from './fixture'

test('認証済みのモバイルニュース画面を表示できる', async ({ app, screen, demoUser }) => {
  expect(demoUser.uid.length).toBeGreaterThan(0)
  await app.open('/news/mobile')
  await expect(screen.getByRole('heading', 'モバイルニュース')).toBeVisible()
  await expect(screen.getByTestId('important-title')).toHaveText(itemTitle)
  await app.screenshot('signed-in-mobile-news')
})
