import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_UPLOAD_ACCEPT,
  isTextDocumentMimeType,
  resolveDocumentMimeType,
} from '@/utils/documentMimeTypes'

describe('documentMimeTypes', () => {
  it('拡張子がtxt、md、csvならブラウザのMIMEに依らずテキストMIMEへ揃える', () => {
    expect(resolveDocumentMimeType({ name: 'memo.md', type: '' })).toBe('text/markdown')
    expect(resolveDocumentMimeType({ name: 'MEMO.TXT', type: '' })).toBe('text/plain')
    expect(resolveDocumentMimeType({ name: 'data.csv', type: 'application/vnd.ms-excel' })).toBe('text/csv')
    expect(resolveDocumentMimeType({ name: 'notes.md', type: 'text/x-markdown' })).toBe('text/markdown')
  })

  it('テキスト以外はブラウザのMIMEを使い、空ならoctet-streamにする', () => {
    expect(resolveDocumentMimeType({ name: 'scan.jpeg', type: 'image/jpeg' })).toBe('image/jpeg')
    expect(resolveDocumentMimeType({ name: 'お知らせ.pdf', type: 'application/pdf' })).toBe('application/pdf')
    expect(resolveDocumentMimeType({ name: 'unknown.bin', type: '' })).toBe('application/octet-stream')
  })

  it('テキスト書類のMIMEを判定する', () => {
    expect(isTextDocumentMimeType('text/plain')).toBe(true)
    expect(isTextDocumentMimeType('text/markdown')).toBe(true)
    expect(isTextDocumentMimeType('text/csv')).toBe(true)
    expect(isTextDocumentMimeType('text/html')).toBe(false)
    expect(isTextDocumentMimeType('application/pdf')).toBe(false)
  })

  it('ファイル選択のaccept属性に画像、PDF、テキスト系を含める', () => {
    expect(DOCUMENT_UPLOAD_ACCEPT).toBe('image/*,application/pdf,.pdf,text/plain,.txt,text/markdown,.md,text/csv,.csv')
  })
})
