import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import DocumentsView from '@/views/DocumentsView.vue'

const subscribeMock = vi.fn()
const unsubscribeMock = vi.fn()
const addDocumentMock = vi.fn()
const selectDocumentMock = vi.fn()
const getAccessUrlMock = vi.fn()
const getDownloadUrlMock = vi.fn()
const getBulkDownloadManifestMock = vi.fn()
const getTextMock = vi.fn()
const retryTextMock = vi.fn()
const shareOrDownloadFileMock = vi.hoisted(() => vi.fn().mockResolvedValue('shared'))
const downloadDocumentArchivesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const routerPushMock = vi.fn()
const selectedDocument = ref<Record<string, unknown> | null>(null)
const documents = ref<Record<string, unknown>[]>([])
const spaceStoreMock = {
  currentSpaceId: 'space-1',
  memberships: [{ spaceId: 'space-1', displayName: '家族', role: 'owner' }],
  initSpace: vi.fn().mockResolvedValue(undefined),
  selectSpace: vi.fn(),
}

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPushMock }),
}))

vi.mock('@/components/documents/DocumentSearch.vue', () => ({
  default: { template: '<div data-testid="document-search" />' },
}))

vi.mock('@/utils/shareFile', () => ({
  shareOrDownloadFile: shareOrDownloadFileMock,
}))

vi.mock('@/utils/downloadDocumentArchives', () => ({
  downloadDocumentArchives: downloadDocumentArchivesMock,
}))

vi.mock('@/stores/space', () => ({
  useSpaceStore: () => spaceStoreMock,
}))

vi.mock('@/stores/documents', () => ({
  useDocumentsStore: () => ({
    get documents() { return documents.value },
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
    getDownloadUrl: getDownloadUrlMock,
    getBulkDownloadManifest: getBulkDownloadManifestMock,
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
    documents.value = []
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

    await wrapper.findAll('button').find((button) => button.text() === '書類・写真を追加')?.trigger('click')
    expect(wrapper.get('[data-testid="upload-destination-dialog"]').text()).toContain('書類の保存先')

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

  it('個人スペースの書類を維持し、表示先を利用者が選べる', async () => {
    spaceStoreMock.currentSpaceId = 'personal_user-1'
    spaceStoreMock.memberships = [
      { spaceId: 'personal_user-1', displayName: '個人', role: 'owner' },
      { spaceId: 'family-space', displayName: '家族', role: 'owner' },
    ]

    const wrapper = mount(DocumentsView)
    await flushPromises()

    expect(spaceStoreMock.selectSpace).not.toHaveBeenCalled()
    expect(subscribeMock).toHaveBeenCalled()

    await wrapper.get('select[aria-label="書類を表示するスペース"]').setValue('family-space')
    expect(spaceStoreMock.selectSpace).toHaveBeenCalledWith('family-space')
    wrapper.unmount()
  })

  it('直接追加する書類の保存先を個人または家族から選べる', async () => {
    spaceStoreMock.currentSpaceId = 'personal_user-1'
    spaceStoreMock.memberships = [
      { spaceId: 'personal_user-1', displayName: '個人', role: 'owner' },
      { spaceId: 'family-space', displayName: '家族共有', role: 'owner' },
    ]

    const wrapper = mount(DocumentsView)
    await flushPromises()
    const input = wrapper.get('[data-testid="document-input"]').element as HTMLInputElement
    const inputClick = vi.spyOn(input, 'click').mockImplementation(() => undefined)

    await wrapper.findAll('button').find((button) => button.text() === '書類・写真を追加')?.trigger('click')
    await wrapper.get('[data-testid="upload-destination-select"]').setValue('family-space')
    await wrapper.get('[data-testid="choose-upload-file"]').trigger('click')

    expect(spaceStoreMock.selectSpace).toHaveBeenCalledWith('family-space')
    expect(inputClick).toHaveBeenCalledOnce()
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

  it('書類詳細から添付済みのタスク追加画面へ移動する', async () => {
    getAccessUrlMock.mockResolvedValue({ url: 'https://example.com/document.pdf' })
    selectedDocument.value = {
      id: 'document-1',
      name: '学校のお知らせ.pdf',
      category: 'school_childcare',
      sizeBytes: 1024,
      mimeType: 'application/pdf',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'completed',
      ocrStatus: 'completed',
      ocrObjectKey: null,
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }
    const wrapper = mount(DocumentsView)
    await flushPromises()

    const createTaskButton = wrapper.findAll('button').find(
      (button) => button.text() === 'この書類からタスクを作成'
    )
    await createTaskButton?.trigger('click')

    expect(routerPushMock).toHaveBeenCalledWith({
      name: 'home',
      query: { attachDocument: 'document-1', createFromDocument: '1' },
    })
  })

  it('書類詳細から原本を共有・書き出しする', async () => {
    getAccessUrlMock.mockResolvedValue({ url: 'https://example.com/document.pdf' })
    getDownloadUrlMock.mockResolvedValue({
      url: 'https://example.com/download.pdf',
      name: '学校のお知らせ.pdf',
      mimeType: 'application/pdf',
    })
    selectedDocument.value = {
      id: 'document-1',
      name: '学校のお知らせ.pdf',
      category: 'school_childcare',
      sizeBytes: 1024,
      mimeType: 'application/pdf',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'completed',
      ocrStatus: 'completed',
      ocrObjectKey: null,
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }
    const wrapper = mount(DocumentsView)
    await flushPromises()

    const shareButton = wrapper.findAll('button').find(
      (button) => button.text() === '共有・書き出し'
    )
    await shareButton?.trigger('click')
    await flushPromises()

    expect(getDownloadUrlMock).toHaveBeenCalledWith('document-1')
    expect(shareOrDownloadFileMock).toHaveBeenCalledWith({
      url: 'https://example.com/download.pdf',
      name: '学校のお知らせ.pdf',
      mimeType: 'application/pdf',
    })
    expect(wrapper.text()).toContain('共有先へ書類を渡しました。')
  })

  it('ごみ箱以外の書類を一括ZIPダウンロードする', async () => {
    documents.value = [{
      id: 'document-1',
      name: '学校のお知らせ.pdf',
      category: 'school_childcare',
      sizeBytes: 3,
      mimeType: 'application/pdf',
      status: 'ready',
      previewStatus: 'completed',
      thumbnailObjectKey: null,
      createdAt: { toDate: () => new Date() },
    }]
    const manifest = {
      totalFiles: 1,
      totalBytes: 3,
      parts: [{ partNumber: 1, fileName: 'documents.zip', totalBytes: 3, entries: [] }],
    }
    getBulkDownloadManifestMock.mockResolvedValue(manifest)
    const wrapper = mount(DocumentsView)
    await flushPromises()

    const bulkButton = wrapper.findAll('button').find((button) => button.text() === '一括ZIP')
    await bulkButton?.trigger('click')
    await flushPromises()

    expect(getBulkDownloadManifestMock).toHaveBeenCalledOnce()
    expect(downloadDocumentArchivesMock).toHaveBeenCalledWith(manifest, expect.any(Function))
    expect(wrapper.text()).toContain('1件の書類をZIPでダウンロードしました。')
  })

})
