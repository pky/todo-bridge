import { expect, test } from '@playwright/test'

test('ローカルログインからPDFの追加と詳細表示まで操作できる', async ({ page }) => {
  await page.goto('/login')
  await page.getByTestId('local-login').click()
  await expect(page).toHaveURL('/')

  await page.getByRole('link', { name: '書類' }).first().click()
  await expect(page).toHaveURL('/documents')
  await expect(page.getByText('まだ書類がありません')).toBeVisible()

  const fileInput = page.locator('input[type="file"][accept*="application/pdf"]')
  await fileInput.setInputFiles({
    name: '画面確認用.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nTodoBridge browser test\n%%EOF'),
  })

  await expect(page.getByText('画面確認用.pdf').first()).toBeVisible()
  await page.getByText('画面確認用.pdf').first().click()
  await expect(page.locator('iframe[title="画面確認用.pdf"]')).toBeVisible()
})
