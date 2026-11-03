import { getBytes, ref } from 'firebase/storage'
import { storage } from './firebase'
import { AI_FEED_V2_MAX_BYTES } from '@/utils/newsFeedV2'

export const AI_FEED_LATEST_PATH = 'news/v2/ai/latest.json'

export function fetchLatestAiFeedBytes(): Promise<ArrayBuffer> {
  return getBytes(ref(storage, AI_FEED_LATEST_PATH), AI_FEED_V2_MAX_BYTES)
}

export function classifyStorageError(error: unknown): 'unauthenticated' | 'unauthorized' | 'not-found' | 'transient' | 'other' {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  if (code === 'storage/unauthenticated') return 'unauthenticated'
  if (code === 'storage/unauthorized') return 'unauthorized'
  if (code === 'storage/object-not-found') return 'not-found'
  if (['storage/retry-limit-exceeded', 'storage/quota-exceeded', 'storage/canceled', 'storage/network-request-failed'].includes(String(code))) return 'transient'
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return 'transient'
  return 'other'
}
