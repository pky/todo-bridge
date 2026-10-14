const TEXT_MIME_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
}

export const TEXT_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set(
  Object.values(TEXT_MIME_TYPES_BY_EXTENSION)
)

export const DOCUMENT_UPLOAD_ACCEPT =
  'image/*,application/pdf,.pdf,text/plain,.txt,text/markdown,.md,text/csv,.csv'

export function isTextDocumentMimeType(mimeType: string): boolean {
  return TEXT_DOCUMENT_MIME_TYPES.has(mimeType)
}

// ブラウザは .md を空MIMEや text/x-markdown で返すため、テキスト拡張子はサーバーと同じMIMEに揃える
export function resolveDocumentMimeType(file: Pick<File, 'name' | 'type'>): string {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (file.name.includes('.') && TEXT_MIME_TYPES_BY_EXTENSION[extension]) {
    return TEXT_MIME_TYPES_BY_EXTENSION[extension]
  }
  return file.type || 'application/octet-stream'
}
