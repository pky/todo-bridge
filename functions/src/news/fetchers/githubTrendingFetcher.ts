// functions/src/news/fetchers/githubTrendingFetcher.ts
import axios from 'axios'
import * as cheerio from 'cheerio'
import type { RawArticle } from '../types'

const TRENDING_URL = 'https://github.com/trending?since=daily'
const AI_KEYWORDS = [
  'ai',
  'llm',
  'claude',
  'agent',
  'gemini',
  'gpt',
  'openai',
  'copilot',
  'github-copilot',
  'microsoft',
  'ml',
  'machine-learning',
  'deep-learning',
  'coding-assistant',
  'codegen',
  'code-generation',
  'developer-tool',
]
const TIMEOUT_MS = 10000

function containsAiKeyword(text: string): boolean {
  const lower = text.toLowerCase()
  return AI_KEYWORDS.some(kw => lower.includes(kw))
}

export async function fetchGitHubTrending(limit = 10): Promise<RawArticle[]> {
  try {
    const { data } = await axios.get<string>(TRENDING_URL, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReRTM-Bot/1.0)',
        'Accept': 'text/html',
      },
    })

    const $ = cheerio.load(data)
    const articles: RawArticle[] = []

    $('article.Box-row').each((_, el) => {
      if (articles.length >= limit) return

      const repoLink = $(el).find('h2 a').first()
      const repoPath = repoLink.attr('href')?.trim().replace(/^\//, '') ?? ''
      if (!repoPath) return

      const name = repoPath
      const url = `https://github.com/${repoPath}`
      const description = $(el).find('p').first().text().trim()

      if (!containsAiKeyword(name) && !containsAiKeyword(description)) return

      // "stars today" を抽出（本日のスター獲得数）
      const todaySpanText = $(el).find('.float-sm-right').text()
      const todayMatch = todaySpanText.match(/([\d,]+)\s*stars today/)
      const starsToday = todayMatch ? parseInt(todayMatch[1].replace(/,/g, ''), 10) : 0

      articles.push({
        title: name,
        url,
        description: description || `GitHub trending repository: ${name}`,
        thumbnailUrl: null,
        source: 'github',
        sourceName: 'GitHub Trending',
        score: starsToday,
        publishedAt: new Date(),
      })
    })

    console.log(`[github-trending] fetched ${articles.length} AI-related repositories`)
    return articles
  } catch (err) {
    console.error('[github-trending] Failed to fetch:', err)
    return []
  }
}
