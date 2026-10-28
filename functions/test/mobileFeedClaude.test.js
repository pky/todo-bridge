const test = require('node:test')
const assert = require('node:assert/strict')
const admin = require('firebase-admin')

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'demo-rertm' })
}

const {
  MOBILE_FEED_MAX_ARTICLES,
  isEligibleMobileFeedArticle,
} = require('../lib/news/generatePersonalizedFeed')

test('isEligibleMobileFeedArticle は inScope true かつ done だけを通す', () => {
  assert.equal(
    isEligibleMobileFeedArticle({ inScope: true, classificationStatus: 'done' }),
    true
  )
  assert.equal(
    isEligibleMobileFeedArticle({ inScope: false, classificationStatus: 'done' }),
    false
  )
  assert.equal(
    isEligibleMobileFeedArticle({ inScope: true, classificationStatus: 'pending' }),
    false
  )
  assert.equal(isEligibleMobileFeedArticle({}), false)
})

test('MOBILE_FEED_MAX_ARTICLES は 15', () => {
  assert.equal(MOBILE_FEED_MAX_ARTICLES, 15)
})
