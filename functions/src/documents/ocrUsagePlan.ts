import {
  DOCUMENT_OCR_MONTHLY_PAGE_LIMIT,
  DOCUMENT_OCR_MONTHLY_WARNING_PAGES,
} from './ocrPolicy'

export interface OcrUsageSnapshot {
  processingPageCountThisMonth?: number
  processingPageMonth?: string | null
}

export interface OcrUsageReservation {
  processingPageCountThisMonth: number
  processingPageMonth: string
  warningReached: boolean
}

export function getOcrUsageMonth(date: Date): string {
  const japanTime = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  return japanTime.toISOString().slice(0, 7)
}

export function buildOcrUsageReservation(
  current: OcrUsageSnapshot | undefined,
  pageCount: number,
  month: string
): OcrUsageReservation {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
    throw new Error('OCRページ数が不正です')
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('OCR利用月が不正です')
  }
  const currentCount = current?.processingPageMonth === month
    ? current.processingPageCountThisMonth ?? 0
    : 0
  const nextCount = currentCount + pageCount
  if (nextCount > DOCUMENT_OCR_MONTHLY_PAGE_LIMIT) {
    throw new Error('外部OCRの月間1,000ページ上限に達しました')
  }
  return {
    processingPageCountThisMonth: nextCount,
    processingPageMonth: month,
    warningReached: nextCount >= DOCUMENT_OCR_MONTHLY_WARNING_PAGES,
  }
}

export function buildOcrReservationId(
  month: string,
  documentId: string,
  analysisVersion: number
): string {
  if (!/^\d{4}-\d{2}$/.test(month)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(documentId)
    || !Number.isSafeInteger(analysisVersion)
    || analysisVersion <= 0) {
    throw new Error('OCR利用予約キーが不正です')
  }
  return `${month.replace('-', '')}_${documentId}_v${analysisVersion}`
}
