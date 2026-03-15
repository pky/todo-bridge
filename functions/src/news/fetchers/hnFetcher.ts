// functions/src/news/fetchers/hnFetcher.ts
import axios from 'axios'
import type { RawArticle } from '../types'

const HN_API = 'https://hacker-news.firebaseio.com/v0'
const AI_KEYWORDS = [
  'AI', 'machine learning', 'LLM', 'GPT', 'Claude', 'Gemini',
  'artificial intelligence', 'neural', 'deep learning', 'OpenAI',
  'Anthropic', 'model', 'transformer', 'diffusion',
  'Copilot', 'GitHub Copilot', 'Microsoft Copilot', 'agent',
  'coding assistant', 'code generation', 'developer tool'
]

interface HNItem {
  id: number
  title?: string
  url?: string
  score?: number
  time?: number
  type?: string
  text?: string
}

function isAIRelated(title: string): boolean {
  const lower = title.toLowerCase()
  return AI_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))
}

export async function fetchHNArticles(limit = 50): Promise<RawArticle[]> {
  // トップストーリーIDを取得
  const { data: ids } = await axios.get<number[]>(`${HN_API}/topstories.json`)
  const top200 = ids.slice(0, 200)

  // 並列でアイテム詳細を取得（20件ずつバッチ処理）
  const articles: RawArticle[] = []
  for (let i = 0; i < top200.length && articles.length < limit; i += 20) {
    const batch = top200.slice(i, i + 20)
    const items = await Promise.all(
      batch.map(id => axios.get<HNItem>(`${HN_API}/item/${id}.json`).then(r => r.data))
    )

    for (const item of items) {
      if (!item.title || !item.url || item.type !== 'story') continue
      if (!isAIRelated(item.title)) continue

      articles.push({
        title: item.title,
        url: item.url,
        description: item.text || '',
        thumbnailUrl: null,
        source: 'hn',
        sourceName: 'Hacker News',
        score: item.score ?? 0,
        publishedAt: new Date((item.time ?? 0) * 1000),
      })

      if (articles.length >= limit) break
    }
  }

  return articles
}
