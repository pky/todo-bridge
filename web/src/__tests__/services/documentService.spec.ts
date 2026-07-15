import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calculateFileSha256,
  createDocumentCalendarEventApi,
  reanalyzeDocumentSuggestionsApi,
  uploadDocument,
  uploadDocumentFile,
} from '@/services/documentService'

const callableMocks = vi.hoisted(() => ({
  httpsCallable: vi.fn(),
}))

vi.mock('firebase/functions', () => ({
  httpsCallable: callableMocks.httpsCallable,
}))

vi.mock('@/services/firebaseFunctions', () => ({
  functions: {},
}))

describe('documentService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callableMocks.httpsCallable.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ファイルのSHA-256を16進数で計算する', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    await expect(calculateFileSha256(file)).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })

  it('安全でないLAN接続でWeb Cryptoが使えない場合はハッシュを省略する', async () => {
    vi.stubGlobal('crypto', {})
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })

    await expect(calculateFileSha256(file)).resolves.toBeNull()
  })

  it('署名条件のヘッダーを付けて原本をアップロードする', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 })
    )
    const file = new File(['data'], 'test.pdf', { type: 'application/pdf' })

    await uploadDocumentFile({
      url: 'https://storage.example/upload',
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      expiresAt: new Date().toISOString(),
    }, file)

    expect(fetchMock).toHaveBeenCalledWith('https://storage.example/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: file,
    })
  })

  it('原本アップロードのHTTPエラーを通知する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
    const file = new File(['data'], 'test.pdf', { type: 'application/pdf' })

    await expect(uploadDocumentFile({
      url: 'https://storage.example/upload',
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      expiresAt: new Date().toISOString(),
    }, file)).rejects.toThrow('403')
  })

  it('書類の予定候補をCalendar登録Functionへ渡す', async () => {
    const registerCalendar = vi.fn().mockResolvedValue({
      data: { success: true, eventId: 'event-1', alreadyRegistered: false },
    })
    callableMocks.httpsCallable.mockReturnValue(registerCalendar)

    await expect(createDocumentCalendarEventApi(
      'space-1',
      'document-1',
      'suggestion-1'
    )).resolves.toEqual({
      success: true,
      eventId: 'event-1',
      alreadyRegistered: false,
    })
    expect(registerCalendar).toHaveBeenCalledWith({
      spaceId: 'space-1',
      documentId: 'document-1',
      suggestionId: 'suggestion-1',
    })
  })

  it('保存済みOCRからの候補再抽出をFunctionへ渡す', async () => {
    const reanalyze = vi.fn().mockResolvedValue({
      data: { success: true, suggestionCount: 1 },
    })
    callableMocks.httpsCallable.mockReturnValue(reanalyze)

    await expect(reanalyzeDocumentSuggestionsApi('space-1', 'document-1')).resolves.toEqual({
      success: true,
      suggestionCount: 1,
    })
    expect(callableMocks.httpsCallable).toHaveBeenCalledWith({}, 'reanalyzeDocumentSuggestions')
    expect(reanalyze).toHaveBeenCalledWith({ spaceId: 'space-1', documentId: 'document-1' })
  })

  it('選択ファイルを一度だけ読み込み同じデータをハッシュ計算と送信に使う', async () => {
    const createUpload = vi.fn().mockResolvedValue({
      data: {
        documentId: 'document-1',
        upload: {
          url: 'https://storage.example/upload',
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          expiresAt: new Date().toISOString(),
        },
      },
    })
    const completeUpload = vi.fn().mockResolvedValue({
      data: { documentId: 'document-1', status: 'uploaded' },
    })
    callableMocks.httpsCallable.mockImplementation((_functions, name) => (
      name === 'createDocumentUpload' ? createUpload : completeUpload
    ))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 })
    )
    const file = new File(['jpeg-data'], 'scan.jpeg', { type: 'image/jpeg' })
    const readFile = vi.spyOn(file, 'arrayBuffer')

    await expect(uploadDocument('space-1', file, 'file')).resolves.toBe('document-1')

    expect(readFile).toHaveBeenCalledOnce()
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body
    expect(requestBody).toBeInstanceOf(Blob)
    await expect((requestBody as Blob).text()).resolves.toBe('jpeg-data')
    expect(createUpload).toHaveBeenCalledWith(expect.objectContaining({
      name: 'scan.jpeg',
      mimeType: 'image/jpeg',
      sizeBytes: file.size,
      sha256: '4cd68a377f4b350468ba84edbfb23601e6c34c40ee06101987fd5a9f585b53d5',
    }))
    expect(completeUpload).toHaveBeenCalledWith({
      spaceId: 'space-1',
      documentId: 'document-1',
    })
  })
})
