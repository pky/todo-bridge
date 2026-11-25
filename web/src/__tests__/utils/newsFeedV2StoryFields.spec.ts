import { describe, expect, it } from 'vitest'
import { parseAiFeedV2 } from '@/utils/newsFeedV2'
import { feedBytes, makeFeed } from '../fixtures/aiNewsV2'

function feedWith(fields: Record<string, unknown>) {
  const feed = makeFeed()
  return { ...feed, totalCount: 1, articles: [{ ...feed.articles[0], ...fields }] }
}

const validReaction = { source: 'hn', count: 0 }
const validLink = { title: '別の架空記事', sourceName: '架空技術誌', url: 'https://example.test/related' }

describe('AIニュースv2の話題の項目', () => {
  it('反応10件と関連5件を受理し、反応のURLは省略できる', () => {
    const sources = ['hn', 'github', 'reddit', 'zenn', 'qiita']
    const reactions = Array.from({ length: 10 }, (_, n) => ({
      source: sources[n % sources.length], count: n, ...(n ? { url: `https://example.test/discussion/${n}` } : {}),
    }))
    const related = Array.from({ length: 5 }, (_, n) => ({ ...validLink, url: `${validLink.url}/${n}` }))
    const feed = feedWith({ reactions, related })
    expect(parseAiFeedV2(feedBytes(feed))).toEqual({ ok: true, feed })
  })

  it.each([
    ['反応が配列でない', { reactions: validReaction }],
    ['反応が空', { reactions: [] }],
    ['反応が11件', { reactions: Array.from({ length: 11 }, () => validReaction) }],
    ['情報源が不明', { reactions: [{ ...validReaction, source: 'rss' }] }],
    ['反応数が負', { reactions: [{ ...validReaction, count: -1 }] }],
    ['反応数が小数', { reactions: [{ ...validReaction, count: 1.5 }] }],
    ['反応数が文字列', { reactions: [{ ...validReaction, count: '1' }] }],
    ['反応のURLがHTTP', { reactions: [{ ...validReaction, url: 'http://example.test/discussion' }] }],
    ['関連が配列でない', { related: validLink }],
    ['関連が空', { related: [] }],
    ['関連が6件', { related: Array.from({ length: 6 }, () => validLink) }],
    ['関連のタイトルが空白', { related: [{ ...validLink, title: ' ' }] }],
    ['関連の情報源名が空', { related: [{ ...validLink, sourceName: '' }] }],
    ['関連のURLがHTTP', { related: [{ ...validLink, url: 'http://example.test/related' }] }],
  ] as const)('「%s」に該当する記事を不正と判定する', (_name, fields) => {
    expect(parseAiFeedV2(feedBytes(feedWith(fields)))).toEqual({ ok: false, reason: 'invalid-feed' })
  })
})
