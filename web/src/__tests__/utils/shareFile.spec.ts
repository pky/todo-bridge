import { afterEach, describe, expect, it, vi } from 'vitest'
import { shareOrDownloadFile } from '@/utils/shareFile'

describe('書類の共有・書き出し', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ファイル共有に対応する端末では共有シートへ渡す', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new Blob(['pdf'], { type: 'application/pdf' }),
      { status: 200 }
    )))
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    })

    await expect(shareOrDownloadFile({
      url: 'https://example.com/document',
      name: '書類.pdf',
      mimeType: 'application/pdf',
    })).resolves.toBe('shared')

    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: '書類.pdf',
      files: [expect.any(File)],
    }))
  })

  it('ファイル共有に未対応ならダウンロードする', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new Blob(['pdf'], { type: 'application/pdf' }),
      { status: 200 }
    )))
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
    const createObjectUrl = vi.fn().mockReturnValue('blob:download')
    const revokeObjectUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    await expect(shareOrDownloadFile({
      url: 'https://example.com/document',
      name: '書類.pdf',
      mimeType: 'application/pdf',
    })).resolves.toBe('downloaded')

    expect(createObjectUrl).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
  })
})
