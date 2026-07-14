import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentsStore } from '@/stores/documents'
import { useAuthStore } from '@/stores/auth'
import { useSpaceStore } from '@/stores/space'

const {
  onSnapshotMock,
  uploadDocumentMock,
  getDocumentAccessUrlApiMock,
  getDocumentThumbnailAccessUrlApiMock,
  getDocumentTextApiMock,
  retryDocumentTextApiMock,
  retryDocumentThumbnailApiMock,
  trashDocumentApiMock,
  restoreDocumentApiMock,
  permanentlyDeleteDocumentApiMock,
  updateDocMock,
  serverTimestampMock,
} = vi.hoisted(() => ({
  onSnapshotMock: vi.fn(),
  uploadDocumentMock: vi.fn(),
  getDocumentAccessUrlApiMock: vi.fn(),
  getDocumentThumbnailAccessUrlApiMock: vi.fn(),
  getDocumentTextApiMock: vi.fn(),
  retryDocumentTextApiMock: vi.fn(),
  retryDocumentThumbnailApiMock: vi.fn(),
  trashDocumentApiMock: vi.fn(),
  restoreDocumentApiMock: vi.fn(),
  permanentlyDeleteDocumentApiMock: vi.fn(),
  updateDocMock: vi.fn(),
  serverTimestampMock: vi.fn(() => 'server-timestamp'),
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((...segments: unknown[]) => segments),
  doc: vi.fn((...segments: unknown[]) => segments),
  query: vi.fn((value: unknown) => value),
  orderBy: vi.fn(() => 'createdAt-desc'),
  onSnapshot: onSnapshotMock,
  updateDoc: updateDocMock,
  serverTimestamp: serverTimestampMock,
}))

vi.mock('@/services/firebase', () => ({ db: {} }))

vi.mock('@/services/documentService', () => ({
  uploadDocument: uploadDocumentMock,
  getDocumentAccessUrlApi: getDocumentAccessUrlApiMock,
  getDocumentThumbnailAccessUrlApi: getDocumentThumbnailAccessUrlApiMock,
  getDocumentTextApi: getDocumentTextApiMock,
  retryDocumentTextApi: retryDocumentTextApiMock,
  retryDocumentThumbnailApi: retryDocumentThumbnailApiMock,
  trashDocumentApi: trashDocumentApiMock,
  restoreDocumentApi: restoreDocumentApiMock,
  permanentlyDeleteDocumentApi: permanentlyDeleteDocumentApiMock,
}))

describe('documents store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    useSpaceStore().$patch({
      currentSpaceId: 'space-1',
      initialized: true,
      useLegacyPath: false,
    })
    useAuthStore().$patch({
      user: { uid: 'alice', email: 'alice@example.com', displayName: 'Alice', photoURL: null },
      loading: false,
    })
    onSnapshotMock.mockReturnValue(vi.fn())
  })

  it('現在の家族スペースの書類を購読する', () => {
    useDocumentsStore().subscribe()

    expect(onSnapshotMock).toHaveBeenCalledWith(
      [{}, 'spaces', 'space-1', 'documents'],
      expect.any(Function),
      expect.any(Function)
    )
  })

  it('書類追加時に現在のspaceIdを固定する', async () => {
    uploadDocumentMock.mockResolvedValue('document-1')
    const store = useDocumentsStore()
    const file = new File(['data'], 'test.pdf', { type: 'application/pdf' })

    await store.addDocument(file, 'file')

    expect(uploadDocumentMock).toHaveBeenCalledWith('space-1', file, 'file')
    expect(store.selectedDocumentId).toBe('document-1')
    expect(store.uploading).toBe(false)
  })

  it('space切り替え時に以前の購読を解除する', () => {
    const firstUnsubscribe = vi.fn()
    onSnapshotMock
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(vi.fn())
    const store = useDocumentsStore()
    store.subscribe()
    useSpaceStore().$patch({ currentSpaceId: 'space-2' })
    store.subscribe()

    expect(firstUnsubscribe).toHaveBeenCalledOnce()
    expect(onSnapshotMock).toHaveBeenCalledWith(
      [{}, 'spaces', 'space-2', 'documents'],
      expect.any(Function),
      expect.any(Function)
    )
  })

  it('生成済みサムネイルだけの署名URLを取得する', async () => {
    let snapshotHandler: ((snapshot: { docs: unknown[] }) => void) | undefined
    onSnapshotMock.mockImplementation((target, next) => {
      if (Array.isArray(target) && !target.includes('usage')) snapshotHandler = next
      return vi.fn()
    })
    getDocumentThumbnailAccessUrlApiMock.mockResolvedValue({
      url: 'https://storage.example/thumbnail',
      expiresAt: new Date().toISOString(),
    })
    const store = useDocumentsStore()
    store.subscribe()

    snapshotHandler?.({
      docs: [{
        id: 'document-1',
        data: () => ({
          previewStatus: 'completed',
          thumbnailObjectKey: 'spaces/space-1/documents/document-1/thumbnail/v1.webp',
        }),
      }],
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(getDocumentThumbnailAccessUrlApiMock).toHaveBeenCalledWith('space-1', 'document-1')
    expect(store.thumbnailUrls['document-1']).toBe('https://storage.example/thumbnail')
  })

  it('書類のごみ箱移動、復元、完全削除を現在のspaceIdへ要求する', async () => {
    const store = useDocumentsStore()

    await store.moveToTrash('document-1')
    await store.restoreFromTrash('document-1')
    await store.permanentlyDelete('document-1')

    expect(trashDocumentApiMock).toHaveBeenCalledWith('space-1', 'document-1')
    expect(restoreDocumentApiMock).toHaveBeenCalledWith('space-1', 'document-1')
    expect(permanentlyDeleteDocumentApiMock).toHaveBeenCalledWith('space-1', 'document-1')
  })

  it('OCR本文取得と再読み取りを現在のspaceIdへ要求する', async () => {
    getDocumentTextApiMock.mockResolvedValue({ pages: [] })
    const store = useDocumentsStore()

    await store.getText('document-1')
    await store.retryText('document-1')

    expect(getDocumentTextApiMock).toHaveBeenCalledWith('space-1', 'document-1')
    expect(retryDocumentTextApiMock).toHaveBeenCalledWith('space-1', 'document-1')
  })

  it('抽出候補を購読し、修正値と採用者を保存する', async () => {
    onSnapshotMock.mockImplementation((target, next) => {
      if (Array.isArray(target) && target.includes('suggestions')) {
        next({
          docs: [{
            id: 'suggestion-1',
            data: () => ({
              type: 'calendar_event',
              status: 'pending',
              title: '予定：5月15日',
              value: { date: null, dateText: '5月15日', yearAmbiguous: true },
            }),
          }],
        })
      }
      return vi.fn()
    })
    const store = useDocumentsStore()
    store.subscribeSuggestions('document-1')

    await store.updateSuggestion('document-1', 'suggestion-1', {
      title: '茶話会',
      value: { date: '2026-05-15', yearAmbiguous: false },
      status: 'accepted',
    })

    expect(store.suggestions).toHaveLength(1)
    expect(updateDocMock).toHaveBeenCalledWith(
      [{}, 'spaces', 'space-1', 'documents', 'document-1', 'suggestions', 'suggestion-1'],
      {
        title: '茶話会',
        value: { date: '2026-05-15', yearAmbiguous: false },
        status: 'accepted',
        acceptedBy: 'alice',
        acceptedAt: 'server-timestamp',
        updatedAt: 'server-timestamp',
      }
    )
  })
})
