import sharp from 'sharp'
import { getDocumentProxy, renderPageAsImage } from 'unpdf'
import {
  DocumentOcrProvider,
  OcrPageInput,
  OcrPageResult,
  OcrResult,
} from '../providers/types'
import { ensurePdfJsConfigured, extractPdfText } from './pdfText'

export const OCR_IMAGE_MAX_EDGE_PIXELS = 2400
export const PDF_OCR_RENDER_WIDTH = 2000
export const OCR_JPEG_QUALITY = 90

const dynamicImport = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<unknown>

export interface DocumentTextResult extends OcrResult {
  pageCount: number
  externalOcrPageCount: number
}

export class DocumentTextPipelineError extends Error {
  constructor(
    public readonly failedPageNumber: number,
    public readonly completedPages: OcrPageResult[],
    public readonly originalError: unknown
  ) {
    super(`ページ${failedPageNumber}の文字読み取りに失敗しました`)
    this.name = 'DocumentTextPipelineError'
  }
}

async function normalizeOcrImage(image: Buffer): Promise<Buffer> {
  return sharp(image, { failOn: 'error' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({
      width: OCR_IMAGE_MAX_EDGE_PIXELS,
      height: OCR_IMAGE_MAX_EDGE_PIXELS,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: OCR_JPEG_QUALITY })
    .toBuffer()
}

async function extractExternalPage(
  provider: DocumentOcrProvider,
  input: OcrPageInput,
  completedPages: OcrPageResult[]
): Promise<OcrPageResult> {
  try {
    const page = await provider.extractPage(input)
    if (page.pageNumber !== input.pageNumber) {
      throw new Error('OCR結果のページ番号が要求と一致しません')
    }
    return page
  } catch (error) {
    throw new DocumentTextPipelineError(input.pageNumber, [...completedPages], error)
  }
}

async function extractPdfDocumentText(
  original: Buffer,
  provider: DocumentOcrProvider
): Promise<DocumentTextResult> {
  const extracted = await extractPdfText(original)
  const pages: OcrPageResult[] = []
  const ocrPages = extracted.pages.filter((page) => page.requiresOcr)
  if (ocrPages.length === 0) {
    return {
      pages: extracted.pages,
      pageCount: extracted.pageCount,
      externalOcrPageCount: 0,
      provider: 'pdf_text',
    }
  }

  await ensurePdfJsConfigured()
  const pdf = await getDocumentProxy(new Uint8Array(original))
  try {
    for (const page of extracted.pages) {
      if (!page.requiresOcr) {
        pages.push(page)
        continue
      }
      const rendered = await renderPageAsImage(pdf, page.pageNumber, {
        canvasImport: () => dynamicImport('@napi-rs/canvas') as Promise<
          typeof import('@napi-rs/canvas')
        >,
        width: PDF_OCR_RENDER_WIDTH,
      })
      const image = await normalizeOcrImage(Buffer.from(rendered))
      pages.push(await extractExternalPage(provider, {
        pageNumber: page.pageNumber,
        mimeType: 'image/jpeg',
        image,
        languageHints: [],
      }, pages))
    }
  } finally {
    await pdf.destroy()
  }

  return {
    pages,
    pageCount: extracted.pageCount,
    externalOcrPageCount: ocrPages.length,
    provider: pages.some((page) => page.source === 'pdf_text')
      ? 'hybrid'
      : 'cloud_vision',
  }
}

export async function extractDocumentText(
  original: Buffer,
  mimeType: string,
  provider: DocumentOcrProvider
): Promise<DocumentTextResult> {
  if (mimeType === 'application/pdf') {
    return extractPdfDocumentText(original, provider)
  }
  if (!mimeType.startsWith('image/')) {
    throw new Error('文字読み取り対象のファイル形式ではありません')
  }

  const image = await normalizeOcrImage(original)
  const page = await extractExternalPage(provider, {
    pageNumber: 1,
    mimeType: 'image/jpeg',
    image,
    languageHints: [],
  }, [])
  return {
    pages: [page],
    pageCount: 1,
    externalOcrPageCount: 1,
    provider: 'cloud_vision',
  }
}
