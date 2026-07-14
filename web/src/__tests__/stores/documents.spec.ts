import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentsStore } from '@/stores/documents'
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
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((...segments: unknown[]) => segments),
  doc: vi.fn((...segments: unknown[]) => segments),
  query: vi.fn((value: unknown) => value),
  orderBy: vi.fn(() => 'createdAt-desc'),
  onSnapshot: onSnapshotMock,
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
})
