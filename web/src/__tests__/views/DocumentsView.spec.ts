import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import DocumentsView from '@/views/DocumentsView.vue'

const subscribeMock = vi.fn()
const unsubscribeMock = vi.fn()
const addDocumentMock = vi.fn()
const selectDocumentMock = vi.fn()
const getAccessUrlMock = vi.fn()
const selectedDocument = ref(null)

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/stores/space', () => ({
  useSpaceStore: () => ({
    currentSpaceId: 'space-1',
    memberships: [{ spaceId: 'space-1', displayName: '家族' }],
    initSpace: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => ({
    documents: [],
    selectedDocumentId: null,
    selectedDocument,
    loading: false,
    uploading: false,
    uploadFileName: null,
    error: null,
    subscribe: subscribeMock,
    unsubscribe: unsubscribeMock,
    addDocument: addDocumentMock,
    selectDocument: selectDocumentMock,
    getAccessUrl: getAccessUrlMock,
  }),
}))

describe('DocumentsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectedDocument.value = null
  })

  it('撮影、写真、PDFを選べる追加入口を1つだけ表示する', async () => {
    const wrapper = mount(DocumentsView)
    await Promise.resolve()

    expect(wrapper.text()).toContain('まだ書類がありません')
    expect(wrapper.text()).toContain('書類・写真を追加')
    expect(wrapper.findAll('input[type="file"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="document-input"]').attributes('accept')).toBe('image/*,application/pdf,.pdf')
    expect(wrapper.get('[data-testid="document-input"]').attributes('capture')).toBeUndefined()
    expect(subscribeMock).toHaveBeenCalledOnce()

    wrapper.unmount()
    expect(unsubscribeMock).toHaveBeenCalledOnce()
  })
})
