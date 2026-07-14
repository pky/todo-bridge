const OBJECT_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function assertObjectKeySegment(value: string, fieldName: string): void {
  if (!OBJECT_KEY_SEGMENT_PATTERN.test(value)) {
    throw new Error(`${fieldName}がオブジェクトキーに使用できない形式です`)
  }
}

export function buildOriginalObjectKey(
  spaceId: string,
  documentId: string,
  objectId: string
): string {
  assertObjectKeySegment(spaceId, 'spaceId')
  assertObjectKeySegment(documentId, 'documentId')
  assertObjectKeySegment(objectId, 'objectId')
  return `spaces/${spaceId}/documents/${documentId}/original/${objectId}`
}

export function buildThumbnailObjectKey(
  spaceId: string,
  documentId: string,
  version: number
): string {
  assertObjectKeySegment(spaceId, 'spaceId')
  assertObjectKeySegment(documentId, 'documentId')
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error('versionがオブジェクトキーに使用できない形式です')
  }
  return `spaces/${spaceId}/documents/${documentId}/thumbnail/v${version}.webp`
}

export function buildOcrResultObjectKey(
  spaceId: string,
  documentId: string,
  version: number
): string {
  assertObjectKeySegment(spaceId, 'spaceId')
  assertObjectKeySegment(documentId, 'documentId')
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error('versionがオブジェクトキーに使用できない形式です')
  }
  return `spaces/${spaceId}/documents/${documentId}/analysis/v${version}/ocr.json.gz`
}

export function buildDocumentSearchIndexObjectKey(
  spaceId: string,
  version: string
): string {
  assertObjectKeySegment(spaceId, 'spaceId')
  if (!/^[a-f0-9]{24}$/.test(version)) {
    throw new Error('versionが検索インデックスに使用できない形式です')
  }
  return `spaces/${spaceId}/search/index-${version}.json.gz`
}

export function isObjectKeyInDocument(
  objectKey: string,
  spaceId: string,
  documentId: string
): boolean {
  try {
    assertObjectKeySegment(spaceId, 'spaceId')
    assertObjectKeySegment(documentId, 'documentId')
  } catch {
    return false
  }

  return objectKey.startsWith(`spaces/${spaceId}/documents/${documentId}/`)
}
