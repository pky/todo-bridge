const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const axios = require('axios')
const { scrapeArticle } = require('../lib/news/scraper')

const ogImage = 'https://example.test/eyecatch.png'
const articleBody = 'This fictional article explains how to test HTML response sizes. '.repeat(30)

function createHtml(byteLength) {
  const prefix = `<html><head><meta property="og:image" content="${ogImage}"><!--`
  const suffix = `--></head><body><article><p>${articleBody}</p></article></body></html>`
  const html = prefix + 'x'.repeat(byteLength - Buffer.byteLength(prefix + suffix)) + suffix
  assert.equal(Buffer.byteLength(html), byteLength)
  return html
}

function stubResponse(t, html) {
  const get = axios.get
  const errors = []
  // 通信だけをメモリ内の応答に置き換え、サイズ制限は実際のaxiosに判定させる。
  const request = t.mock.fn((_options, onResponse) => {
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.destroy = () => { req.destroyed = true }
    req.end = () => {
      const response = Readable.from([Buffer.from(html)])
      response.statusCode = 200
      response.statusMessage = 'OK'
      response.headers = { 'content-type': 'text/html; charset=utf-8' }
      onResponse(response)
    }
    return req
  })
  t.mock.method(axios, 'get', async (url, config) => {
    try {
      return await get(url, { ...config, transport: { request } })
    } catch (error) {
      errors.push(error)
      throw error
    }
  })
  return { request, errors }
}

test('約1MBのHTMLから本文とOGP画像を取得できる', async t => {
  const { request, errors } = stubResponse(t, createHtml(1_000_000))
  const result = await scrapeArticle('https://example.test/article')

  assert.equal(request.mock.callCount(), 1)
  assert.equal(result.fetchFailed, false,
    `1MBのHTMLは取得失敗にしない（axios: ${errors[0]?.message ?? 'エラーなし'}）`)
  assert.equal(result.ogImage, ogImage)
  assert.equal(result.content, articleBody.trim())
})

test('2MBを超えるHTMLは取得失敗となり本文とOGP画像を返さない', async t => {
  const { request, errors } = stubResponse(t, createHtml(2_100_000))
  const result = await scrapeArticle('https://example.test/article')

  assert.equal(request.mock.callCount(), 1)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'ERR_BAD_RESPONSE')
  assert.match(errors[0].message, /maxContentLength size of .* exceeded/)
  assert.equal(result.fetchFailed, true)
  assert.equal(result.ogImage, null)
  assert.equal(result.content, '')
})
