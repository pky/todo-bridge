const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  collectSummaryCandidateArticles,
  shouldSkipGeminiForJapaneseArticle,
} = require('../lib/news/generatePersonalizedFeed')

test('Gemini要約候補はユーザー別フィード候補の和集合に限定する', () => {
  const articleA = { id: 'article-a', title: 'A' }
  const articleB = { id: 'article-b', title: 'B' }
  const articleC = { id: 'article-c', title: 'C' }

  const result = collectSummaryCandidateArticles([
    [
      { article: articleA, displayScore: 100 },
      { article: articleB, displayScore: 90 },
    ],
    [
      { article: articleB, displayScore: 95 },
      { article: articleC, displayScore: 80 },
    ],
  ])

  assert.deepEqual(
    result.map((article) => article.id),
    ['article-a', 'article-b', 'article-c']
  )
})

test('日本語記事はGemini要約対象から外す', () => {
  assert.equal(
    shouldSkipGeminiForJapaneseArticle({
      title: '新しいAIモデルを公開しました',
      description: '日本語の説明文です',
      content: '',
    }),
    true
  )
})

test('英語記事はGemini要約対象に残す', () => {
  assert.equal(
    shouldSkipGeminiForJapaneseArticle({
      title: 'New AI model released',
      description: 'A short English summary.',
      content: '',
    }),
    false
  )
})
