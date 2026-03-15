import type { ActionType, ImportantLevel, NewsArticle, RawArticle } from './types'

const HARD_ACTION_REQUIRED_KEYWORDS = [
  'must',
  'required',
  'requirement',
  'deadline',
  'deprecate',
  'deprecated',
  'target sdk',
  'compatibility',
  'migration',
  '移行',
  '必須',
  '要件',
  '期限',
  '審査',
  '最低要件',
  'compliance',
  'enforcement',
] as const

const POLICY_URGENT_KEYWORDS = [
  'must',
  'required',
  'deadline',
  'enforcement',
  'compliance',
  '移行',
  '必要',
  '期限',
  '必須',
  '要件',
] as const

const ACTION_TYPE_RULES: Array<{ type: ActionType; keywords: string[] }> = [
  { type: 'sdk_requirement', keywords: ['sdk', 'target sdk', 'xcode', 'ios sdk', '最低要件'] },
  { type: 'policy', keywords: ['policy', 'guideline', 'play policy', 'ガイドライン', 'ポリシー'] },
  { type: 'beta', keywords: ['beta', 'preview', 'release candidate', 'rc', 'ベータ'] },
  { type: 'release', keywords: ['release', 'available', '一般提供', 'リリース'] },
  { type: 'security', keywords: ['security', '脆弱性', 'セキュリティ'] },
]

function normalizeText(title: string, description: string): string {
  return `${title} ${description}`.toLowerCase()
}

function normalizeDateString(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function hasDeadlineContext(text: string, start: number, end: number): boolean {
  const contextStart = Math.max(0, start - 24)
  const contextEnd = Math.min(text.length, end + 24)
  const context = text.slice(contextStart, contextEnd).toLowerCase()

  const englishPatterns = [
    /\bbefore\b/,
    /\bby\b/,
    /\buntil\b/,
    /\bdeadline\b/,
    /\bdue\b/,
    /\brequired\b/,
    /\bmust\b/,
    /\bneed to\b/,
    /\bstarting\b/,
    /\beffective\b/,
    /\bcompliance\b/,
    /\benforcement\b/,
  ]
  if (englishPatterns.some((pattern) => pattern.test(context))) {
    return true
  }

  return ['までに', '期限', '必須', '必要', '対応', '移行', '施行'].some((keyword) => context.includes(keyword))
}

export function extractRequiredByDate(title: string, description: string): string | undefined {
  const text = `${title} ${description}`
  const explicitDateRegex = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g
  for (const explicitDateMatch of text.matchAll(explicitDateRegex)) {
    if (typeof explicitDateMatch.index !== 'number') continue
    if (!hasDeadlineContext(text, explicitDateMatch.index, explicitDateMatch.index + explicitDateMatch[0].length)) {
      continue
    }
    const normalized = normalizeDateString(
      Number(explicitDateMatch[1]),
      Number(explicitDateMatch[2]),
      Number(explicitDateMatch[3])
    )
    if (normalized) return normalized
  }

  const japaneseDateRegex = /(20\d{2})年(\d{1,2})月(\d{1,2})日/g
  for (const japaneseDateMatch of text.matchAll(japaneseDateRegex)) {
    if (typeof japaneseDateMatch.index !== 'number') continue
    if (!hasDeadlineContext(text, japaneseDateMatch.index, japaneseDateMatch.index + japaneseDateMatch[0].length)) {
      continue
    }
    const normalized = normalizeDateString(
      Number(japaneseDateMatch[1]),
      Number(japaneseDateMatch[2]),
      Number(japaneseDateMatch[3])
    )
    if (normalized) return normalized
  }

  return undefined
}

export function detectActionRequired(title: string, description: string): boolean {
  const text = normalizeText(title, description)
  if (HARD_ACTION_REQUIRED_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return true
  }

  const actionType = detectActionType(title, description)
  if (actionType === 'policy' || actionType === 'play_policy') {
    return POLICY_URGENT_KEYWORDS.some((keyword) => text.includes(keyword))
  }

  if (actionType === 'sdk_requirement') {
    return ['sdk', 'xcode', 'target sdk', '最低要件'].some((keyword) => text.includes(keyword))
  }

  return false
}

export function detectActionType(title: string, description: string): ActionType {
  const text = normalizeText(title, description)

  for (const rule of ACTION_TYPE_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      return rule.type
    }
  }

  return 'other'
}

export function detectImportantLevel(title: string, description: string): ImportantLevel {
  const actionType = detectActionType(title, description)
  const actionRequired = detectActionRequired(title, description)
  const requiredByDate = extractRequiredByDate(title, description)

  if (actionRequired || requiredByDate) {
    return 'urgent'
  }

  if (['sdk_requirement', 'policy', 'play_policy', 'security', 'store_review'].includes(actionType)) {
    return 'review'
  }

  return 'reference'
}

export function classifyMobileArticle<T extends Pick<RawArticle, 'title' | 'description'>>(article: T): {
  actionRequired: boolean
  actionType: ActionType
  importantLevel: ImportantLevel
  requiredByDate?: string
} {
  return {
    actionRequired: detectActionRequired(article.title, article.description),
    actionType: detectActionType(article.title, article.description),
    importantLevel: detectImportantLevel(article.title, article.description),
    requiredByDate: extractRequiredByDate(article.title, article.description),
  }
}

export function applyMobileClassification(article: NewsArticle): NewsArticle {
  const { actionRequired, actionType, importantLevel, requiredByDate } = classifyMobileArticle(article)
  return {
    ...article,
    actionRequired,
    actionType,
    importantLevel,
    ...(requiredByDate ? { requiredByDate } : {}),
  }
}
