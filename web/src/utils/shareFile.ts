export type FileExportResult = 'shared' | 'downloaded'

export interface ShareFileInput {
  url: string
  name: string
  mimeType: string
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

export async function shareOrDownloadFile(input: ShareFileInput): Promise<FileExportResult> {
  const response = await fetch(input.url, { cache: 'no-store' })
  if (!response.ok) throw new Error('書類を取得できませんでした')
  const blob = await response.blob()
  const file = new File([blob], input.name, {
    type: input.mimeType || blob.type || 'application/octet-stream',
  })
  const shareData: ShareData = { files: [file], title: input.name }
  if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
    await navigator.share(shareData)
    return 'shared'
  }
  downloadBlob(blob, input.name)
  return 'downloaded'
}
