const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const { fetchRedditArticles } = require('../lib/news/fetchers/redditFetcher')

function post(title, overrides = {}) {
  return {
    data: {
      title,
      url: `https://example.com/${title}`,
      selftext: '',
      score: 12,
      created_utc: 1760000000,
      is_self: false,
      ...overrides,
    },
  }
}

function listing(...children) {
  return { data: { children } }
}

async function fetchWithResponses(t, ...responses) {
  let next = 0
  const respond = async () => {
    const response = next < responses.length ? responses[next++] : listing()
    if (response instanceof Error) throw response
    return response
  }
  const getJson = t.mock.fn(respond)
  // getJson 導入前の実装にも同じ応答を渡し、入力処理とログの不具合を再現する。
  t.mock.method(axios, 'get', async () => ({ data: await respond() }))
  const errorLog = t.mock.method(console, 'error', () => {})
  const onSuccess = t.mock.fn()
  const articles = await fetchRedditArticles(20, onSuccess, { getJson })
  return { articles, getJson, errorLog, onSuccess }
}

test('不正なタイトル・投稿時刻・リンクを飛ばし、同じ応答の正常な記事は返す', async t => {
  const missingTitle = post('missing-title')
  delete missingTitle.data.title
  const missingDate = post('missing-date')
  delete missingDate.data.created_utc
  const missingUrl = post('missing-url')
  delete missingUrl.data.url

  const first = post('valid-http', { url: 'http://example.com/valid-http' })
  const last = post('valid-https')
  const { articles } = await fetchWithResponses(t, listing(
    first,
    missingTitle,
    post('', { url: 'https://example.com/empty-title' }),
    missingDate,
    post('string-date', { created_utc: '1760000000' }),
    post('infinite-date', { created_utc: Infinity }),
    missingUrl,
    post('ftp-link', { url: 'ftp://example.com/ftp-link' }),
    last,
  ))

  assert.deepEqual(articles.map(({ title, url }) => ({ title, url })), [first, last].map(
    ({ data: { title, url } }) => ({ title, url }),
  ))
})

test('本文だけの投稿は末尾スラッシュを含む permalink をそのまま使う', async t => {
  const permalink = '/r/fixture-ai/comments/sample-id/sample-title/'
  const { articles } = await fetchWithResponses(t, listing(post('self-post', {
    is_self: true,
    selftext: '架空の投稿本文',
    permalink,
  })))

  assert.deepEqual(articles.map(({ url }) => url), [`https://www.reddit.com${permalink}`])
})

test('本文だけの投稿は有効な permalink と空でない本文がある場合だけ返す', async t => {
  const { articles } = await fetchWithResponses(t, listing(
    post('missing-permalink', { is_self: true, selftext: '架空の投稿本文' }),
    post('relative-permalink', { is_self: true, selftext: '架空の投稿本文', permalink: 'r/fixture-ai/comments/sample/' }),
    post('empty-body', { is_self: true, permalink: '/r/fixture-ai/comments/empty-body/' }),
    post('valid-link'),
  ))

  assert.deepEqual(articles.map(({ title }) => title), ['valid-link'])
})

test('リンク投稿の本文が文字列でなく反応数が有限でなくても、記事は返す', async t => {
  const { articles } = await fetchWithResponses(t, listing(
    post('invalid-description', { selftext: null, score: '12' }),
    post('infinite-score', { score: Infinity }),
  ))

  assert.deepEqual(articles.map(({ title, description, score }) => ({ title, description, score })), [
    { title: 'invalid-description', description: '', score: null },
    { title: 'infinite-score', description: '', score: null },
  ])
})

test('例外と不正な一覧があっても、getJson で残りを取得して成功を1回通知する', async t => {
  const { articles, getJson, onSuccess } = await fetchWithResponses(t,
    new Error('架空の Reddit 通信エラー'),
    { data: { children: {} } },
    listing(post('reachable')),
  )

  assert.deepEqual(articles.map(({ title }) => title), ['reachable'])
  assert.equal(onSuccess.mock.callCount(), 1)
  assert.equal(getJson.mock.callCount(), 3)
})

test('全 subreddit が失敗したら成功を通知せず、HTTP ステータスと例外メッセージを記録する', async t => {
  const httpError = new axios.AxiosError('架空の HTTP エラー')
  httpError.response = { status: 503 }
  const connectionError = new Error('架空の Reddit 接続エラー')
  const { articles, errorLog, onSuccess } = await fetchWithResponses(t,
    httpError,
    connectionError,
    { data: { children: {} } },
  )

  assert.deepEqual(articles, [])
  assert.equal(onSuccess.mock.callCount(), 0)
  const logs = errorLog.mock.calls.map(({ arguments: args }) => args.map(String).join(' '))
  assert.ok(logs.some(line => line.includes('503')), 'HTTP ステータスをログに残す')
  assert.ok(logs.some(line => line.includes(connectionError.message)), '例外メッセージをログに残す')
})
