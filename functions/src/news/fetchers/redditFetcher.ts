// functions/src/news/fetchers/redditFetcher.ts
import axios from 'axios'
import type { RawArticle } from '../types'

const SUBREDDITS = ['MachineLearning', 'artificial', 'LocalLLaMA']
const REDDIT_API = 'https://www.reddit.com'

interface RedditPost {
  data: {
    title: string
    url: string
    selftext: string
    thumbnail: string
    score: number
    created_utc: number
    is_self: boolean
  }
}

interface RedditResponse {
  data: {
    children: RedditPost[]
  }
}

export async function fetchRedditArticles(limitPerSub = 20, onSuccess?: () => void): Promise<RawArticle[]> {
  const articles: RawArticle[] = []
  let succeeded = false

  for (const sub of SUBREDDITS) {
    try {
      const { data } = await axios.get<RedditResponse>(
        `${REDDIT_API}/r/${sub}/hot.json?limit=${limitPerSub}`,
        { timeout: 10000, headers: { 'User-Agent': 'ReRTM-NewsBot/1.0' } }
      )

      if (!Array.isArray(data.data.children)) {
        console.error(`[reddit] r/${sub} の記事一覧の形式が不正です`)
        continue
      }
      for (const post of data.data.children) {
        const { title, url, selftext, thumbnail, score, created_utc, is_self } = post.data

        // セルフポスト（本文のみ）はスキップ
        if (is_self && !selftext) continue

        const thumbnailUrl =
          thumbnail && thumbnail.startsWith('http') ? thumbnail : null

        articles.push({
          title,
          url: is_self ? `${REDDIT_API}/r/${sub}/comments/` + url.split('/').slice(-2, -1)[0] : url,
          description: selftext.slice(0, 500),
          thumbnailUrl,
          source: 'reddit',
          sourceName: `r/${sub}`,
          score,
          publishedAt: new Date(created_utc * 1000),
        })
      }
      succeeded = true
    } catch (error) {
      const reason = axios.isAxiosError(error) ? error.response?.status ?? error.code : undefined
      console.error(`[reddit] Failed to fetch r/${sub}:`, reason)
    }
  }

  if (succeeded) onSuccess?.()
  return articles
}
