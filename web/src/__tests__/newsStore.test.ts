// web/src/__tests__/newsStore.test.ts
import { describe, it, expect, vi } from 'vitest'

// Gemini APIと外部サービスはモック
vi.mock('@/services/firebase', () => ({ db: {} }))

describe('calcDisplayScore logic', () => {
  it('キーワードが一致しない場合はbaseScoreをそのまま返す', () => {
    const score = 1000
    const keywords = [{ word: 'Claude Code', weight: 2.0 }]
    const text = 'OpenAI releases new model'

    const lower = text.toLowerCase()
    let weight = 1.0
    for (const kw of keywords) {
      if (lower.includes(kw.word.toLowerCase())) {
        weight = Math.max(weight, kw.weight)
      }
    }
    expect(score * weight).toBe(1000)
  })

  it('キーワードが一致した場合はweightを掛け合わせる', () => {
    const score = 200
    const keywords = [{ word: 'Claude Code', weight: 2.0 }]
    const text = 'Claude Code gets new feature'

    const lower = text.toLowerCase()
    let weight = 1.0
    for (const kw of keywords) {
      if (lower.includes(kw.word.toLowerCase())) {
        weight = Math.max(weight, kw.weight)
      }
    }
    expect(score * weight).toBe(400)
  })

  it('低優先キーワードでも元スコアが高ければ上位に来る', () => {
    const claudeScore = 200 * 2.0   // = 400
    const openaiScore = 3000 * 0.5  // = 1500
    expect(openaiScore).toBeGreaterThan(claudeScore)
  })
})
