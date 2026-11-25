import { describe, expect, it } from 'vitest'
import { formatAiReaction, formatReactionCount } from '@/utils/aiNewsReactions'

describe('formatReactionCount', () => {
  it.each([
    [0, '0'], [825, '825'], [999, '999'], [1000, '1k'], [1049, '1k'], [1051, '1.1k'],
    [3200, '3.2k'], [11999, '12k'], [12000, '12k'],
  ] as const)('%iを%sと表示する', (count, label) => {
    expect(formatReactionCount(count)).toBe(label)
  })
})

describe('formatAiReaction', () => {
  it.each([
    ['hn', 825, 'HN 825pt'],
    ['github', 3200, 'GitHub +3.2k stars today'],
    ['reddit', 12000, 'Reddit 12k upvotes'],
    ['zenn', 1049, 'Zenn 1k いいね'],
    ['qiita', 0, 'Qiita 0 いいね'],
  ] as const)('%sの反応を整形する', (source, count, label) => {
    expect(formatAiReaction({ source, count })).toBe(label)
  })
})
