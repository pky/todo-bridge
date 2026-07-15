import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useDocumentTaskLinksStore } from '@/stores/documentTaskLinks'
import { useAuthStore } from '@/stores/auth'
import { useSpaceStore } from '@/stores/space'

const serviceMocks = vi.hoisted(() => ({
  subscribeTaskDocumentLinks: vi.fn(),
  linkDocumentToTaskApi: vi.fn(),
  unlinkDocumentFromTaskApi: vi.fn(),
}))

vi.mock('@/services/documentService', () => serviceMocks)

describe('DocumentTaskLinks Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    serviceMocks.subscribeTaskDocumentLinks.mockReturnValue(vi.fn())
    serviceMocks.linkDocumentToTaskApi.mockResolvedValue(undefined)
    serviceMocks.unlinkDocumentFromTaskApi.mockResolvedValue(undefined)
    useAuthStore().$patch({
      user: { uid: 'user-1', email: 'test@example.com', displayName: 'Test', photoURL: null },
    })
    useSpaceStore().$patch({ currentSpaceId: 'space-1', useLegacyPath: false })
  })

  it('選択中タスクの書類リンクを購読する', () => {
    const store = useDocumentTaskLinksStore()

    store.subscribe('task-1')

    expect(serviceMocks.subscribeTaskDocumentLinks).toHaveBeenCalledWith(
      'space-1',
      'task-1',
      expect.any(Function),
      expect.any(Function)
    )
  })

  it('1つのタスクへ複数書類を重複なく紐づける', async () => {
    const store = useDocumentTaskLinksStore()
    store.$patch({
      subscribedTaskId: 'task-1',
      links: [{ documentId: 'document-1' } as any],
    })

    await store.linkDocuments('task-1', ['document-1', 'document-2', 'document-3', 'document-3'])

    expect(serviceMocks.linkDocumentToTaskApi).toHaveBeenCalledTimes(2)
    expect(serviceMocks.linkDocumentToTaskApi).toHaveBeenCalledWith(
      'space-1', 'task-1', 'document-2'
    )
    expect(serviceMocks.linkDocumentToTaskApi).toHaveBeenCalledWith(
      'space-1', 'task-1', 'document-3'
    )
  })

  it('紐づけ解除では書類IDとタスクIDだけを渡す', async () => {
    const store = useDocumentTaskLinksStore()

    await store.unlinkDocument('task-1', 'document-1')

    expect(serviceMocks.unlinkDocumentFromTaskApi).toHaveBeenCalledWith(
      'space-1', 'task-1', 'document-1'
    )
  })
})
