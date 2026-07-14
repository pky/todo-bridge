import { definePDFJSModule, extractText, getDocumentProxy } from 'unpdf'
import { OcrPageResult } from '../providers/types'

export const MIN_PDF_TEXT_CHARACTERS = 20
export const MAX_INVALID_CHARACTER_RATIO = 0.1

const dynamicImport = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<unknown>
let pdfJsConfiguration: Promise<void> | null = null

export interface ExtractedPdfPage extends OcrPageResult {
  searchableCharacterCount: number
  invalidCharacterRatio: number
  requiresOcr: boolean
}

export interface ExtractedPdfText {
  pageCount: number
  pages: ExtractedPdfPage[]
}

export async function ensurePdfJsConfigured(): Promise<void> {
  if (!pdfJsConfiguration) {
    pdfJsConfiguration = definePDFJSModule(
      () => dynamicImport('pdfjs-dist/legacy/build/pdf.mjs')
    )
  }
  await pdfJsConfiguration
}

function normalizePdfText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n +/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function assessPdfPageText(
  pageNumber: number,
  rawText: string
): ExtractedPdfPage {
  const text = normalizePdfText(rawText)
  const searchableCharacters = Array.from(text).filter((character) => !/\s/u.test(character))
  const invalidCharacters = searchableCharacters.filter((character) => character === '\uFFFD')
  const searchableCharacterCount = searchableCharacters.length
  const invalidCharacterRatio = searchableCharacterCount === 0
    ? 0
    : invalidCharacters.length / searchableCharacterCount

  return {
    pageNumber,
    text,
    confidence: null,
    source: 'pdf_text',
    searchableCharacterCount,
    invalidCharacterRatio,
    requiresOcr: searchableCharacterCount < MIN_PDF_TEXT_CHARACTERS
      || invalidCharacterRatio > MAX_INVALID_CHARACTER_RATIO,
  }
}

export async function extractPdfText(original: Buffer): Promise<ExtractedPdfText> {
  await ensurePdfJsConfigured()
  const pdf = await getDocumentProxy(new Uint8Array(original))
  try {
    const extracted = await extractText(pdf)
    return {
      pageCount: extracted.totalPages,
      pages: extracted.text.map((text, index) => assessPdfPageText(index + 1, text)),
    }
  } finally {
    await pdf.destroy()
  }
}
