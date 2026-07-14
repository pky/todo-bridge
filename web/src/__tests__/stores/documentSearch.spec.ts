import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentSearchStore } from '@/stores/documentSearch'
import { useSpaceStore } from '@/stores/space'

const {
  getDocumentSearchIndexApiMock,
  downloadDocumentSearchIndexMock,
  getCachedDocumentSearchIndexMock,
  putCachedDocumentSearchIndexMock,
  deleteCachedDocumentSearchIndexMock,
} = vi.hoisted(() => ({
  getDocumentSearchIndexApiMock: vi.fn(),
  downloadDocumentSearchIndexMock: vi.fn(),
  getCachedDocumentSearchIndexMock: vi.fn(),
  putCachedDocumentSearchIndexMock: vi.fn(),
  deleteCachedDocumentSearchIndexMock: vi.fn(),
}))

vi.mock('@/services/documentService', () => ({
  getDocumentSearchIndexApi: getDocumentSearchIndexApiMock,
  downloadDocumentSearchIndex: downloadDocumentSearchIndexMock,
}))

vi.mock('@/services/documentSearchCache', () => ({
  getCachedDocumentSearchIndex: getCachedDocumentSearchIndexMock,
  putCachedDocumentSearchIndex: putCachedDocumentSearchIndexMock,
  deleteCachedDocumentSearchIndex: deleteCachedDocumentSearchIndexMock,
}))

const artifact = {
  schemaVersion: 1,
  spaceId: 'space-1',
  version: 'version-1',
  generatedAt: '2026-07-14T00:00:00.000Z',
  entries: [{
    documentId: 'document-1',
    name: '学校のお知らせ.pdf',
    normalizedName: '学校のお知らせ.pdf',
    category: 'school_childcare',
    documentDate: null,
    pages: [{
      pageNumber: 2,
      text: '提出期限は 7月20日 です',
      normalizedText: '提出期限は 7月20日 です',
    }],
  }],
}

describe('document search store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useSpaceStore().$patch({
      currentSpaceId: 'space-1',
      initialized: true,
      useLegacyPath: false,
    })
    getDocumentSearchIndexApiMock.mockResolvedValue({
      version: 'version-1',
      url: 'https://storage.example/index.json.gz',
    })
    getCachedDocumentSearchIndexMock.mockResolvedValue(null)
    downloadDocumentSearchIndexMock.mockResolvedValue(artifact)
  })

  it('全角数字を正規化して一致ページを検索する', async () => {
    const store = useDocumentSearchStore()

    await store.search('提出期限 ７月２０日')

    expect(store.results).toEqual([expect.objectContaining({
      documentId: 'document-1',
      pageNumber: 2,
    })])
    expect(putCachedDocumentSearchIndexMock).toHaveBeenCalledWith(artifact)
  })

  it('同じversionの端末キャッシュを利用する', async () => {
    getCachedDocumentSearchIndexMock.mockResolvedValue(artifact)
    const store = useDocumentSearchStore()

    await store.search('学校')

    expect(downloadDocumentSearchIndexMock).not.toHaveBeenCalled()
    expect(store.results[0]).toEqual(expect.objectContaining({
      documentId: 'document-1',
      pageNumber: null,
    }))
  })

  it('アクセス権確認に失敗したspaceのキャッシュを削除する', async () => {
    getDocumentSearchIndexApiMock.mockRejectedValue(new Error('アクセス権がありません'))
    const store = useDocumentSearchStore()

    await store.search('学校')

    expect(deleteCachedDocumentSearchIndexMock).toHaveBeenCalledWith('space-1')
    expect(store.error).toBe('アクセス権がありません')
  })
})
