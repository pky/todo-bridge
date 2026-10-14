import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import DocumentsView from '@/views/DocumentsView.vue'

const subscribeMock = vi.fn()
const unsubscribeMock = vi.fn()
const addDocumentMock = vi.fn()
const selectDocumentMock = vi.fn()
const getAccessUrlMock = vi.fn()
const getDownloadUrlMock = vi.fn()
const getBulkDownloadManifestMock = vi.fn()
const getTextMock = vi.fn()
const moveToTrashMock = vi.fn()
const retryTextMock = vi.fn()
const shareOrDownloadFileMock = vi.hoisted(() => vi.fn().mockResolvedValue('shared'))
const downloadDocumentArchivesMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const routerPushMock = vi.fn()
const routerReplaceMock = vi.fn()
const selectedDocument = ref<Record<string, unknown> | null>(null)
const documents = ref<Record<string, unknown>[]>([])
const documentsLoading = ref(false)
const spaceStoreMock = {
  currentSpaceId: 'space-1',
  memberships: [{ spaceId: 'space-1', displayName: '家族', role: 'owner' }],
  initSpace: vi.fn().mockResolvedValue(undefined),
  selectSpace: vi.fn(),
}

const routeMock = reactive({ query: {} as Record<string, string> })

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPushMock, replace: routerReplaceMock }),
  useRoute: () => routeMock,
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
    get loading() { return documentsLoading.value },
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
    moveToTrash: moveToTrashMock,
    restoreFromTrash: vi.fn(),
    permanentlyDelete: vi.fn(),
  }),
}))

describe('DocumentsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectedDocument.value = null
    documents.value = []
    documentsLoading.value = false
    routeMock.query = {}
    spaceStoreMock.currentSpaceId = 'space-1'
    spaceStoreMock.memberships = [{ spaceId: 'space-1', displayName: '家族', role: 'owner' }]
  })

  it('撮影、写真、PDFを選べる追加入口を1つだけ表示する', async () => {
    const wrapper = mount(DocumentsView)
    await Promise.resolve()

    expect(wrapper.text()).toContain('まだ書類がありません')
    expect(wrapper.text()).toContain('書類・写真を追加')
    expect(wrapper.findAll('input[type="file"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="document-input"]').attributes('accept')).toBe('image/*,application/pdf,.pdf,text/plain,.txt,text/markdown,.md,text/csv,.csv')
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

  it('テキスト書類は原本の本文をブラウザ内に表示する', async () => {
    getAccessUrlMock.mockResolvedValue({ url: 'https://example.com/memo.md' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('# 持ち物\n- 水筒', { status: 200, headers: { 'Content-Type': 'text/markdown' } })
    )
    getTextMock.mockResolvedValue({
      status: 'completed',
      provider: 'plain_text',
      pageCount: 1,
      pendingExternalOcrPageNumbers: [],
      pages: [{
        pageNumber: 1,
        text: '# 持ち物\n- 水筒',
        confidence: null,
        source: 'plain_text',
      }],
    })
    selectedDocument.value = {
      id: 'document-2',
      name: '持ち物メモ.md',
      category: 'school_childcare',
      sizeBytes: 32,
      mimeType: 'text/markdown',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'skipped',
      ocrStatus: 'completed',
      ocrObjectKey: 'spaces/space-1/documents/document-2/analysis/v1/ocr.json.gz',
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }

    const wrapper = mount(DocumentsView)
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/memo.md')
    expect(wrapper.get('[data-testid="document-text-preview"]').text()).toContain('- 水筒')
    expect(wrapper.text()).not.toContain('この形式はブラウザ内プレビューに対応していません')
    // 本文はプレビューで見えるため、読み取った文字欄は出さず文字成果物も取得しない
    expect(wrapper.find('[data-testid="document-text-section"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('読み取った文字')
    expect(getTextMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  it('Shift_JISのテキスト書類もプレビューで文字化けさせない', async () => {
    getAccessUrlMock.mockResolvedValue({ url: 'https://example.com/memo.txt' })
    // 「あい」の Shift_JIS 表現
    const shiftJisBody = new Uint8Array([0x82, 0xa0, 0x82, 0xa2])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(shiftJisBody, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    )
    getTextMock.mockResolvedValue({
      status: 'completed',
      provider: 'plain_text',
      pageCount: 1,
      pendingExternalOcrPageNumbers: [],
      pages: [{ pageNumber: 1, text: 'あい', confidence: null, source: 'plain_text' }],
    })
    selectedDocument.value = {
      id: 'document-3',
      name: 'メモ.txt',
      category: 'other',
      sizeBytes: 4,
      mimeType: 'text/plain',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'skipped',
      ocrStatus: 'completed',
      ocrObjectKey: 'spaces/space-1/documents/document-3/analysis/v1/ocr.json.gz',
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }

    const wrapper = mount(DocumentsView)
    await flushPromises()

    expect(wrapper.get('[data-testid="document-text-preview"]').text()).toBe('あい')
    fetchMock.mockRestore()
  })

  it('URLクエリで指定された書類を一覧の受信後に選択する', async () => {
    routeMock.query = { document: 'document-2' }

    const wrapper = mount(DocumentsView)
    await flushPromises()
    expect(selectDocumentMock).not.toHaveBeenCalled()

    documents.value = [{
      id: 'document-2',
      name: '持ち物メモ.md',
      category: 'other',
      sizeBytes: 32,
      mimeType: 'text/markdown',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'skipped',
      ocrStatus: 'completed',
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }]
    await flushPromises()

    expect(selectDocumentMock).toHaveBeenCalledWith('document-2')
    expect(selectDocumentMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('前画面の一覧が残っていても、再購読後に受信した一覧からクエリの書類を選択する', async () => {
    routeMock.query = { document: 'document-2' }
    const textDocument = {
      id: 'document-2',
      name: '持ち物メモ.md',
      category: 'other',
      sizeBytes: 32,
      mimeType: 'text/markdown',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'skipped',
      ocrStatus: 'completed',
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }
    // ホーム画面の購読が残っている状態で遷移してくる
    documents.value = [textDocument]
    // 書類画面の購読開始で一覧がリセットされ、読み込み中になる
    subscribeMock.mockImplementationOnce(() => {
      documents.value = []
      documentsLoading.value = true
    })

    const wrapper = mount(DocumentsView)
    await flushPromises()
    expect(selectDocumentMock).not.toHaveBeenCalled()

    documents.value = [textDocument]
    documentsLoading.value = false
    await flushPromises()

    expect(selectDocumentMock).toHaveBeenCalledTimes(1)
    expect(selectDocumentMock).toHaveBeenCalledWith('document-2')
    wrapper.unmount()
  })

  it('テキスト書類のプレビューでは原本を開くリンクを表示しない', async () => {
    getAccessUrlMock.mockResolvedValue({ url: 'https://example.com/memo.md' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('# 持ち物', { status: 200, headers: { 'Content-Type': 'text/markdown' } })
    )
    getTextMock.mockResolvedValue({
      status: 'completed',
      provider: 'plain_text',
      pageCount: 1,
      pendingExternalOcrPageNumbers: [],
      pages: [{ pageNumber: 1, text: '# 持ち物', confidence: null, source: 'plain_text' }],
    })
    selectedDocument.value = {
      id: 'document-2',
      name: '持ち物メモ.md',
      category: 'other',
      sizeBytes: 32,
      mimeType: 'text/markdown',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'skipped',
      ocrStatus: 'completed',
      ocrObjectKey: 'spaces/space-1/documents/document-2/analysis/v1/ocr.json.gz',
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }

    const wrapper = mount(DocumentsView)
    await flushPromises()

    expect(wrapper.get('[data-testid="document-text-preview"]').text()).toContain('持ち物')
    expect(wrapper.text()).not.toContain('原本を開く')
    fetchMock.mockRestore()
  })

  it('ごみ箱へ移動したら詳細の選択を解除する', async () => {
    moveToTrashMock.mockResolvedValue(undefined)
    getAccessUrlMock.mockResolvedValue({ url: 'https://example.com/notice.pdf' })
    selectedDocument.value = {
      id: 'document-1',
      name: 'お知らせ.pdf',
      category: 'other',
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
    await wrapper.findAll('button').find((button) => button.text() === 'ごみ箱へ移動')?.trigger('click')
    await flushPromises()

    expect(moveToTrashMock).toHaveBeenCalledWith('document-1')
    expect(selectDocumentMock).toHaveBeenCalledWith(null)
  })

  it('URLクエリで書類を選択したらクエリをURLから消す', async () => {
    routeMock.query = { document: 'document-2' }
    documents.value = [{
      id: 'document-2',
      name: '持ち物メモ.md',
      category: 'other',
      sizeBytes: 32,
      mimeType: 'text/markdown',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'skipped',
      ocrStatus: 'completed',
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }]

    const wrapper = mount(DocumentsView)
    await flushPromises()

    expect(selectDocumentMock).toHaveBeenCalledWith('document-2')
    expect(routerReplaceMock).toHaveBeenCalledWith({ name: 'documents' })
    wrapper.unmount()
  })

  it('URLクエリの書類がごみ箱にあればごみ箱タブに切り替えて選択する', async () => {
    routeMock.query = { document: 'document-9' }
    documents.value = [
      {
        id: 'document-1',
        name: '通常の書類.pdf',
        category: 'other',
        sizeBytes: 1024,
        mimeType: 'application/pdf',
        status: 'ready',
        integrityStatus: 'ok',
        previewStatus: 'completed',
        ocrStatus: 'completed',
        pageCount: 1,
        createdAt: { toDate: () => new Date() },
      },
      {
        id: 'document-9',
        name: '古いメモ.md',
        category: 'other',
        sizeBytes: 32,
        mimeType: 'text/markdown',
        status: 'trashed',
        integrityStatus: 'ok',
        previewStatus: 'skipped',
        ocrStatus: 'completed',
        pageCount: 1,
        createdAt: { toDate: () => new Date() },
      },
    ]

    const wrapper = mount(DocumentsView)
    await flushPromises()

    expect(selectDocumentMock).toHaveBeenCalledWith('document-9')
    const listNames = wrapper.findAll('[data-testid="document-list-name"]').map((node) => node.text())
    expect(listNames).toEqual(['古いメモ.md'])
    wrapper.unmount()
  })

  it('長いファイル名でもモバイル詳細の閉じるボタンを縮めない', async () => {
    getAccessUrlMock.mockResolvedValue({ url: 'https://example.com/document.pdf' })
    selectedDocument.value = {
      id: 'document-1',
      name: `${'とても長いファイル名'.repeat(20)}.pdf`,
      category: 'other',
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

    expect(wrapper.get('[data-testid="document-detail-name"]').classes()).toContain('flex-1')
    expect(wrapper.get('[data-testid="document-detail-close"]').classes()).toContain('shrink-0')
  })

  it('URLエンコードされた長いファイル名でも一覧を画面幅に収める', async () => {
    documents.value = [{
      id: 'document-1',
      name: `${'%E6%81%B5%E6%AF%94%E5%AF%BF'.repeat(20)}.pdf`,
      category: 'other',
      sizeBytes: 1024,
      mimeType: 'application/pdf',
      status: 'ready',
      integrityStatus: 'ok',
      previewStatus: 'completed',
      ocrStatus: 'completed',
      ocrObjectKey: null,
      pageCount: 1,
      createdAt: { toDate: () => new Date() },
    }]

    const wrapper = mount(DocumentsView)
    await flushPromises()

    expect(wrapper.get('[data-testid="documents-list-panel"]').classes()).toContain('min-w-0')
    expect(wrapper.get('[data-testid="document-list-name"]').classes()).toContain('truncate')
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
