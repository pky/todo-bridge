import axios from 'axios'
import type { RawArticle } from '../types'

type GetJson = (url: string) => Promise<unknown>

const fetchJson: GetJson = async url => (await axios.get<unknown>(url, { timeout: 10000 })).data

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeReactionUrl(url: string): string {
  return url.split(/[?#]/, 1)[0].replace(/\/+$/, '')
}

async function fetchReactionScores(
  sourceName: string, provider: string, topic: string, getJson: GetJson
): Promise<Map<string, number>> {
  const scores = new Map<string, number>()
  const isZenn = provider === 'Zenn'
  try {
    const encodedTopic = encodeURIComponent(topic)
    const endpoint = isZenn
      ? 'https://zenn.dev/api/articles?topicname=' + encodedTopic + '&order=latest'
      : 'https://qiita.com/api/v2/items?query=tag:' + encodedTopic + '&per_page=20'
    const data = await getJson(endpoint)
    const zennArticles = isRecord(data) ? data.articles : undefined
    const articles = isZenn ? zennArticles : data
    if (!Array.isArray(articles)) {
      console.error('[jaReaction] 記事一覧の形式が不正です', sourceName)
      return scores
    }

    let invalidRows = 0
    for (const article of articles) {
      const row = isRecord(article) ? article : undefined
      const url = isZenn ? row?.path : row?.url
      const score = isZenn ? row?.liked_count : row?.likes_count
      if (typeof url !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
        invalidRows++
        continue
      }
      const articleUrl = isZenn ? 'https://zenn.dev' + url : url
      scores.set(normalizeReactionUrl(articleUrl), score)
    }
    if (invalidRows > 0) {
      console.error('[jaReaction] URL または反応数の形式が不正です', sourceName, invalidRows)
    }
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const reason = status ?? (error instanceof Error ? error.message : String(error))
    console.error('[jaReaction] 反応数の取得に失敗しました', sourceName, reason)
  }
  return scores
}

export async function enrichJapaneseReactions(
  articles: RawArticle[], { getJson = fetchJson }: { getJson?: GetJson } = {}
): Promise<RawArticle[]> {
  const scoresBySource = new Map<string, Promise<Map<string, number>>>()
  return Promise.all(articles.map(async article => {
    const match = /^(Zenn|Qiita) (.+)$/.exec(article.sourceName)
    if (!match) return article

    let scores = scoresBySource.get(article.sourceName)
    if (!scores) {
      scores = fetchReactionScores(article.sourceName, match[1], match[2], getJson)
      scoresBySource.set(article.sourceName, scores)
    }
    const score = (await scores).get(normalizeReactionUrl(article.url))
    return score === undefined ? article : { ...article, score }
  }))
}
