import { createHash } from 'node:crypto'
import { OcrPageResult } from '../providers/types'
import { DocumentSuggestionType } from '../types'

export interface ExtractedDocumentSuggestion {
  id: string
  type: DocumentSuggestionType
  title: string
  value: Record<string, unknown>
  pageNumber: number
  sourceExcerpt: string
  confidence: number | null
}

const DATE_PATTERN = /(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日/g
const MONEY_PATTERN = /(?:[¥￥]\s*([\d,]+)|([\d,]+)\s*円)/g
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_PATTERN = /(?<!\d)(0\d{1,4}[-‐ー]\d{1,4}[-‐ー]\d{3,4})(?!\d)/g

function compactExcerpt(value: string, maxLength: number = 300): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`
}

function createSuggestion(
  input: Omit<ExtractedDocumentSuggestion, 'id'>
): ExtractedDocumentSuggestion | null {
  if (!input.title.trim() || !input.sourceExcerpt.trim() || input.pageNumber < 1) return null
  const stableValue = JSON.stringify({
    type: input.type,
    title: input.title,
    value: input.value,
    pageNumber: input.pageNumber,
    sourceExcerpt: input.sourceExcerpt,
  })
  return {
    ...input,
    id: createHash('sha256').update(stableValue).digest('hex').slice(0, 32),
  }
}

function getContext(text: string, start: number, length: number): string {
  const lineStart = Math.max(text.lastIndexOf('\n', start) + 1, start - 60)
  const nextBreak = text.indexOf('\n', start + length)
  const lineEnd = nextBreak >= 0 ? Math.min(nextBreak, start + length + 100) : start + length + 100
  return compactExcerpt(text.slice(lineStart, lineEnd))
}

function toIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function extractDates(page: OcrPageResult): ExtractedDocumentSuggestion[] {
  const suggestions: ExtractedDocumentSuggestion[] = []
  for (const match of page.text.matchAll(DATE_PATTERN)) {
    const year = match[1] ? Number(match[1]) : null
    const month = Number(match[2])
    const day = Number(match[3])
    const date = year ? toIsoDate(year, month, day) : null
    if (year && !date) continue
    const excerpt = getContext(page.text, match.index ?? 0, match[0].length)
    const isDeadline = /(まで|締切|期限|提出|必着)/.test(excerpt)
    const isEvent = /(日時|開催|行事|予定|集合|開始|実施)/.test(excerpt)
    const timeMatch = excerpt.match(/(?:午前|午後)?\s*(\d{1,2})(?::|時)\s*(\d{1,2})?分?/)
    const role = isDeadline && !isEvent ? 'deadline' : isEvent && !isDeadline ? 'event' : 'ambiguous'
    const suggestion = createSuggestion({
      type: role === 'deadline' ? 'task' : role === 'event' ? 'calendar_event' : 'field',
      title: role === 'deadline'
        ? `期限：${match[0].trim()}`
        : role === 'event' ? `予定：${match[0].trim()}` : `日付：${match[0].trim()}`,
      value: {
        ...(role === 'ambiguous' ? { fieldType: 'date' } : {}),
        date,
        dateText: match[0].trim(),
        yearAmbiguous: year === null,
        role,
        roleAmbiguous: role === 'ambiguous',
        time: timeMatch
          ? `${String(Number(timeMatch[1])).padStart(2, '0')}:${String(Number(timeMatch[2] ?? 0)).padStart(2, '0')}`
          : null,
      },
      pageNumber: page.pageNumber,
      sourceExcerpt: excerpt,
      confidence: year && role !== 'ambiguous' ? 0.9 : role !== 'ambiguous' ? 0.72 : 0.55,
    })
    if (suggestion) suggestions.push(suggestion)
  }
  return suggestions
}

function extractPatternValues(page: OcrPageResult): ExtractedDocumentSuggestion[] {
  const suggestions: ExtractedDocumentSuggestion[] = []
  const addMatches = (
    pattern: RegExp,
    build: (match: RegExpMatchArray, excerpt: string) => Omit<ExtractedDocumentSuggestion, 'id' | 'pageNumber' | 'sourceExcerpt'>
  ) => {
    for (const match of page.text.matchAll(pattern)) {
      const excerpt = getContext(page.text, match.index ?? 0, match[0].length)
      const suggestion = createSuggestion({
        ...build(match, excerpt),
        pageNumber: page.pageNumber,
        sourceExcerpt: excerpt,
      })
      if (suggestion) suggestions.push(suggestion)
    }
  }
  addMatches(MONEY_PATTERN, (match) => {
    const amount = Number((match[1] ?? match[2]).replace(/,/g, ''))
    return { type: 'amount', title: `金額：${match[0]}`, value: { amount, currency: 'JPY', raw: match[0] }, confidence: 0.9 }
  })
  addMatches(EMAIL_PATTERN, (match) => ({
    type: 'contact', title: `メール：${match[0]}`, value: { kind: 'email', address: match[0] }, confidence: 0.95,
  }))
  addMatches(PHONE_PATTERN, (match) => ({
    type: 'contact', title: `電話：${match[0]}`, value: { kind: 'phone', number: match[0] }, confidence: 0.9,
  }))
  page.text.split(/\r?\n/).forEach((line) => {
    const fieldMatch = line.match(/^\s*(持ち物|場所|会場|支払先)\s*[：:]\s*(.+)$/)
    if (!fieldMatch) return
    const fieldType = fieldMatch[1] === '持ち物' ? 'items'
      : fieldMatch[1] === '支払先' ? 'payee' : 'location'
    const suggestion = createSuggestion({
      type: 'field',
      title: `${fieldMatch[1]}：${compactExcerpt(fieldMatch[2], 100)}`,
      value: { fieldType, text: compactExcerpt(fieldMatch[2], 500) },
      pageNumber: page.pageNumber,
      sourceExcerpt: compactExcerpt(line),
      confidence: 0.88,
    })
    if (suggestion) suggestions.push(suggestion)
  })
  return suggestions
}

export function extractDocumentSuggestions(pages: OcrPageResult[]): ExtractedDocumentSuggestion[] {
  const unique = new Map<string, ExtractedDocumentSuggestion>()
  pages.forEach((page) => {
    [...extractDates(page), ...extractPatternValues(page)].forEach((suggestion) => {
      unique.set(suggestion.id, suggestion)
    })
  })
  return [...unique.values()].slice(0, 100)
}
