// web/src/types/news.ts
import type { Timestamp } from 'firebase/firestore'

export type NewsTopic = 'ai' | 'mobile'
export type NewsSource = 'hn' | 'reddit' | 'rss' | 'github' | 'official'
export type MobilePlatform = 'ios' | 'android' | 'cross'
export type SourceTier = 'official' | 'official-rss' | 'community-rss'
export type ActionType =
  | 'sdk_requirement'
  | 'policy'
  | 'beta'
  | 'release'
  | 'security'
  | 'store_review'
  | 'play_policy'
  | 'other'

export type ImportantLevel = 'urgent' | 'review' | 'reference'

export interface NewsArticle {
  id: string
  title: string
  description?: string
  content?: string
  titleJa?: string
  summaryJa?: string
  contentJa?: string
  tags?: string[]
  url: string
  thumbnailUrl: string | null
  topic?: NewsTopic
  source: NewsSource
  sourceName: string
  sourceTier?: SourceTier
  platform?: MobilePlatform
  isOfficial?: boolean
  actionRequired?: boolean
  actionType?: ActionType
  importantLevel?: ImportantLevel
  requiredByDate?: string
  score: number | null
  publishedAt: Timestamp
  fetchedAt: Timestamp
  date: string
}

export interface PersonalizedFeedItem {
  articleId: string
  articleRef: string
  displayScore: number
  date: string
}

export interface KeywordWeight {
  word: string
  weight: number
}

export interface NewsPreferences {
  keywords: KeywordWeight[]
  platforms?: Array<'ios' | 'android'>
  officialOnly?: boolean
  includeCommunity?: boolean
  actionRequiredOnly?: boolean
}

export interface DiscordNotificationPreferences {
  enabled: boolean
  webhookUrl?: string
  urgentImmediate: boolean
  dailyDigest: boolean
}

export interface MobileNotificationPreferences {
  discord?: DiscordNotificationPreferences
}

export interface NewsInteraction {
  topic?: NewsTopic
  articleId: string
  url?: string        // URLベースフィルタリング用（同URLが翌日再収集された場合も除外するため）
  clickedAt?: import('firebase/firestore').Timestamp
  dismissed?: boolean
  dismissedAt?: import('firebase/firestore').Timestamp
  shownCount?: number
  lastShownDate?: string
  lastShownAt?: import('firebase/firestore').Timestamp
  // クリック時に記事メタ情報を保存（嗜好学習に使用）
  titleEn?: string
  summaryJa?: string  // 日本語要約（日本語記事の学習に使用）
  tags?: string[]     // AI抽出タグ
}
