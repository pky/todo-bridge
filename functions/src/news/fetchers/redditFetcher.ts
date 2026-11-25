// functions/src/news/fetchers/redditFetcher.ts
import axios from 'axios'
import type { RawArticle } from '../types'

const SUBREDDITS = ['MachineLearning', 'artificial', 'LocalLLaMA']
const REDDIT_API = 'https://www.reddit.com'

// Firestore に保存できる UTC の範囲は西暦 1 年から 9999 年まで。
const MIN_PUBLISHED_SECONDS = -62135596800
const MAX_PUBLISHED_SECONDS_EXCLUSIVE = 253402300800

type GetJson = (url: string) => Promise<unknown>

const fetchJson: GetJson = async url => (await axios.get<unknown>(url, {
  timeout: 10000,
  headers: { 'User-Agent': 'ReRTM-NewsBot/1.0' },
})).data

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePost(post: unknown, sub: string): RawArticle | null {
  if (!isRecord(post) || !isRecord(post.data)) return null
  const { title, url, permalink, selftext, thumbnail, score, created_utc, is_self } = post.data
  if (typeof title !== 'string' || title.trim() === '') return null
  if (typeof created_utc !== 'number' || !Number.isFinite(created_utc) ||
    created_utc < MIN_PUBLISHED_SECONDS || created_utc >= MAX_PUBLISHED_SECONDS_EXCLUSIVE) return null

  const description = typeof selftext === 'string' ? selftext.slice(0, 500) : ''
  let articleUrl: string
  if (is_self === true) {
    if (!description || typeof permalink !== 'string' || !permalink.startsWith('/')) return null
    articleUrl = `${REDDIT_API}${permalink}`
  } else {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || !URL.canParse(url)) return null
    articleUrl = url
  }

  return {
    title,
    url: articleUrl,
    description,
    thumbnailUrl: typeof thumbnail === 'string' && thumbnail.startsWith('http') ? thumbnail : null,
    source: 'reddit',
    sourceName: `r/${sub}`,
    score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    publishedAt: new Date(created_utc * 1000),
  }
}

export async function fetchRedditArticles(
  limitPerSub = 20, onSuccess?: () => void, { getJson = fetchJson }: { getJson?: GetJson } = {}
): Promise<RawArticle[]> {
  const articles: RawArticle[] = []
  let succeeded = false

  for (const sub of SUBREDDITS) {
    try {
      const response = await getJson(`${REDDIT_API}/r/${sub}/hot.json?limit=${limitPerSub}`)
      const children = isRecord(response) && isRecord(response.data) ? response.data.children : undefined
      if (!Array.isArray(children)) {
        console.error(`[reddit] r/${sub} の記事一覧の形式が不正です`)
        continue
      }
      for (const post of children) {
        const article = parsePost(post, sub)
        if (article) articles.push(article)
      }
      succeeded = true
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined
      const reason = status ?? (error instanceof Error ? error.message : String(error))
      console.error(`[reddit] Failed to fetch r/${sub}:`, reason)
    }
  }

  if (succeeded) onSuccess?.()
  return articles
}
