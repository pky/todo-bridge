import type { MobilePlatform, NewsTopic, SourceTier } from '../types'

export type MobileSourceKind = 'html' | 'rss' | 'atom'

export interface MobileSourceConfig {
  topic: NewsTopic
  platform: MobilePlatform
  name: string
  url: string
  kind: MobileSourceKind
  sourceTier: SourceTier
  isOfficial: boolean
  limit?: number
}

export const MOBILE_SOURCES: MobileSourceConfig[] = [
  {
    topic: 'mobile',
    platform: 'ios',
    name: 'Apple Developer News JP',
    url: 'https://developer.apple.com/jp/news/rss/news.rss',
    kind: 'rss',
    sourceTier: 'official-rss',
    isOfficial: true,
    limit: 8,
  },
  {
    topic: 'mobile',
    platform: 'ios',
    name: 'Apple Developer News EN',
    url: 'https://developer.apple.com/news/rss/news.rss',
    kind: 'rss',
    sourceTier: 'official-rss',
    isOfficial: true,
    limit: 8,
  },
  {
    topic: 'mobile',
    platform: 'ios',
    name: 'App Store Connect Release Notes',
    url: 'https://developer.apple.com/help/app-store-connect/release-notes/',
    kind: 'html',
    sourceTier: 'official',
    isOfficial: true,
    limit: 8,
  },
  {
    topic: 'mobile',
    platform: 'android',
    name: 'Android Developers Blog',
    url: 'https://android-developers.googleblog.com/feeds/posts/default?alt=rss',
    kind: 'rss',
    sourceTier: 'official-rss',
    isOfficial: true,
    limit: 8,
  },
  {
    topic: 'mobile',
    platform: 'android',
    name: 'Play Console Announcements',
    url: 'https://support.google.com/googleplay/android-developer/announcements/13412212?hl=en',
    kind: 'html',
    sourceTier: 'official',
    isOfficial: true,
    limit: 8,
  },
  {
    topic: 'mobile',
    platform: 'ios',
    name: 'Apple Security Releases',
    url: 'https://support.apple.com/en-us/100100',
    kind: 'html',
    sourceTier: 'official',
    isOfficial: true,
    limit: 8,
  },
  {
    topic: 'mobile',
    platform: 'android',
    name: 'Android Security Bulletin',
    url: 'https://source.android.com/docs/security/bulletin/asb-overview',
    kind: 'html',
    sourceTier: 'official',
    isOfficial: true,
    limit: 8,
  },
]
