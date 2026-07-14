import {
  buildOcrResultObjectKey,
  buildThumbnailObjectKey,
  isObjectKeyInDocument,
} from './objectKeys'
import { supportsDocumentThumbnail } from './preview'
import { FamilyDocument } from './types'

export function buildDocumentDeletionObjectKeys(
  spaceId: string,
  documentId: string,
  document: Pick<
    FamilyDocument,
    | 'originalObjectKey'
    | 'thumbnailObjectKey'
    | 'previewVersion'
    | 'mimeType'
    | 'ocrObjectKey'
    | 'analysisVersion'
  >
): string[] {
  if (!isObjectKeyInDocument(document.originalObjectKey, spaceId, documentId)) {
    throw new Error('原本のオブジェクトキーが書類と一致しません')
  }
  const keys = [document.originalObjectKey]
  if (document.thumbnailObjectKey) {
    if (!isObjectKeyInDocument(document.thumbnailObjectKey, spaceId, documentId)) {
      throw new Error('サムネイルのオブジェクトキーが書類と一致しません')
    }
    keys.push(document.thumbnailObjectKey)
  } else if (supportsDocumentThumbnail(document.mimeType)) {
    keys.push(buildThumbnailObjectKey(spaceId, documentId, document.previewVersion))
  }
  const ocrObjectKey = document.ocrObjectKey
    ?? buildOcrResultObjectKey(spaceId, documentId, document.analysisVersion)
  if (!isObjectKeyInDocument(ocrObjectKey, spaceId, documentId)) {
    throw new Error('OCR成果物のオブジェクトキーが書類と一致しません')
  }
  keys.push(ocrObjectKey)
  return [...new Set(keys)]
}
