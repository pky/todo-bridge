import {
  FamilyDocumentSource,
  FamilyDocumentStatus,
} from './types'

export const MAX_DOCUMENT_FILE_SIZE_BYTES = 20 * 1024 * 1024
export const MAX_DOCUMENT_NAME_LENGTH = 255

const DOCUMENT_SOURCES: ReadonlySet<FamilyDocumentSource> = new Set([
  'camera',
  'photo',
  'file',
  'drive_import',
])

const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<FamilyDocumentStatus, readonly FamilyDocumentStatus[]>> = {
  uploading: ['uploaded', 'failed'],
  uploaded: ['processing', 'ready', 'failed', 'trashed'],
  processing: ['ready', 'failed', 'trashed'],
  ready: ['processing', 'trashed'],
  failed: ['uploading', 'processing', 'trashed'],
  trashed: ['uploaded', 'ready', 'failed'],
}

export interface DocumentUploadValidationResult {
  valid: boolean
  errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function canTransitionFamilyDocumentStatus(
  currentStatus: FamilyDocumentStatus,
  nextStatus: FamilyDocumentStatus
): boolean {
  return currentStatus === nextStatus
    || ALLOWED_STATUS_TRANSITIONS[currentStatus].includes(nextStatus)
}

export function assertFamilyDocumentStatusTransition(
  currentStatus: FamilyDocumentStatus,
  nextStatus: FamilyDocumentStatus
): void {
  if (!canTransitionFamilyDocumentStatus(currentStatus, nextStatus)) {
    throw new Error(`書類状態を ${currentStatus} から ${nextStatus} へ変更できません`)
  }
}

export function validateCreateDocumentUploadInput(
  input: unknown
): DocumentUploadValidationResult {
  if (!isRecord(input)) {
    return {
      valid: false,
      errors: ['アップロード入力が不正です'],
    }
  }

  const errors: string[] = []
  const spaceId = typeof input.spaceId === 'string' ? input.spaceId.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim() : ''

  if (!spaceId) {
    errors.push('spaceIdは必須です')
  }

  if (!name) {
    errors.push('ファイル名は必須です')
  } else if (name.length > MAX_DOCUMENT_NAME_LENGTH) {
    errors.push(`ファイル名は${MAX_DOCUMENT_NAME_LENGTH}文字以内で指定してください`)
  }

  if (typeof input.source !== 'string'
    || !DOCUMENT_SOURCES.has(input.source as FamilyDocumentSource)) {
    errors.push('追加元が不正です')
  }

  if (!mimeType || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) {
    errors.push('MIMEタイプが不正です')
  }

  if (typeof input.sizeBytes !== 'number'
    || !Number.isSafeInteger(input.sizeBytes)
    || input.sizeBytes <= 0) {
    errors.push('ファイルサイズは正の整数で指定してください')
  } else if (input.sizeBytes > MAX_DOCUMENT_FILE_SIZE_BYTES) {
    errors.push('ファイルサイズが20 MBの上限を超えています')
  }

  if (input.sha256 !== undefined
    && (typeof input.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(input.sha256))) {
    errors.push('SHA-256が不正です')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
