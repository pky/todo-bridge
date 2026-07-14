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
