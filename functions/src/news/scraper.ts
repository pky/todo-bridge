// functions/src/news/scraper.ts
import axios from 'axios'
import * as cheerio from 'cheerio'
import * as dns from 'node:dns'
import { isIP } from 'node:net'

const TIMEOUT_MS = 8000
const MIN_CONTENT_LENGTH = 500
const MAX_CONTENT_LENGTH = 5000

export function isPublicScrapeAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return a !== 0 && a !== 10 && a !== 127
      && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && b === 168)
      && !(a === 169 && b === 254)
      && !(a === 100 && b >= 64 && b <= 127)
      && a < 224
  }
  if (family !== 6 || address.includes('%')) return false
  // URLの正規化によりIPv4表記入り・省略表記も同じIPv6表現で判定する。
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16)
  return !normalized.startsWith('::')
    && (first & 0xfe00) !== 0xfc00
    && (first & 0xffc0) !== 0xfe80
    && (first & 0xff00) !== 0xff00
}

function assertSafeScrapeDestination(protocol: string, hostname: string): void {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(protocol) || !host
    || (isIP(host) !== 0 && !isPublicScrapeAddress(host))) {
    throw new Error('記事の取得先が許可されていません')
  }
}

const safeLookup: NonNullable<import('axios').AxiosRequestConfig['lookup']> = (hostname, _options, callback) => {
  // 接続時に全アドレスを検査し、その検査済みの結果だけを接続に渡す。
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, [])
    if (!addresses.length || !addresses.every(({ address }) => isPublicScrapeAddress(address))) {
      return callback(new Error('記事の名前解決先が許可されていません'), [])
    }
    callback(null, addresses.map<import('axios').LookupAddressEntry>(({ address }) => ({
      address,
      family: isIP(address) === 6 ? 6 : 4,
    })))
  })
}

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

function extractMainContentFromDom($: ReturnType<typeof cheerio.load>): string {
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
  for (const selector of candidates) {
    const text = extractCandidateText($, selector)
    if (text.length >= MIN_CONTENT_LENGTH) {
      return text.slice(0, MAX_CONTENT_LENGTH)
    }
  }
  return ''
}

// HTML 文字列から本文を取り出す
export function extractMainContent(html: string): string {
  return extractMainContentFromDom(cheerio.load(html))
}

// 1回のフェッチで本文とOGP画像を両方取得
export async function scrapeArticle(url: string, options?: { signal?: AbortSignal }): Promise<{ content: string; ogImage: string | null; fetchFailed: boolean }> {
  try {
    const parsed = new URL(url)
    assertSafeScrapeDestination(parsed.protocol, parsed.hostname)
    const { data, status } = await axios.get<string>(url, {
      timeout: TIMEOUT_MS,
      ...(options?.signal ? { signal: options.signal } : {}),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReRTM-Bot/1.0)',
      },
      maxContentLength: 500_000,
      proxy: false,
      lookup: safeLookup,
      beforeRedirect: (redirect) => {
        if (typeof redirect.protocol !== 'string' || typeof redirect.hostname !== 'string') {
          throw new Error('記事の転送先が不正です')
        }
        assertSafeScrapeDestination(redirect.protocol, redirect.hostname)
      },
    })
    if (status < 200 || status >= 300) return { content: '', ogImage: null, fetchFailed: true }

    const $ = cheerio.load(data)

    // OGP画像を取得
    const ogImage =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[name="twitter:image:src"]').attr('content') ||
      null

    const content = extractMainContentFromDom($)

    return { content, ogImage, fetchFailed: false }
  } catch {
    return { content: '', ogImage: null, fetchFailed: true }
  }
}

// 後方互換: 本文のみ返す
export async function scrapeArticleContent(url: string): Promise<string> {
  const { content } = await scrapeArticle(url)
  return content
}
