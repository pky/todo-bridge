import sharp from 'sharp'
import { definePDFJSModule, getDocumentProxy, renderPageAsImage } from 'unpdf'
import { buildThumbnailObjectKey, isObjectKeyInDocument } from './objectKeys'
import { ObjectStorageProvider } from './providers/types'
import { FamilyDocument } from './types'

export const DOCUMENT_PREVIEW_VERSION = 1
export const THUMBNAIL_MAX_EDGE_PIXELS = 320
export const THUMBNAIL_WEBP_QUALITY = 75
export const PDF_THUMBNAIL_RENDER_WIDTH = 960

export function getSafePdfRenderWidth(
  pageWidth: number,
  pageHeight: number,
  requestedWidth: number
): number {
  if (![pageWidth, pageHeight, requestedWidth].every(Number.isFinite)
    || pageWidth <= 0 || pageHeight <= 0 || requestedWidth < 1) {
    throw new Error('PDFページの寸法が不正です')
  }
  return Math.max(1, Math.floor(Math.min(
    requestedWidth,
    requestedWidth * Math.sqrt(2 * (pageWidth / pageHeight))
  )))
}

export function assertSafePdfRenderArea(width: number, height: number, requestedWidth: number): void {
  const maxArea = 2 * requestedWidth ** 2
  // canvasは小数を切り捨てるため、各辺を切り上げず実数面積で判定する。
  // viewportの倍率計算と面積の乗算による浮動小数点誤差だけを許容する。
  const roundingTolerance = maxArea * Number.EPSILON * 4
  // 最小幅1でも面積上限を満たせないページは、canvas確保前に拒否する。
  if (![width, height].every(Number.isFinite) || width < 1 || height < 1
    || width * height > maxArea + roundingTolerance) {
    throw new Error('PDFページが描画面積の上限を超えています')
  }
}

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
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const width = getSafePdfRenderWidth(viewport.width, viewport.height, PDF_THUMBNAIL_RENDER_WIDTH)
    const renderedViewport = page.getViewport({ scale: width / viewport.width })
    assertSafePdfRenderArea(renderedViewport.width, renderedViewport.height, PDF_THUMBNAIL_RENDER_WIDTH)
    const rendered = await renderPageAsImage(pdf, 1, {
      canvasImport: () => dynamicImport('@napi-rs/canvas') as Promise<
        typeof import('@napi-rs/canvas')
      >,
      width,
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
