import axios from 'axios'
import * as cheerio from 'cheerio'
import { classifyMobileArticle } from '../mobileClassifier'
import { MOBILE_SOURCES } from './mobileSources'
import type { RawArticle } from '../types'

const TIMEOUT_MS = 10000

function parseDate(value?: string): Date {
  if (!value) return new Date()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

function parseRelativeDate(value?: string): Date {
  if (!value) return new Date()

  const match = value.trim().match(/^(\d+)\s*(d|w|mo|y)$/i)
  if (!match) return new Date()

  const amount = Number(match[1])
  const unit = match[2].toLowerCase()
  const date = new Date()

  switch (unit) {
    case 'd':
      date.setDate(date.getDate() - amount)
      break
    case 'w':
      date.setDate(date.getDate() - (amount * 7))
      break
    case 'mo':
      date.setMonth(date.getMonth() - amount)
      break
    case 'y':
      date.setFullYear(date.getFullYear() - amount)
      break
    default:
      break
  }

  return date
}

function toAbsoluteUrl(url: string | undefined, baseUrl: string): string | null {
  if (!url) return null
  try {
    return new URL(url, baseUrl).toString()
  } catch {
    return null
  }
}

function parseAppleNews(html: string, baseUrl: string): RawArticle[] {
  const $ = cheerio.load(html)
  const articles: RawArticle[] = []
  const source = MOBILE_SOURCES.find((item) => item.url === baseUrl)
  if (!source) return articles

  $('a.article-title[href*="?id="]').each((_, el) => {
    const link = toAbsoluteUrl($(el).attr('href'), baseUrl)
    const title = $(el).find('h2, h3').first().text().trim() || $(el).text().trim()
    if (!link || !title || link === baseUrl) return

    const container = $(el).closest('li.article, li, article, section, div')
    const description = container.find('.article-text p, .article-copy p, p').first().text().trim()
    const dateText = container.find('time').attr('datetime')
      || container.find('.article-date, .date').first().text().trim()
    const thumbnailUrl = toAbsoluteUrl(container.find('img').first().attr('src'), baseUrl)
    const { actionRequired, actionType, importantLevel, requiredByDate } = classifyMobileArticle({ title, description })

    articles.push({
      title,
      url: link,
      description,
      thumbnailUrl,
      topic: 'mobile',
      source: 'official',
      sourceName: source.name,
      sourceTier: source.sourceTier,
      platform: source.platform,
      isOfficial: source.isOfficial,
      actionRequired,
      actionType,
      importantLevel,
      ...(requiredByDate ? { requiredByDate } : {}),
      score: null,
      publishedAt: parseDate(dateText),
    })
  })

  return articles
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

function parseBloggerLike(html: string, baseUrl: string, sourceName: string): RawArticle[] {
  const $ = cheerio.load(html)
  const articles: RawArticle[] = []
  const source = MOBILE_SOURCES.find((item) => item.name === sourceName)
  if (!source) return articles

  $('article, .post, .blog-posts .post-outer').each((_, el) => {
    const root = $(el)
    const anchor = root.find('h1 a, h2 a, h3 a, .post-title a').first()
    const title = anchor.text().trim()
    const link = toAbsoluteUrl(anchor.attr('href'), baseUrl)
    if (!title || !link) return

    const description = root.find('.post-body, .entry-content, p').first().text().trim()
    const dateText =
      root.find('time').attr('datetime')
      || root.find('abbr.published').attr('title')
      || root.find('h2.date-header').first().text().trim()
    const thumbnailUrl = toAbsoluteUrl(root.find('img').first().attr('src'), baseUrl)
    const { actionRequired, actionType, importantLevel, requiredByDate } = classifyMobileArticle({ title, description })

    articles.push({
      title,
      url: link,
      description,
      thumbnailUrl,
      topic: 'mobile',
      source: 'official',
      sourceName: source.name,
      sourceTier: source.sourceTier,
      platform: source.platform,
      isOfficial: source.isOfficial,
      actionRequired,
      actionType,
      importantLevel,
      ...(requiredByDate ? { requiredByDate } : {}),
      score: null,
      publishedAt: parseDate(dateText),
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
    const { actionRequired, actionType, importantLevel, requiredByDate } = classifyMobileArticle({ title, description })
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
      actionRequired,
      actionType,
      importantLevel,
      ...(requiredByDate ? { requiredByDate } : {}),
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
    const { actionRequired, actionType, importantLevel, requiredByDate } = classifyMobileArticle({ title, description })

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
      actionRequired,
      actionType,
      importantLevel,
      ...(requiredByDate ? { requiredByDate } : {}),
      score: null,
      publishedAt: parseDate(dateMatch?.[0]),
    })
  })

  return articles
}

function parseLinkedInShowcase(html: string, baseUrl: string): RawArticle[] {
  const $ = cheerio.load(html)
  const articles: RawArticle[] = []
  const seen = new Set<string>()
  const source = MOBILE_SOURCES.find((item) => item.name === 'Apple Developer LinkedIn')
  if (!source) return articles

  const candidateAnchors = $('a[href]').toArray().filter((el) => {
    const anchor = $(el)
    const text = normalizeText(anchor.text())
    const href = toAbsoluteUrl(anchor.attr('href'), baseUrl)
    if (!href || href === baseUrl) return false
    if (href.includes('/showcase/appledeveloper')) return false
    if (text.length < 8) return false
    if (text.startsWith('#')) return false
    if (['Apple Developer', 'Report this post', 'Like', 'Comment', 'Share', 'Follow', 'Join now'].includes(text)) return false
    return true
  })

  for (const el of candidateAnchors) {
    const anchor = $(el)
    const href = toAbsoluteUrl(anchor.attr('href'), baseUrl)
    if (!href) continue

    let container = anchor.closest('li, article, div, section')
    let containerText = ''
    let depth = 0

    while (container.length > 0 && depth < 6) {
      const text = normalizeText(container.text())
      if (text.includes('Report this post') || text.includes('Like') || text.includes('Share')) {
        containerText = text
        break
      }
      container = container.parent()
      depth += 1
    }

    if (!containerText) continue

    const title = normalizeText(anchor.text())
    const relativeDate = containerText.match(/\b\d+\s*(?:d|w|mo|y)\b/i)?.[0]
    const description = normalizeText(
      containerText
        .replace(/Apple Developer/g, '')
        .replace(/\d[\d,]*\s+followers/g, '')
        .replace(/\b\d+\s*(?:d|w|mo|y)\b/gi, '')
        .replace(/Report this post/g, '')
        .replace(/Like Comment Share/g, '')
        .replace(title, '')
    ).slice(0, 1500)

    const key = `${title}::${href}`
    if (seen.has(key)) continue
    seen.add(key)

    const { actionRequired, actionType, importantLevel, requiredByDate } = classifyMobileArticle({ title, description })
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
      actionRequired,
      actionType,
      importantLevel,
      ...(requiredByDate ? { requiredByDate } : {}),
      score: null,
      publishedAt: parseRelativeDate(relativeDate),
    })
  }

  return articles.slice(0, source.limit ?? articles.length)
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
        if (source.name === 'Apple Developer News' || source.name === 'Apple Developer News EN') {
          articles = parseAppleNews(data, source.url)
        } else if (source.name === 'App Store Connect Release Notes') {
          articles = parseAppStoreConnectReleaseNotes(data, source.url)
        } else if (source.name === 'Apple Developer LinkedIn') {
          articles = parseLinkedInShowcase(data, source.url)
        } else if (source.name === 'Play Console Announcements') {
          articles = parsePlayConsoleAnnouncements(data, source.url)
        } else {
          articles = parseBloggerLike(data, source.url, source.name)
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
