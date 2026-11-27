const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const { normalizeUrl } = require('../lib/news/collectArticles')

test('normalizeUrl は先頭の www. の有無を同一視する', () => {
  assert.equal(normalizeUrl('https://www.example.com/a'), 'example.com/a')
  assert.equal(normalizeUrl('https://example.com/a'), 'example.com/a')
})

test('normalizeUrl は末尾の /index.html の有無を同一視する', () => {
  assert.equal(normalizeUrl('https://example.com/a/index.html'), 'example.com/a')
  assert.equal(normalizeUrl('https://example.com/a'), 'example.com/a')
})

test('normalizeUrl はクエリのキー順が異なる URL を同一視する', () => {
  assert.equal(normalizeUrl('https://example.com/a?b=2&a=1'), 'example.com/a?a=1&b=2')
  assert.equal(normalizeUrl('https://example.com/a?a=1&b=2'), 'example.com/a?a=1&b=2')
})

test('normalizeUrl は末尾スラッシュ、スキーム、フラグメントの違いを同一視する', () => {
  assert.equal(normalizeUrl('https://example.com/a'), 'example.com/a')
  assert.equal(normalizeUrl('https://example.com/a/'), 'example.com/a')
  assert.equal(normalizeUrl('http://example.com/a'), 'example.com/a')
  assert.equal(normalizeUrl('https://example.com/a#section'), 'example.com/a')
})

test('normalizeUrl は既存の追跡パラメータを除去する', () => {
  const url = 'https://example.com/a?utm_source=x&utm_medium=x&utm_campaign=x' +
    '&utm_term=x&utm_content=x&fbclid=x&gclid=x'
  assert.equal(normalizeUrl(url), 'example.com/a')
})

test('normalizeUrl は URL として読めない入力をそのまま返す', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url')
  assert.equal(normalizeUrl(''), '')
})

test('normalizeUrl は先頭の www. に該当しないホスト名を保持する', () => {
  assert.equal(normalizeUrl('https://wwwexample.com/a'), 'wwwexample.com/a')
  assert.equal(normalizeUrl('https://foo.www.example.com/a'), 'foo.www.example.com/a')
})

test('normalizeUrl は末尾の /index.html に該当しないパスを保持する', () => {
  assert.equal(normalizeUrl('https://example.com/a/myindex.html'), 'example.com/a/myindex.html')
  assert.equal(normalizeUrl('https://example.com/a/index.html.bak'), 'example.com/a/index.html.bak')
  assert.equal(normalizeUrl('https://example.com/index.html/b'), 'example.com/index.html/b')
})

test('normalizeUrl は同じクエリキーの値の相対順を保持する', () => {
  assert.equal(normalizeUrl('https://example.com/a?a=2&a=1'), 'example.com/a?a=2&a=1')
  assert.equal(normalizeUrl('https://example.com/a?a=1&a=2'), 'example.com/a?a=1&a=2')
  assert.equal(normalizeUrl('https://example.com/a?a=2&b=3&a=1'), 'example.com/a?a=2&a=1&b=3')
})

test('normalizeUrl は追跡パラメータを除去して残りのクエリキーを並べ替える', () => {
  assert.equal(normalizeUrl('https://example.com/a?utm_source=x&b=2&a=1'), 'example.com/a?a=1&b=2')
})

test('normalizeUrl は別パス、別ホスト、別クエリ値を区別する', () => {
  const base = normalizeUrl('https://example.com/a?article=1')
  assert.notEqual(normalizeUrl('https://example.com/b?article=1'), base)
  assert.notEqual(normalizeUrl('https://example.org/a?article=1'), base)
  assert.notEqual(normalizeUrl('https://example.com/a?article=2'), base)
})
