// functions/src/news/fetchers/githubTrendingFetcher.ts
import axios from 'axios'
import * as cheerio from 'cheerio'
import type { RawArticle } from '../types'

const TRENDING_URL = 'https://github.com/trending?since=daily'
const TIMEOUT_MS = 10000

export function parseGitHubTrending(html: string): RawArticle[] {
  const $ = cheerio.load(html)
  const articles: RawArticle[] = []

  $('article.Box-row').each((_, el) => {
    const repoLink = $(el).find('h2 a').first()
    const repoPath = repoLink.attr('href')?.trim().replace(/^\//, '') ?? ''
    if (!repoPath) return

    const name = repoPath
    const url = `https://github.com/${repoPath}`
    const description = $(el).find('p').first().text().trim()

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
      generalSource: true,
      score: starsToday,
      publishedAt: new Date(),
    })
  })
  return articles
}

export async function fetchGitHubTrending(): Promise<RawArticle[]> {
  try {
    const { data } = await axios.get<string>(TRENDING_URL, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReRTM-Bot/1.0)',
        'Accept': 'text/html',
      },
    })

    const articles = parseGitHubTrending(data)
    console.log(`[github-trending] fetched ${articles.length} repositories`)
    return articles
  } catch (err) {
    console.error('[github-trending] Failed to fetch:', err)
    return []
  }
}
