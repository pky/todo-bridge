// functions/src/news/fetchers/hnFetcher.ts
import axios from 'axios'
import type { RawArticle } from '../types'

const HN_API = 'https://hacker-news.firebaseio.com/v0'
const TIMEOUT_MS = 10000

interface HNItem {
  id: number
  title?: string
  url?: string
  score?: number
  time?: number
  type?: string
  text?: string
}

export function selectHnStories(items: Array<HNItem | null>, limit: number): RawArticle[] {
  const articles: RawArticle[] = []
  for (const item of items) {
    if (articles.length >= limit) break
    if (!item || !item.title || !item.url || item.type !== 'story') continue
    let publisherDomain: string | undefined
    try { publisherDomain = new URL(item.url).hostname.replace(/^www\./, '') } catch { /* 不正URLでは掲載元を補わない。 */ }
    articles.push({
      title: item.title,
      url: item.url,
      description: item.text || '',
      thumbnailUrl: null,
      source: 'hn',
      sourceName: 'Hacker News',
      ...(publisherDomain ? { publisherDomain } : {}),
      generalSource: true,
      score: item.score ?? 0,
      publishedAt: new Date((item.time ?? 0) * 1000),
    })
  }
  return articles
}

export async function fetchHNArticles(): Promise<RawArticle[]> {
  const { data: ids } = await axios.get<number[]>(`${HN_API}/topstories.json`, { timeout: TIMEOUT_MS })
  const top100 = ids.slice(0, 100)
  const items: Array<HNItem | null> = []

  // 上位100件すべてを20件ずつ取得し、関連性は後段で判定する。
  for (let i = 0; i < top100.length; i += 20) {
    const batch = top100.slice(i, i + 20)
    items.push(...await Promise.all(
      batch.map(id => axios.get<HNItem | null>(`${HN_API}/item/${id}.json`, { timeout: TIMEOUT_MS })
        .then(r => r.data)
        .catch(() => null))
    ))
  }
  return selectHnStories(items, 100)
}
