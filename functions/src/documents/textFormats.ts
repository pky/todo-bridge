export const TEXT_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
])
export const MAX_TEXT_DOCUMENT_FILE_SIZE_BYTES = 1024 * 1024

export function isTextDocumentMimeType(mimeType: string): boolean {
  return TEXT_DOCUMENT_MIME_TYPES.has(mimeType)
}

// 文字読み取り（PDF文字層、OCR、テキスト本文）の対象かどうか
export function supportsDocumentText(mimeType: string): boolean {
  return mimeType === 'application/pdf'
    || mimeType.startsWith('image/')
    || isTextDocumentMimeType(mimeType)
}
