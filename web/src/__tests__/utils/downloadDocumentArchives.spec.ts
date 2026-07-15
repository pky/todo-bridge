import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadDocumentArchives } from '@/utils/downloadDocumentArchives'

describe('書類の一括ZIPダウンロード', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('原本と一覧CSVをZIPにして進捗を通知する', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new Blob(['pdf'], { type: 'application/pdf' }),
      { status: 200, headers: { 'Content-Length': '3' } }
    )))
    const createObjectUrl = vi.fn().mockReturnValue('blob:archive')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const progress = vi.fn()

    await downloadDocumentArchives({
      totalFiles: 1,
      totalBytes: 3,
      parts: [{
        partNumber: 1,
        fileName: 'documents.zip',
        totalBytes: 3,
        entries: [{
          documentId: 'document-1',
          name: '学校のお知らせ.pdf',
          archiveName: '学校のお知らせ.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          category: 'school_childcare',
          documentDate: '2026-07-15',
          url: 'https://example.com/document',
        }],
      }],
    }, progress)

    expect(progress).toHaveBeenLastCalledWith({
      completedFiles: 1,
      totalFiles: 1,
      currentPart: 1,
      totalParts: 1,
    })
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalledOnce()
  })
})
