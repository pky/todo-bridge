import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
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
const spaceStoreMock = {
  currentSpaceId: 'space-1',
  memberships: [{ spaceId: 'space-1', displayName: '家族', role: 'owner' }],
  initSpace: vi.fn().mockResolvedValue(undefined),
  selectSpace: vi.fn(),
}

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/components/documents/DocumentSearch.vue', () => ({
  default: { template: '<div data-testid="document-search" />' },
}))

vi.mock('@/stores/space', () => ({
  useSpaceStore: () => spaceStoreMock,
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
    registerCalendarEvent: vi.fn(),
    reanalyzeSuggestions: vi.fn(),
    moveToTrash: vi.fn(),
    restoreFromTrash: vi.fn(),
    permanentlyDelete: vi.fn(),
  }),
}))

describe('DocumentsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectedDocument.value = null
    spaceStoreMock.currentSpaceId = 'space-1'
    spaceStoreMock.memberships = [{ spaceId: 'space-1', displayName: '家族', role: 'owner' }]
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

  it('アップロードが終わるまでiOSのファイル入力を保持する', async () => {
    let resolveUpload!: () => void
    addDocumentMock.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveUpload = resolve
    }))
    const wrapper = mount(DocumentsView)
    const inputWrapper = wrapper.get('[data-testid="document-input"]')
    const input = inputWrapper.element as HTMLInputElement
    const file = new File(['jpeg-data'], 'scan.jpeg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    Object.defineProperty(input, 'value', { configurable: true, writable: true, value: 'selected' })

    await inputWrapper.trigger('change')

    expect(addDocumentMock).toHaveBeenCalledWith(file, 'file')
    expect(input.value).toBe('selected')

    resolveUpload()
    await flushPromises()

    expect(input.value).toBe('')
    wrapper.unmount()
  })

  it('家族書類ボックスは個人スペースから家族スペースへ切り替える', async () => {
    spaceStoreMock.currentSpaceId = 'personal_user-1'
    spaceStoreMock.memberships = [
      { spaceId: 'personal_user-1', displayName: '個人', role: 'owner' },
      { spaceId: 'family-space', displayName: '家族', role: 'owner' },
    ]

    const wrapper = mount(DocumentsView)
    await flushPromises()

    expect(spaceStoreMock.selectSpace).toHaveBeenCalledWith('family-space')
    expect(subscribeMock).toHaveBeenCalled()
    wrapper.unmount()
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
