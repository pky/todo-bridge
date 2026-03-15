// functions/src/news/scraper.ts
import axios from 'axios'
import * as cheerio from 'cheerio'

const TIMEOUT_MS = 8000
const MIN_CONTENT_LENGTH = 500
const MAX_CONTENT_LENGTH = 5000

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim()
}

function extractCandidateText($: ReturnType<typeof cheerio.load>, selector: string): string {
  const texts: string[] = []

  $(selector).each((_, element) => {
    const block = $(element)
    const paragraphTexts = block.find('p, li').map((__, child) => normalizeText($(child).text())).get()
    const joinedParagraphs = paragraphTexts.filter((text) => text.length >= 40).join('\n\n')
    const fallbackText = normalizeText(block.text())
    const candidate = joinedParagraphs.length > fallbackText.length ? joinedParagraphs : fallbackText

    if (candidate.length >= MIN_CONTENT_LENGTH) {
      texts.push(candidate)
    }
  })

  return texts.sort((a, b) => b.length - a.length)[0] ?? ''
}

// 1回のフェッチで本文とOGP画像を両方取得
export async function scrapeArticle(url: string): Promise<{ content: string; ogImage: string | null }> {
  try {
    const { data } = await axios.get<string>(url, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReRTM-Bot/1.0)',
      },
      maxContentLength: 500_000,
    })

    const $ = cheerio.load(data)

    // OGP画像を取得
    const ogImage =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[name="twitter:image:src"]').attr('content') ||
      null

    // ナビ・フッター・広告を除去して本文を取得
    $('nav, footer, aside, script, style, noscript, form, .ad, .advertisement, .sidebar, .comments, #comments').remove()
    const candidates = [
      'article',
      'main',
      '.crayons-article__main',
      '#article-body',
      '.article-body',
      '.post-content',
      '.entry-content',
      '.markdown-body',
      '[data-testid="article-content"]',
      'body',
    ]
    let content = ''
    for (const selector of candidates) {
      const text = extractCandidateText($, selector)
      if (text.length >= MIN_CONTENT_LENGTH) {
        content = text.slice(0, MAX_CONTENT_LENGTH)
        break
      }
    }

    return { content, ogImage }
  } catch {
    return { content: '', ogImage: null }
  }
}

// 後方互換: 本文のみ返す
export async function scrapeArticleContent(url: string): Promise<string> {
  const { content } = await scrapeArticle(url)
  return content
}
