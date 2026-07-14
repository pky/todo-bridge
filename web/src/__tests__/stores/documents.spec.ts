import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentsStore } from '@/stores/documents'
import { useSpaceStore } from '@/stores/space'

const { onSnapshotMock, uploadDocumentMock, getDocumentAccessUrlApiMock } = vi.hoisted(() => ({
  onSnapshotMock: vi.fn(),
  uploadDocumentMock: vi.fn(),
  getDocumentAccessUrlApiMock: vi.fn(),
}))

vi.mock('firebase/firestore', () => ({
  collection: vi.fn((...segments: unknown[]) => segments),
  query: vi.fn((value: unknown) => value),
  orderBy: vi.fn(() => 'createdAt-desc'),
  onSnapshot: onSnapshotMock,
}))

vi.mock('@/services/firebase', () => ({ db: {} }))

vi.mock('@/services/documentService', () => ({
  uploadDocument: uploadDocumentMock,
  getDocumentAccessUrlApi: getDocumentAccessUrlApiMock,
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
    expect(onSnapshotMock).toHaveBeenLastCalledWith(
      [{}, 'spaces', 'space-2', 'documents'],
      expect.any(Function),
      expect.any(Function)
    )
  })
})
