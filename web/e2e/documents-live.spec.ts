import { expect, test } from '@playwright/test'

function createTestPdf(): Buffer {
  const content = 'BT /F1 20 Tf 48 110 Td (TodoBridge document) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf)
}

test('ローカルログインから書類追加とサムネイル表示まで操作できる', async ({ page }) => {
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
    buffer: createTestPdf(),
  })

  await expect(page.getByText('画面確認用.pdf').first()).toBeVisible()
  await expect(page.getByAltText('画面確認用.pdfのサムネイル')).toBeVisible({ timeout: 15_000 })
  await page.getByText('画面確認用.pdf').first().click()
  await expect(page.locator('iframe[title="画面確認用.pdf"]')).toBeVisible()

  await fileInput.setInputFiles({
    name: 'サムネイル確認.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWPQqDihUXGCAUIBACTuBaFpkxOkAAAAAElFTkSuQmCC',
      'base64'
    ),
  })

  await expect(page.getByAltText('サムネイル確認.pngのサムネイル')).toBeVisible({ timeout: 15_000 })
})
