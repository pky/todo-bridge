import axios from 'axios'
import * as cheerio from 'cheerio'
import { MOBILE_SOURCES } from './mobileSources'
import type { RawArticle } from '../types'

const TIMEOUT_MS = 10000

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function parseDate(value?: string): Date {
  if (!value) return new Date()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

// "26 Oct 2026" / "October 5, 2026" を UTC の日付として解釈する（実行環境のタイムゾーンに依存させない）
function parseUtcDate(day: string, monthName: string, year: string): Date | null {
  const month = MONTHS[monthName.slice(0, 3).toLowerCase()]
  if (month === undefined) return null
  return new Date(Date.UTC(Number(year), month, Number(day)))
}

function parseAppleDate(text: string): Date | null {
  const match = text.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/)
  return match ? parseUtcDate(match[1], match[2], match[3]) : null
}

function parseAndroidDate(text: string): Date | null {
  const match = text.match(/([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/)
  return match ? parseUtcDate(match[2], match[1], match[3]) : null
}

function toAbsoluteUrl(url: string | undefined, baseUrl: string): string | null {
  if (!url) return null
  try {
    return new URL(url, baseUrl).toString()
  } catch {
    return null
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function parseAppleSecurityReleases(html: string, baseUrl: string): RawArticle[] {
  const $ = cheerio.load(html)
  const articles: RawArticle[] = []
  const source = MOBILE_SOURCES.find((item) => item.name === 'Apple Security Releases')
  if (!source) return articles

  $('tr').each((_, row) => {
    const cells = $(row).children('td')
    if (cells.length < 3) return

    const anchor = cells.eq(0).find('a[href]').first()
    const title = normalizeText(anchor.text())
    if (!/^(iOS|iPadOS|Xcode)/.test(title)) return

    const url = toAbsoluteUrl(anchor.attr('href'), baseUrl)
    if (!url || !url.startsWith('https://')) return

    const publishedAt = parseAppleDate(normalizeText(cells.eq(2).text()))
    if (!publishedAt) return

    articles.push({
      title,
      url,
      description: normalizeText(cells.eq(1).text()).slice(0, 1500),
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: source.name,
      sourceTier: source.sourceTier,
      platform: source.platform,
      isOfficial: source.isOfficial,
      score: null,
      publishedAt,
    })
  })

  return articles
}

export function parseAndroidSecurityBulletins(html: string, baseUrl: string): RawArticle[] {
  const $ = cheerio.load(html)
  const articles: RawArticle[] = []
  const source = MOBILE_SOURCES.find((item) => item.name === 'Android Security Bulletin')
  if (!source) return articles

  $('table').each((_, table) => {
    const headers = $(table).find('th').map((__, th) => normalizeText($(th).text())).get()
    if (!headers.includes('Bulletin') || !headers.includes('Published date')) return

    $(table).find('tr').each((__, row) => {
      const cells = $(row).children('td')
      if (cells.length < 4) return

      const anchor = cells.eq(0).find('a[href]').first()
      const title = normalizeText(anchor.text())
      const url = toAbsoluteUrl(anchor.attr('href'), baseUrl)
      if (!title || !url || !url.startsWith('https://')) return

      const publishedAt = parseAndroidDate(normalizeText(cells.eq(2).text()))
      if (!publishedAt) return

      const patchLevels = normalizeText(cells.eq(3).text())
      articles.push({
        title,
        url,
        description: patchLevels ? `Security patch level: ${patchLevels}` : '',
        thumbnailUrl: null,
        topic: 'mobile',
        source: 'official',
        sourceName: source.name,
        sourceTier: source.sourceTier,
        platform: source.platform,
        isOfficial: source.isOfficial,
        score: null,
        publishedAt,
      })
    })
  })

  return articles
}

function parseAppStoreConnectReleaseNotes(html: string, baseUrl: string): RawArticle[] {
  const $ = cheerio.load(html)
  const articles: RawArticle[] = []
  const source = MOBILE_SOURCES.find((item) => item.name === 'App Store Connect Release Notes')
  if (!source) return articles

  $('h5').each((_, el) => {
    const dateText = $(el).text().trim()
    if (!dateText) return

    const titleNode = $(el).nextAll('p, h6, h5').first()
    const title = titleNode.text().trim()
    if (!title || title === dateText) return

    const descriptionParts: string[] = []
    let node = titleNode.next()
    while (node.length > 0 && node[0] && 'name' in node[0] && node[0].name !== 'h5') {
      const text = node.text().trim()
      if (text) descriptionParts.push(text)
      node = node.next()
    }

    const description = descriptionParts.join(' ').slice(0, 1500)
    const url = `${baseUrl}#${slugify(`${dateText}-${title}`)}`

    articles.push({
      title,
      url,
      description,
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: source.name,
      sourceTier: source.sourceTier,
      platform: source.platform,
      isOfficial: source.isOfficial,
      score: null,
      publishedAt: parseDate(dateText),
    })
  })

  return articles
}

function parsePlayConsoleAnnouncements(html: string, baseUrl: string): RawArticle[] {
  const $ = cheerio.load(html)
  const articles: RawArticle[] = []
  const source = MOBILE_SOURCES.find((item) => item.name === 'Play Console Announcements')
  if (!source) return articles

  $('li.announcement__post').each((_, el) => {
    const container = $(el)
    const link = container.find('a.announcement__post-body-read-more-link').first()
    const href = toAbsoluteUrl(link.attr('href'), baseUrl)
    if (!href) return

    const title = container.find('h2.announcement__post-title').first().text().trim()
    if (!title) return

    const subHead = container.find('h3.announcement__post-sub-head').first().text().trim()
    const body = container.find('.announcement__post-body-content').first().text().trim()
    const description = [subHead, body].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 1500)
    const dateMatch = title.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/)

    articles.push({
      title,
      url: href,
      description,
      thumbnailUrl: null,
      topic: 'mobile',
      source: 'official',
      sourceName: source.name,
      sourceTier: source.sourceTier,
      platform: source.platform,
      isOfficial: source.isOfficial,
      score: null,
      publishedAt: parseDate(dateMatch?.[0]),
    })
  })

  return articles
}

export async function fetchOfficialMobileHtmlArticles(): Promise<RawArticle[]> {
  const htmlSources = MOBILE_SOURCES.filter((source) => source.kind === 'html')
  const results = await Promise.all(
    htmlSources.map(async (source) => {
      try {
        const { data } = await axios.get<string>(source.url, {
          timeout: TIMEOUT_MS,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ReRTM-Bot/1.0)',
            'Accept': 'text/html',
          },
        })

        let articles: RawArticle[] = []
        if (source.name === 'App Store Connect Release Notes') {
          articles = parseAppStoreConnectReleaseNotes(data, source.url)
        } else if (source.name === 'Play Console Announcements') {
          articles = parsePlayConsoleAnnouncements(data, source.url)
        } else if (source.name === 'Apple Security Releases') {
          articles = parseAppleSecurityReleases(data, source.url)
        } else if (source.name === 'Android Security Bulletin') {
          articles = parseAndroidSecurityBulletins(data, source.url)
        }

        return articles.slice(0, source.limit ?? articles.length)
      } catch (err) {
        console.error(`[mobile-official] Failed to fetch ${source.name}:`, err)
        return [] as RawArticle[]
      }
    })
  )

  return results.flat()
}
