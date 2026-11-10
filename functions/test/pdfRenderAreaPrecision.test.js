const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assertSafePdfRenderArea,
  getSafePdfRenderWidth,
} = require('../lib/documents/preview')

function getRenderedDimensions(pageWidth, pageHeight, requestedWidth) {
  const width = getSafePdfRenderWidth(pageWidth, pageHeight, requestedWidth)
  // 本番のviewportと同じく、描画幅から倍率を求めて両辺を再計算する。
  const scale = width / pageWidth
  return { width: pageWidth * scale, height: pageHeight * scale }
}

test('OCR用の正当なPDFページを浮動小数点誤差で拒否しない', () => {
  const rendered = getRenderedDimensions(226.77, 453.52, 2000)
  assert.doesNotThrow(() => assertSafePdfRenderArea(rendered.width, rendered.height, 2000))
})

test('サムネイル用の正当なPDFページを高さの切り上げで拒否しない', () => {
  const rendered = getRenderedDimensions(226.77, 455.02, 960)
  assert.doesNotThrow(() => assertSafePdfRenderArea(rendered.width, rendered.height, 960))
})

test('指定した全ページ寸法で選んだ描画幅が面積検査を通る', () => {
  let checked = 0
  let rejected = 0
  let firstFailure = ''

  for (const requestedWidth of [960, 2000]) {
    for (const pageWidth of [226.77, 300, 595.28, 612]) {
      for (let pageHeight = pageWidth; pageHeight <= pageWidth * 20; pageHeight += 0.25) {
        checked += 1
        try {
          const rendered = getRenderedDimensions(pageWidth, pageHeight, requestedWidth)
          assertSafePdfRenderArea(rendered.width, rendered.height, requestedWidth)
        } catch {
          // 最初の失敗で止めず、全組み合わせを検査して短い要約を返す。
          rejected += 1
          if (!firstFailure) firstFailure = `${pageWidth}×${pageHeight}pt、指定幅${requestedWidth}`
        }
      }
    }
  }

  assert.equal(checked, 263582, '全組み合わせを検査する')
  assert.equal(rejected, 0, `拒否${rejected}件、最初: ${firstFailure}`)
})

test('最小描画幅1でも面積上限を超えるPDFページは拒否する', () => {
  for (const requestedWidth of [960, 2000]) {
    const pageWidth = 1
    const pageHeight = 2 * requestedWidth ** 2 + 1
    assert.equal(getSafePdfRenderWidth(pageWidth, pageHeight, requestedWidth), 1)
    const rendered = getRenderedDimensions(pageWidth, pageHeight, requestedWidth)
    assert.throws(
      () => assertSafePdfRenderArea(rendered.width, rendered.height, requestedWidth),
      /PDFページが描画面積の上限を超えています/
    )
  }
})
