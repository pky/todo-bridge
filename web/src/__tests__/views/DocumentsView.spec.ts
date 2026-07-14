import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import DocumentsView from '@/views/DocumentsView.vue'

const subscribeMock = vi.fn()
const unsubscribeMock = vi.fn()
const addDocumentMock = vi.fn()
const selectDocumentMock = vi.fn()
const getAccessUrlMock = vi.fn()
const getTextMock = vi.fn()
const retryTextMock = vi.fn()
const selectedDocument = ref<Record<string, unknown> | null>(null)

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/components/documents/DocumentSearch.vue', () => ({
  default: { template: '<div data-testid="document-search" />' },
}))

vi.mock('@/stores/space', () => ({
  useSpaceStore: () => ({
    currentSpaceId: 'space-1',
    memberships: [{ spaceId: 'space-1', displayName: '家族', role: 'owner' }],
    initSpace: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => ({
    documents: [],
    selectedDocumentId: null,
    get selectedDocument() { return selectedDocument.value },
    loading: false,
    uploading: false,
    uploadFileName: null,
    thumbnailUrls: {},
    thumbnailLoadingIds: [],
    error: null,
    usage: null,
    suggestions: [],
    suggestionsLoading: false,
    suggestionsError: null,
    suggestionSavingIds: [],
    subscribe: subscribeMock,
    unsubscribe: unsubscribeMock,
    addDocument: addDocumentMock,
    selectDocument: selectDocumentMock,
    getAccessUrl: getAccessUrlMock,
    getText: getTextMock,
    reloadThumbnail: vi.fn(),
    retryThumbnail: vi.fn(),
    retryText: retryTextMock,
    subscribeSuggestions: vi.fn(),
    updateSuggestion: vi.fn(),
    moveToTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    permanentlyDelete: vi.fn(),
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

  it('書類詳細にページ単位の読み取り文字を表示する', async () => {
    getAccessUrlMock.mockResolvedValue({ url: 'https://example.com/document.pdf' })
    getTextMock.mockResolvedValue({
      status: 'completed',
      provider: 'pdf_text',
      pageCount: 1,
      pendingExternalOcrPageNumbers: [],
      pages: [{
        pageNumber: 1,
        text: '提出期限は7月20日です',
        confidence: null,
        source: 'pdf_text',
      }],
    })
    selectedDocument.value = {
      id: 'document-1',
      name: '学校のお知らせ.pdf',
      category: 'school_childcare',
      sizeBytes: 1024,
      mimeType: 'application/pdf',
      status: 'uploaded',
      integrityStatus: 'ok',
      previewStatus: 'completed',
      ocrStatus: 'completed',
      ocrObjectKey: 'spaces/space-1/documents/document-1/analysis/v1/ocr.json.gz',
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }

    const wrapper = mount(DocumentsView)
    await Promise.resolve()
    await Promise.resolve()

    expect(getTextMock).toHaveBeenCalledWith('document-1')
    expect(wrapper.get('[data-testid="document-text-section"]').text()).toContain('提出期限は7月20日です')
    expect(wrapper.get('[data-testid="document-text-section"]').text()).toContain('PDF内の文字')
  })
})
