import { describe, it, expect, vi, beforeEach } from 'vitest'

// Firebase Firestore のモック
vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  getDocs: vi.fn(),
  writeBatch: vi.fn(() => ({
    delete: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
  })),
  doc: vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  db: {},
}))

describe('Import Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('clearAllUserData', () => {
    it('タスク、リスト、タグを全て削除する', async () => {
      const { getDocs, writeBatch, collection } = await import('firebase/firestore')

      // 各コレクションのドキュメントをモック
      const mockDocs = [
        { ref: { id: 'doc1' } },
        { ref: { id: 'doc2' } },
      ]
      vi.mocked(getDocs).mockResolvedValue({
        docs: mockDocs,
        empty: false,
      } as any)

      const mockBatch = {
        delete: vi.fn(),
        commit: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(writeBatch).mockReturnValue(mockBatch as any)

      const { clearAllUserData } = await import('@/services/importService')
      const result = await clearAllUserData('test-user-id')

      // collectionが3回呼ばれる（tasks, lists, tags）
      expect(collection).toHaveBeenCalledTimes(3)
      expect(result.success).toBe(true)
    })

    it('spaceId 指定時は spaces 配下を使ってエクスポートする', async () => {
      const { getDocs, collection } = await import('firebase/firestore')
      vi.mocked(getDocs).mockResolvedValue({
        docs: [],
        empty: true,
      } as any)

      const { exportUserData } = await import('@/services/importService')
      await exportUserData('test-user-id', { spaceId: 'personal_test-user-id', useLegacyPath: false })

      expect(collection).toHaveBeenCalledWith({}, 'spaces', 'personal_test-user-id', 'tasks')
      expect(collection).toHaveBeenCalledWith({}, 'spaces', 'personal_test-user-id', 'lists')
      expect(collection).toHaveBeenCalledWith({}, 'spaces', 'personal_test-user-id', 'tags')
    })

    it('spaceId 指定時は spaces 配下を削除対象にする', async () => {
      const { getDocs, collection, writeBatch } = await import('firebase/firestore')

      vi.mocked(getDocs).mockResolvedValue({
        docs: [],
        empty: true,
      } as any)

      const mockBatch = {
        delete: vi.fn(),
        commit: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(writeBatch).mockReturnValue(mockBatch as any)

      const { clearAllUserData } = await import('@/services/importService')
      await clearAllUserData('test-user-id', { spaceId: 'family-space', useLegacyPath: false })

      expect(collection).toHaveBeenCalledWith({}, 'spaces', 'family-space', 'tasks')
      expect(collection).toHaveBeenCalledWith({}, 'spaces', 'family-space', 'lists')
      expect(collection).toHaveBeenCalledWith({}, 'spaces', 'family-space', 'tags')
    })

    it('削除するデータがない場合も成功する', async () => {
      const { getDocs, writeBatch } = await import('firebase/firestore')

      vi.mocked(getDocs).mockResolvedValue({
        docs: [],
        empty: true,
      } as any)

      const mockBatch = {
        delete: vi.fn(),
        commit: vi.fn().mockResolvedValue(undefined),
      }
      vi.mocked(writeBatch).mockReturnValue(mockBatch as any)

      const { clearAllUserData } = await import('@/services/importService')
      const result = await clearAllUserData('test-user-id')

      expect(result.success).toBe(true)
      expect(result.tasksDeleted).toBe(0)
      expect(result.listsDeleted).toBe(0)
      expect(result.tagsDeleted).toBe(0)
    })

    it('エラー時はsuccessがfalseになる', async () => {
      const { getDocs } = await import('firebase/firestore')

      vi.mocked(getDocs).mockRejectedValue(new Error('削除エラー'))

      const { clearAllUserData } = await import('@/services/importService')
      const result = await clearAllUserData('test-user-id')

      expect(result.success).toBe(false)
      expect(result.error).toBe('削除エラー')
    })
  })
})
