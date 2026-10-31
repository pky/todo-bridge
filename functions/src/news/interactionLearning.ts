// functions/src/news/interactionLearning.ts
// newsInteractions から好みのキーワードを学ぶ純粋関数（Firestore に依存しない）
import type { NewsArticle, NewsPreferences } from './types'

export type InteractionSignalKind = 'click' | 'readLater' | 'dismiss'

export interface InteractionSignal {
  kind: InteractionSignalKind
  atMs: number
  titleEn?: string
  summaryJa?: string
  tags?: string[]
}

export interface LearnedKeywords {
  positive: string[]
  negative: string[]
}

export const SIGNAL_WEIGHTS = { click: 1, readLater: 2, dismiss: -1 } as const
export const LEARNING_HALF_LIFE_DAYS = 30
export const LEARNING_WINDOW_DAYS = 90
export const LEARNED_KEYWORD_THRESHOLD = 1.5
export const LEARNED_POSITIVE_MULTIPLIER = 1.5
export const LEARNED_NEGATIVE_MULTIPLIER = 0.7

const DAY_MS = 24 * 60 * 60 * 1000

// 日本語テキストに混在する英語技術用語も含めて抽出（3文字以上、ストップワード除外）
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her',
  'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how',
  'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'did',
  'let', 'put', 'say', 'she', 'too', 'use',
  'this', 'that', 'with', 'from', 'have', 'will', 'your', 'more', 'also',
  'into', 'they', 'been', 'were', 'what', 'when', 'which', 'about', 'their',
  'than', 'then', 'them', 'some', 'just', 'like', 'other', 'over', 'only',
  'news', 'said', 'says', 'show', 'shows', 'using', 'used', 'make', 'made',
  'http', 'https', 'year', 'week', 'time', 'data', 'model', 'models',
])

export function extractKeywords(text: string): string[] {
  // 小文字化して英字シーケンスを正規表現で直接抽出
  // 日本語テキスト内の "Claude" "LLM" "RAG" なども拾える
  const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? []
  return words.filter(w => !STOP_WORDS.has(w))
}

function toMillis(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (value !== null && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (value as { toMillis: () => unknown }).toMillis()
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null
  }
  return null
}

export function buildInteractionSignals(data: Record<string, unknown>): InteractionSignal[] {
  const titleEn = typeof data.titleEn === 'string' && data.titleEn !== '' ? data.titleEn : undefined
  const summaryJa = typeof data.summaryJa === 'string' && data.summaryJa !== '' ? data.summaryJa : undefined
  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t): t is string => typeof t === 'string' && t !== '')
    : []
  if (!titleEn && !summaryJa && tags.length === 0) return []

  const make = (kind: InteractionSignalKind, atMs: number): InteractionSignal => ({
    kind,
    atMs,
    ...(titleEn ? { titleEn } : {}),
    ...(summaryJa ? { summaryJa } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  })

  const signals: InteractionSignal[] = []
  const readLaterMs = toMillis(data.readLaterAt)
  if (readLaterMs !== null) signals.push(make('readLater', readLaterMs))
  const clickedMs = toMillis(data.clickedAt)
  if (clickedMs !== null) signals.push(make('click', clickedMs))
  // 後で読むは内部で dismissed も立つため、二重に数えない
  if (data.dismissed === true && !data.readLaterAt) {
    const dismissedMs = toMillis(data.dismissedAt)
    if (dismissedMs !== null) signals.push(make('dismiss', dismissedMs))
  }
  return signals
}

export function learnKeywordPreferences(signals: InteractionSignal[], nowMs: number): LearnedKeywords {
  const totals = new Map<string, number>()
  for (const signal of signals) {
    const age = Math.max((nowMs - signal.atMs) / DAY_MS, 0)
    if (age > LEARNING_WINDOW_DAYS) continue
    const weight = SIGNAL_WEIGHTS[signal.kind] * 0.5 ** (age / LEARNING_HALF_LIFE_DAYS)

    const words = new Set<string>()
    for (const tag of signal.tags ?? []) words.add(tag.toLowerCase())
    for (const kw of extractKeywords(`${signal.titleEn ?? ''} ${signal.summaryJa ?? ''}`)) words.add(kw)
    for (const word of words) totals.set(word, (totals.get(word) ?? 0) + weight)
  }

  const positive: string[] = []
  const negative: string[] = []
  for (const [word, total] of totals) {
    if (total >= LEARNED_KEYWORD_THRESHOLD) positive.push(word)
    else if (total <= -LEARNED_KEYWORD_THRESHOLD) negative.push(word)
  }
  return { positive, negative }
}

export function calcPreferenceMultiplier(
  article: Pick<NewsArticle, 'title' | 'titleJa' | 'summaryJa' | 'description'>,
  preferences: Pick<NewsPreferences, 'keywords'>,
  learned: LearnedKeywords
): number {
  // titleJa/summaryJa は要約後に設定されるため、未設定時は title/description で代用
  const text = `${article.titleJa ?? ''} ${article.summaryJa ?? ''} ${article.title} ${article.description ?? ''}`.toLowerCase()
  let multiplier = 1.0

  for (const kw of preferences.keywords) {
    if (text.includes(kw.word.toLowerCase())) {
      multiplier = Math.max(multiplier, kw.weight)
    }
  }

  for (const word of learned.positive) {
    if (text.includes(word)) {
      multiplier = Math.max(multiplier, LEARNED_POSITIVE_MULTIPLIER)
    }
  }

  if (multiplier === 1.0 && learned.negative.some(word => text.includes(word))) {
    return LEARNED_NEGATIVE_MULTIPLIER
  }
  return multiplier
}
