// 期待する公開API: utils/safeUrl.ts の isSafeExternalUrl(url: string, options?: { allowFtp?: boolean }): boolean。
import { describe, expect, it } from 'vitest'
import { isSafeExternalUrl } from '@/utils/safeUrl'

describe('安全な外部URLの判定', () => {
  for (const protocol of ['http', 'https', 'ftp']) {
    it(`タスクでは${protocol}の絶対URLを許可する`, () => {
      expect(isSafeExternalUrl(`${protocol}://example.com/path`, { allowFtp: true })).toBe(true)
    })
  }

  for (const protocol of ['http', 'https']) {
    it(`記事では${protocol}の絶対URLを許可する`, () => {
      expect(isSafeExternalUrl(`${protocol}://example.com/path`, { allowFtp: false })).toBe(true)
    })
  }

  it('記事ではFTPを許可しない', () => {
    expect(isSafeExternalUrl('ftp://example.com/file', { allowFtp: false })).toBe(false)
  })

  for (const url of [
    'javascript:alert(1)', 'data:text/html,test', 'vbscript:msgbox(1)',
    '/relative', 'relative', '//example.com/path', '', ' ',
    ' https://example.com/path', 'https://example.com/path ',
    'https://example.com/a b', 'https://example.com/a\tb',
    'https://example.com/a\nb', 'https://',
  ]) {
    it(`危険または不正なURLを拒否する: ${JSON.stringify(url)}`, () => {
      expect(isSafeExternalUrl(url, { allowFtp: true })).toBe(false)
      expect(isSafeExternalUrl(url, { allowFtp: false })).toBe(false)
    })
  }
})
