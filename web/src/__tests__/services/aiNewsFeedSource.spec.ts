import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_FEED_LATEST_PATH, classifyStorageError, fetchLatestAiFeedBytes } from '@/services/aiNewsFeedSource'
import { feedBytes } from '../fixtures/aiNewsV2'

const sdk = vi.hoisted(() => ({
  storage: {}, reference: {}, getBytes: vi.fn(), ref: vi.fn(), getStorage: vi.fn(),
  connectStorageEmulator: vi.fn(), getDownloadURL: vi.fn(), getMetadata: vi.fn(), list: vi.fn(), listAll: vi.fn(),
}))
vi.mock('firebase/storage', () => ({ ...sdk, getStorage: () => sdk.storage }))
vi.mock('@/services/firebaseApp', () => ({ default: {}, isEmulator: true, emulatorHost: '127.0.0.1', storageEmulatorPort: 19199 }))
vi.mock('@/services/firebase', () => ({ default: {}, storage: sdk.storage, auth: { currentUser: null }, db: {} }))

describe('AIニュースの固定Storage原本', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.ref.mockReturnValue(sdk.reference)
    sdk.getBytes.mockResolvedValue(feedBytes())
  })

  it('latest.jsonを認証付きSDKで1MiB上限の1回だけ取得する', async () => {
    const expected = feedBytes()
    sdk.getBytes.mockResolvedValue(expected)
    expect(AI_FEED_LATEST_PATH).toBe('news/v2/ai/latest.json')
    expect(await fetchLatestAiFeedBytes()).toBe(expected)
    expect(sdk.ref).toHaveBeenCalledExactlyOnceWith(sdk.storage, 'news/v2/ai/latest.json')
    expect(sdk.getBytes).toHaveBeenCalledExactlyOnceWith(sdk.reference, 1048576)
    for (const forbidden of [sdk.getDownloadURL, sdk.getMetadata, sdk.list, sdk.listAll]) {
      expect(forbidden).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['storage/unauthenticated', 'unauthenticated'], ['storage/unauthorized', 'unauthorized'],
    ['storage/object-not-found', 'not-found'], ['storage/retry-limit-exceeded', 'transient'],
    ['storage/quota-exceeded', 'transient'], ['storage/canceled', 'transient'],
    ['storage/network-request-failed', 'transient'], ['storage/unknown-code', 'other'],
  ])('%sを%sとして分類する', (code, expected) => {
    expect(classifyStorageError({ code })).toBe(expected)
  })

  it('通信例外を権限エラーにせず、一方で未知例外はotherにする', () => {
    expect(classifyStorageError(new TypeError('Failed to fetch'))).toBe('transient')
    for (const error of [new Error('不明な失敗'), null, {}, 'unknown']) {
      expect(classifyStorageError(error)).toBe('other')
    }
  })

  it('SDKの取得失敗を空原本に変換しない', async () => {
    const error = { code: 'storage/object-not-found' }
    sdk.getBytes.mockRejectedValue(error)
    await expect(fetchLatestAiFeedBytes()).rejects.toBe(error)
  })
})
