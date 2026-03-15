// functions/src/news/fetchers/rssFetcher.ts
import Parser from 'rss-parser'
import type { RawArticle } from '../types'

interface FeedConfig {
  url: string
  name: string
  limit?: number // フィード個別の上限（省略時は fetchRSSArticles の引数を使用）
}

const DEVELOPERS_IO_AI_KEYWORDS = [
  'ai',
  'llm',
  'gpt',
  'chatgpt',
  'openai',
  'claude',
  'anthropic',
  'gemini',
  'google ai',
  'copilot',
  'github copilot',
  'bedrock',
  'rag',
  'agent',
  'agents',
  '生成ai',
  '生成 ai',
  '機械学習',
  '大規模言語モデル',
]

const RSS_FEEDS: FeedConfig[] = [
  // --- 英語メディア ---
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI' },
  { url: 'https://www.theverge.com/rss/ai/index.xml', name: 'The Verge AI' },
  { url: 'https://huggingface.co/blog/feed.xml', name: 'Hugging Face Blog' },
  { url: 'https://www.technologyreview.com/feed/', name: 'MIT Tech Review' },
  { url: 'https://venturebeat.com/category/ai/feed/', name: 'VentureBeat AI' },
  { url: 'https://dev.classmethod.jp/feed/', name: 'DevelopersIO', limit: 8 },
  { url: 'https://menthas.com/all/rss', name: 'Menthas' },
  // Simon Willison's blog（LLM実践知見）
  { url: 'https://simonwillison.net/atom/everything/', name: 'Simon Willison', limit: 10 },
  // dev.to タグ別
  { url: 'https://dev.to/feed/tag/claudeai', name: 'dev.to claudeai', limit: 5 },
  { url: 'https://dev.to/feed/tag/llm', name: 'dev.to llm', limit: 5 },
  // --- 日本語メディア ---
  // はてなブックマーク IT ホットエントリー
  { url: 'https://b.hatena.ne.jp/hotentry/it.rss', name: 'はてなブックマーク IT', limit: 10 },
  // Zenn タグ別（モデル名依存を避け概念タグで広く収集）
  { url: 'https://zenn.dev/topics/ai/feed', name: 'Zenn ai', limit: 10 },
  { url: 'https://zenn.dev/topics/llm/feed', name: 'Zenn llm', limit: 8 },
  { url: 'https://zenn.dev/topics/generativeai/feed', name: 'Zenn generativeai', limit: 5 },
  { url: 'https://zenn.dev/topics/machinelearning/feed', name: 'Zenn machinelearning', limit: 5 },
  { url: 'https://zenn.dev/topics/claude-code/feed', name: 'Zenn claude-code', limit: 5 },
  { url: 'https://zenn.dev/topics/gemini/feed', name: 'Zenn gemini', limit: 5 },
  { url: 'https://zenn.dev/topics/copilot/feed', name: 'Zenn copilot', limit: 5 },
  { url: 'https://zenn.dev/topics/githubcopilotchat/feed', name: 'Zenn githubcopilotchat', limit: 3 },
  // Qiita タグ別（Atom フィード）
  { url: 'https://qiita.com/tags/ai/feed.atom', name: 'Qiita ai', limit: 10 },
  { url: 'https://qiita.com/tags/llm/feed.atom', name: 'Qiita llm', limit: 8 },
  { url: 'https://qiita.com/tags/generativeai/feed.atom', name: 'Qiita generativeai', limit: 5 },
  { url: 'https://qiita.com/tags/machinelearning/feed.atom', name: 'Qiita machinelearning', limit: 5 },
  { url: 'https://qiita.com/tags/claude-code/feed.atom', name: 'Qiita claude-code', limit: 5 },
  { url: 'https://qiita.com/tags/gemini/feed.atom', name: 'Qiita gemini', limit: 5 },
  { url: 'https://qiita.com/tags/copilot/feed.atom', name: 'Qiita copilot', limit: 5 },
  { url: 'https://qiita.com/tags/copilotchat/feed.atom', name: 'Qiita copilotchat', limit: 3 },
]

// media:content / media:thumbnail をカスタムフィールドとして取得
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
    ],
  },
})

// HTMLから最初の<img src>を抽出
function extractImgFromHtml(html: string): string | null {
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/)
  return match ? match[1] : null
}

// RSSアイテムから画像URLを複数の方法で試みる
function extractThumbnail(item: Record<string, unknown>): string | null {
  // 1. media:content
  const mediaContent = item['mediaContent'] as { $?: { url?: string } } | undefined
  if (mediaContent?.$?.url) return mediaContent.$.url

  // 2. media:thumbnail
  const mediaThumbnail = item['mediaThumbnail'] as { $?: { url?: string } } | undefined
  if (mediaThumbnail?.$?.url) return mediaThumbnail.$.url

  // 3. enclosure
  const enclosure = item['enclosure'] as { url?: string } | undefined
  if (enclosure?.url) return enclosure.url

  // 4. content:encoded や content の HTML から <img> を抽出
  const htmlContent = (item['content:encoded'] || item['content'] || '') as string
  if (htmlContent) {
    const img = extractImgFromHtml(htmlContent)
    if (img) return img
  }

  return null
}

function isDevelopersIoAiArticle(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase()
  return DEVELOPERS_IO_AI_KEYWORDS.some(keyword => text.includes(keyword))
}

export async function fetchRSSArticles(limitPerFeed = 10): Promise<RawArticle[]> {
  const articles: RawArticle[] = []

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url)
      const limit = feed.limit ?? limitPerFeed

      for (const item of parsed.items.slice(0, limit)) {
        if (!item.link) continue

        const title = item.title || ''
        const description = item.contentSnippet || item.content || ''

        if (feed.name === 'DevelopersIO' && !isDevelopersIoAiArticle(title, description)) {
          continue
        }

        const thumbnailUrl = extractThumbnail(item as unknown as Record<string, unknown>)

        articles.push({
          title,
          url: item.link,
          description,
          thumbnailUrl,
          source: 'rss',
          sourceName: feed.name,
          score: null,
          publishedAt: item.pubDate ? new Date(item.pubDate) : new Date(),
        })
      }

      const withImg = articles.filter(a => a.thumbnailUrl && a.sourceName === feed.name).length
      console.log(`[rss] ${feed.name}: fetched ${Math.min(parsed.items.length, limit)} items, ${withImg} with images`)
    } catch (err) {
      console.error(`[rss] Failed to fetch ${feed.name}:`, err)
    }
  }

  return articles
}
