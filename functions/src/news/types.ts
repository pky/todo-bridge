// functions/src/news/types.ts
import * as admin from 'firebase-admin'

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
  title: string
  description: string       // 収集時の生テキスト（英語記事はGemini前のスコアリングに使用）
  content?: string          // スクレイピングした本文の主要部分
  titleJa?: string          // Gemini翻訳後に設定（日本語記事はtitleと同じ）
  summaryJa?: string        // Gemini要約後に設定（日本語記事はdescriptionから）
  contentJa?: string        // 本文主要部分の日本語訳
  tags?: string[]           // Geminiで抽出したAI・技術系キーワードタグ
  url: string
  thumbnailUrl: string | null
  topic: NewsTopic
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
  publishedAt: admin.firestore.Timestamp
  fetchedAt: admin.firestore.Timestamp
  date: string // "2026-03-04"
}

export interface RawArticle {
  title: string
  url: string
  description: string
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
  publishedAt: Date
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

export interface PersonalizedArticle {
  articleId: string
  articleRef: string
  displayScore: number
  date: string
}
