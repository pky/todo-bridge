export const DOCUMENT_ARCHIVE_PART_LIMIT_BYTES = 200 * 1024 * 1024

export interface DocumentArchiveSource {
  documentId: string
  name: string
  mimeType: string
  sizeBytes: number
  category: string
  documentDate: string | null
}

export interface DocumentArchiveEntry extends DocumentArchiveSource {
  archiveName: string
}

export interface DocumentArchivePart {
  partNumber: number
  entries: DocumentArchiveEntry[]
  totalBytes: number
}

function removeControlCharacters(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  }).join('')
}

function safeArchiveName(name: string, documentId: string): string {
  const normalized = removeControlCharacters(name)
    .replace(/[\\/]/g, '_')
    .trim()
  return (normalized || `document-${documentId}`).slice(0, 240)
}

function addDuplicateSuffix(name: string, count: number): string {
  const extensionIndex = name.lastIndexOf('.')
  if (extensionIndex <= 0) return `${name} (${count})`
  return `${name.slice(0, extensionIndex)} (${count})${name.slice(extensionIndex)}`
}

export function buildDocumentArchiveParts(
  sources: DocumentArchiveSource[],
  partLimitBytes = DOCUMENT_ARCHIVE_PART_LIMIT_BYTES
): DocumentArchivePart[] {
  if (!Number.isSafeInteger(partLimitBytes) || partLimitBytes <= 0) {
    throw new Error('ZIP分割サイズが不正です')
  }
  const nameCounts = new Map<string, number>()
  const entries = sources.map((source) => {
    const baseName = safeArchiveName(source.name, source.documentId)
    const nextCount = (nameCounts.get(baseName) ?? 0) + 1
    nameCounts.set(baseName, nextCount)
    return {
      ...source,
      archiveName: nextCount === 1 ? baseName : addDuplicateSuffix(baseName, nextCount),
    }
  })
  const parts: DocumentArchivePart[] = []
  let currentEntries: DocumentArchiveEntry[] = []
  let currentBytes = 0
  entries.forEach((entry) => {
    if (currentEntries.length > 0 && currentBytes + entry.sizeBytes > partLimitBytes) {
      parts.push({
        partNumber: parts.length + 1,
        entries: currentEntries,
        totalBytes: currentBytes,
      })
      currentEntries = []
      currentBytes = 0
    }
    currentEntries.push(entry)
    currentBytes += entry.sizeBytes
  })
  if (currentEntries.length > 0) {
    parts.push({
      partNumber: parts.length + 1,
      entries: currentEntries,
      totalBytes: currentBytes,
    })
  }
  return parts
}
