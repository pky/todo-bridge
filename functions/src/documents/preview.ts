import sharp from 'sharp'
import { definePDFJSModule, getDocumentProxy, renderPageAsImage } from 'unpdf'
import { buildThumbnailObjectKey, isObjectKeyInDocument } from './objectKeys'
import { ObjectStorageProvider } from './providers/types'
import { FamilyDocument } from './types'

export const DOCUMENT_PREVIEW_VERSION = 1
export const THUMBNAIL_MAX_EDGE_PIXELS = 320
export const THUMBNAIL_WEBP_QUALITY = 75
export const PDF_THUMBNAIL_RENDER_WIDTH = 960

const dynamicImport = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<unknown>
let pdfJsConfiguration: Promise<void> | null = null

export interface GeneratedThumbnail {
  objectKey: string
  data: Buffer
  width: number
  height: number
  pageCount: number
}

export function supportsDocumentThumbnail(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf'
}

async function ensurePdfJsConfigured(): Promise<void> {
  if (!pdfJsConfiguration) {
    pdfJsConfiguration = definePDFJSModule(
      () => dynamicImport('pdfjs-dist/legacy/build/pdf.mjs')
    )
  }
  await pdfJsConfiguration
}

export async function createImageThumbnail(
  original: Buffer,
  spaceId: string,
  documentId: string,
  version: number = DOCUMENT_PREVIEW_VERSION
): Promise<GeneratedThumbnail> {
  const { data, info } = await sharp(original, { failOn: 'error' })
    .rotate()
    .resize({
      width: THUMBNAIL_MAX_EDGE_PIXELS,
      height: THUMBNAIL_MAX_EDGE_PIXELS,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true })

  return {
    objectKey: buildThumbnailObjectKey(spaceId, documentId, version),
    data,
    width: info.width,
    height: info.height,
    pageCount: 1,
  }
}

export async function createPdfThumbnail(
  original: Buffer,
  spaceId: string,
  documentId: string,
  version: number = DOCUMENT_PREVIEW_VERSION
): Promise<GeneratedThumbnail> {
  await ensurePdfJsConfigured()
  const pdf = await getDocumentProxy(new Uint8Array(original))
  try {
    const rendered = await renderPageAsImage(pdf, 1, {
      canvasImport: () => dynamicImport('@napi-rs/canvas') as Promise<
        typeof import('@napi-rs/canvas')
      >,
      width: PDF_THUMBNAIL_RENDER_WIDTH,
    })
    const { data, info } = await sharp(Buffer.from(rendered))
      .resize({
        width: THUMBNAIL_MAX_EDGE_PIXELS,
        height: THUMBNAIL_MAX_EDGE_PIXELS,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: THUMBNAIL_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true })

    return {
      objectKey: buildThumbnailObjectKey(spaceId, documentId, version),
      data,
      width: info.width,
      height: info.height,
      pageCount: pdf.numPages,
    }
  } finally {
    await pdf.destroy()
  }
}

export async function generateDocumentThumbnail(
  provider: ObjectStorageProvider,
  spaceId: string,
  documentId: string,
  document: FamilyDocument
): Promise<GeneratedThumbnail> {
  if (!supportsDocumentThumbnail(document.mimeType)) {
    throw new Error('サムネイル生成対象の書類ではありません')
  }
  if (!isObjectKeyInDocument(document.originalObjectKey, spaceId, documentId)) {
    throw new Error('原本のオブジェクトキーが書類と一致しません')
  }

  const objectKey = buildThumbnailObjectKey(spaceId, documentId, DOCUMENT_PREVIEW_VERSION)
  const existing = await provider.readObject(objectKey)
  if (existing) {
    const metadata = await sharp(existing).metadata()
    const storedObject = await provider.stat(objectKey)
    const storedPageCount = Number(storedObject?.metadata.pagecount)
    return {
      objectKey,
      data: existing,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      pageCount: Number.isSafeInteger(storedPageCount) && storedPageCount > 0
        ? storedPageCount
        : (document.pageCount ?? 1),
    }
  }

  const original = await provider.readObject(document.originalObjectKey)
  if (!original) throw new Error('サムネイル生成用の原本が見つかりません')
  const thumbnail = document.mimeType === 'application/pdf'
    ? await createPdfThumbnail(original, spaceId, documentId)
    : await createImageThumbnail(original, spaceId, documentId)
  await provider.writeObject({
    objectKey: thumbnail.objectKey,
    contentType: 'image/webp',
    data: thumbnail.data,
    metadata: {
      previewversion: String(DOCUMENT_PREVIEW_VERSION),
      width: String(thumbnail.width),
      height: String(thumbnail.height),
      pagecount: String(thumbnail.pageCount),
    },
  })
  return thumbnail
}
