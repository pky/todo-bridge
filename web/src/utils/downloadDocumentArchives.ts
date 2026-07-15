import { downloadZip } from 'client-zip'
import type {
  DocumentBulkDownloadEntry,
  DocumentBulkDownloadManifest,
} from '@/services/documentService'

export interface DocumentArchiveProgress {
  completedFiles: number
  totalFiles: number
  currentPart: number
  totalParts: number
}

const categoryLabels: Record<string, string> = {
  school_childcare: '学校・保育',
  medical: '医療',
  insurance_tax: '保険・税',
  home_warranty: '住居・保証',
  billing_receipt: '請求・領収',
  contact: '連絡先',
  other: '未分類',
}

function escapeCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function buildManifestCsv(entries: DocumentBulkDownloadEntry[]): string {
  const rows = entries.map((entry) => [
    entry.archiveName,
    entry.name,
    categoryLabels[entry.category] ?? entry.category,
    entry.documentDate ?? '',
    String(entry.sizeBytes),
  ].map(escapeCsv).join(','))
  return `\uFEFF${[
    'ZIP内ファイル名,元の書類名,分類,書類日付,サイズ（バイト）',
    ...rows,
  ].join('\r\n')}`
}

function downloadBlob(blob: Blob, name: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = name
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

export async function downloadDocumentArchives(
  manifest: DocumentBulkDownloadManifest,
  onProgress: (progress: DocumentArchiveProgress) => void
): Promise<void> {
  let completedFiles = 0
  for (const part of manifest.parts) {
    const csv = buildManifestCsv(part.entries)
    async function* inputs() {
      yield { name: '書類一覧.csv', input: csv }
      for (const entry of part.entries) {
        const response = await fetch(entry.url, { cache: 'no-store' })
        if (!response.ok) throw new Error(`「${entry.name}」を取得できませんでした`)
        yield { name: entry.archiveName, input: response, size: entry.sizeBytes }
        completedFiles++
        onProgress({
          completedFiles,
          totalFiles: manifest.totalFiles,
          currentPart: part.partNumber,
          totalParts: manifest.parts.length,
        })
      }
    }
    const metadata = [
      { name: '書類一覧.csv', size: new TextEncoder().encode(csv).byteLength },
      ...part.entries.map((entry) => ({
        name: entry.archiveName,
        size: entry.sizeBytes,
      })),
    ]
    const blob = await downloadZip(inputs(), { metadata }).blob()
    downloadBlob(blob, part.fileName)
  }
}
