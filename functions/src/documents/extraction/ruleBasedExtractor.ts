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

const DATE_PATTERN = /(?:(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日|(?:(\d{4})\s*[/／]\s*)?(\d{1,2})\s*[/／]\s*(\d{1,2}))/g
const DATE_REFERENCE_PATTERN = /(?:(?:\d{4})年)?\s*\d{1,2}月\s*\d{1,2}日|(?:(?:\d{4})\s*[/／]\s*)?\d{1,2}\s*[/／]\s*\d{1,2}/
const EVENT_CONTEXT_PATTERN = /日にち|日程|日時|開催|行事|予定|集合|開始|実施|大会|練習|行こう|いこう|踊(?:る|ろう|って|ります)|お祭り|祭り|イベント/
const JAPANESE_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

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

function getDateContext(text: string, start: number, lineCount: number = 3): string {
  const lineStart = text.lastIndexOf('\n', start) + 1
  return compactExcerpt(text.slice(lineStart).split(/\r?\n/).slice(0, lineCount).join('\n'))
}

function formatTime(period: string | undefined, hourText: string, minuteText?: string): string {
  let hour = Number(hourText)
  if (period === '午後' && hour < 12) hour += 12
  if (period === '午前' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${String(Number(minuteText ?? 0)).padStart(2, '0')}`
}

function extractTimeRange(text: string): { time: string | null; endTime: string | null } {
  const match = text.match(
    /(?:(午前|午後)\s*)?(\d{1,2})(?::|時)\s*(\d{1,2})?分?(?:\s*[〜～~ー-]\s*(?:(午前|午後)\s*)?(\d{1,2})(?::|時)\s*(\d{1,2})?分?)?/
  )
  if (!match) return { time: null, endTime: null }
  return {
    time: formatTime(match[1], match[2], match[3]),
    endTime: match[5] ? formatTime(match[4] ?? match[1], match[5], match[6]) : null,
  }
}

function isEventTitleCandidate(line: string): boolean {
  const compact = line.trim()
  return compact.length > 0
    && compact.length <= 100
    && !DATE_REFERENCE_PATTERN.test(compact)
    && !/^(?:日にち|日程|日時|開催日|予定|場所|会場|時間)\s*[：:]?/.test(compact)
    && !/^[\s&＆の（()）日月火水木金土曜]+$/.test(compact)
}

function extractEventTitle(
  text: string,
  dateStart: number,
  dateEnd: number,
  dateText: string
): string {
  const followingLines = text.slice(dateEnd).split(/\r?\n/).slice(0, 4)
  const precedingLines = text.slice(0, dateStart).split(/\r?\n/).reverse()
  const candidates = [...followingLines, ...precedingLines].filter(isEventTitleCandidate)
  const heading = (candidates.find((line) => EVENT_CONTEXT_PATTERN.test(line))
    ?? candidates[0])?.trim()
  if (!heading) return `予定：${dateText}`
  const unwrapped = heading.replace(/^[〈《【［[(（]\s*/, '').replace(/\s*[〉》】］\])）]$/, '').trim()
  return unwrapped || `予定：${dateText}`
}

function extractLocation(text: string): string | null {
  const match = text.match(/(?:場所|会場)\s*[：:]\s*([^\r\n]+)/)
  if (match?.[1]?.trim()) return match[1].trim()
  const unlabeledLocation = text.split(/\s+/).map((part) => part.trim()).find((part) => (
    part.length > 0
      && part.length <= 100
      && !DATE_REFERENCE_PATTERN.test(part)
      && /(ホール|会館|公民館|体育館|教室|学校|園|駅前|広場|公園|センター)$/.test(part)
  ))
  return unlabeledLocation ?? null
}

function toIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function extractWeekday(text: string, dateEnd: number): number | null {
  const suffix = text.slice(dateEnd, dateEnd + 16)
  const match = suffix.match(/^\s*[（(]?\s*([日月火水木金土])(?:曜(?:日)?)?\s*[）)]?/)
  if (!match) return null
  const weekday = JAPANESE_WEEKDAYS.indexOf(match[1] as typeof JAPANESE_WEEKDAYS[number])
  return weekday >= 0 ? weekday : null
}

function inferDateWithoutYear(
  month: number,
  day: number,
  weekday: number | null,
  referenceDate: Date
): { date: string | null; inferredYear: number | null } {
  const referenceInJst = new Date(referenceDate.getTime() + JST_OFFSET_MS)
  const referenceYear = referenceInJst.getUTCFullYear()
  const years = weekday === null
    ? [referenceYear]
    : Array.from({ length: 7 }, (_, index) => referenceYear - 3 + index)
  const referenceTime = Date.UTC(
    referenceYear,
    referenceInJst.getUTCMonth(),
    referenceInJst.getUTCDate()
  )
  const candidates = years.flatMap((year) => {
    const date = toIsoDate(year, month, day)
    if (!date) return []
    const dateTime = Date.UTC(year, month - 1, day)
    if (weekday !== null && new Date(dateTime).getUTCDay() !== weekday) return []
    return [{ date, year, distance: Math.abs(dateTime - referenceTime) }]
  })
  candidates.sort((left, right) => left.distance - right.distance)
  const nearest = candidates[0]
  return nearest
    ? { date: nearest.date, inferredYear: nearest.year }
    : { date: null, inferredYear: null }
}

function extractDates(page: OcrPageResult, referenceDate: Date): ExtractedDocumentSuggestion[] {
  const suggestions: ExtractedDocumentSuggestion[] = []
  for (const match of page.text.matchAll(DATE_PATTERN)) {
    const yearText = match[1] ?? match[4]
    const year = yearText ? Number(yearText) : null
    const month = Number(match[2] ?? match[5])
    const day = Number(match[3] ?? match[6])
    const lineExcerpt = getContext(page.text, match.index ?? 0, match[0].length)
    const excerpt = getDateContext(page.text, match.index ?? 0)
    const nearbyExcerpt = getDateContext(page.text, match.index ?? 0, 4)
    const isDeadline = /(まで|締切|期限|提出|必着)/.test(lineExcerpt)
    const isEvent = EVENT_CONTEXT_PATTERN.test(lineExcerpt)
      || EVENT_CONTEXT_PATTERN.test(excerpt)
    const timeRange = extractTimeRange(nearbyExcerpt)
    const role = isDeadline && !isEvent ? 'deadline' : isEvent && !isDeadline ? 'event' : 'ambiguous'
    if (role === 'ambiguous') continue
    const dateEnd = (match.index ?? 0) + match[0].length
    const weekday = extractWeekday(page.text, dateEnd)
    const inferred = year === null
      ? inferDateWithoutYear(month, day, weekday, referenceDate)
      : { date: null, inferredYear: null }
    const date = year ? toIsoDate(year, month, day) : inferred.date
    if (year && !date) continue
    const suggestion = createSuggestion({
      type: role === 'deadline' ? 'task' : 'calendar_event',
      title: role === 'deadline'
        ? `期限：${match[0].trim()}`
        : extractEventTitle(
          page.text,
          match.index ?? 0,
          dateEnd,
          match[0].trim()
        ),
      value: {
        date,
        dateText: match[0].trim(),
        yearAmbiguous: year === null,
        ...(inferred.inferredYear !== null ? { inferredYear: inferred.inferredYear } : {}),
        role,
        time: timeRange.time,
        ...(timeRange.endTime ? { endTime: timeRange.endTime } : {}),
        ...(role === 'event' && extractLocation(excerpt)
          ? { location: extractLocation(excerpt) }
          : {}),
      },
      pageNumber: page.pageNumber,
      sourceExcerpt: timeRange.time ? nearbyExcerpt : excerpt,
      confidence: year ? 0.9 : 0.72,
    })
    if (suggestion) suggestions.push(suggestion)
  }
  return suggestions
}

export function extractDocumentSuggestions(
  pages: OcrPageResult[],
  referenceDate: Date = new Date()
): ExtractedDocumentSuggestion[] {
  const unique = new Map<string, ExtractedDocumentSuggestion>()
  pages.forEach((page) => {
    extractDates(page, referenceDate).forEach((suggestion) => {
      unique.set(suggestion.id, suggestion)
    })
  })
  return [...unique.values()].slice(0, 100)
}
