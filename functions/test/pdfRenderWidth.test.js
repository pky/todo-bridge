// 期待する純粋API: documents/preview の getSafePdfRenderWidth(pageWidth: number, pageHeight: number, requestedWidth: number): number。
// previewとOCRの両方で共有する描画幅計算を対象とする。
const test = require('node:test')
const assert = require('node:assert/strict')
const { getSafePdfRenderWidth } = require('../lib/documents/preview')

test('正方形PDFの描画幅は指定値を維持する', () => {
  assert.equal(getSafePdfRenderWidth(100, 100, 960), 960)
})

test('縦横比1対100のPDFは指定幅の二乗の2倍以下の面積に縮める', () => {
  const requestedWidth = 960
  const width = getSafePdfRenderWidth(1, 100, requestedWidth)
  assert.ok(Number.isFinite(width))
  assert.ok(width >= 1 && width < requestedWidth)
  assert.ok(width * (width * 100) <= 2 * requestedWidth ** 2)
})

test('極端に細長いPDFでも描画幅を1未満にしない', () => {
  const width = getSafePdfRenderWidth(1, 1e12, 960)
  assert.ok(Number.isFinite(width))
  assert.ok(width >= 1)
})
