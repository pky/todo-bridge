import { describe, expectTypeOf, it } from 'vitest'
import type {
  CreateDocumentUploadInput,
  DocumentSuggestion,
  DocumentTaskLink,
  DocumentUsage,
  FamilyDocument,
} from '@/types'

describe('家族書類ボックス用型定義', () => {
  it('書類とOCR状態を公開している', () => {
    expectTypeOf<FamilyDocument>().toMatchTypeOf<{
      id: string
      spaceId: string
      status: 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed' | 'trashed'
      originalObjectKey: string
      uploadedBy: string
      ocrObjectKey: string | null
      ocrSizeBytes: number
      analysisVersion: number
    }>()
  })

  it('抽出候補とTask関連を公開している', () => {
    expectTypeOf<DocumentSuggestion>().toMatchTypeOf<{
      type: 'task' | 'calendar_event' | 'contact' | 'amount' | 'field'
      value: Record<string, unknown>
      generatedByVersion: number
    }>()

    expectTypeOf<DocumentTaskLink>().toMatchTypeOf<{
      documentId: string
      taskId: string
      relation: 'source' | 'attachment' | 'reference'
    }>()
  })

  it('容量集計とアップロード入力を公開している', () => {
    expectTypeOf<DocumentUsage>().toMatchTypeOf<{
      originalBytes: number
      derivedBytes: number
      limitBytes: number
      warningBytes: number
    }>()

    expectTypeOf<CreateDocumentUploadInput>().toMatchTypeOf<{
      spaceId: string
      name: string
      mimeType: string
      sizeBytes: number
    }>()
  })
})
