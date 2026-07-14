import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calculateFileSha256,
  uploadDocumentFile,
} from '@/services/documentService'

describe('documentService', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
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
})
