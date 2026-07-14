const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { gunzip } = require('node:zlib')
const { promisify } = require('node:util')

const {
  MAX_INVALID_CHARACTER_RATIO,
  MIN_PDF_TEXT_CHARACTERS,
  assessPdfPageText,
  extractPdfText,
} = require('../lib/documents/ocr/pdfText')
const {
  DocumentTextPipelineError,
  OCR_IMAGE_MAX_EDGE_PIXELS,
  extractDocumentText,
} = require('../lib/documents/ocr/pipeline')
const {
  CLOUD_VISION_EU_ENDPOINT,
  CloudVisionOcrProvider,
} = require('../lib/documents/providers/cloudVisionOcr')
const {
  generatePdfTextArtifact,
} = require('../lib/documents/ocr/artifact')

const gunzipAsync = promisify(gunzip)

function createMemoryObjectProvider(initialObjects) {
  const objects = new Map(initialObjects.map(([objectKey, data, metadata = {}]) => [
    objectKey,
    { data, metadata },
  ]))
  let writeCount = 0
  return {
    provider: {
      createUploadUrl: async () => { throw new Error('未使用') },
      createDownloadUrl: async () => { throw new Error('未使用') },
      stat: async (objectKey) => {
        const object = objects.get(objectKey)
        return object ? {
          objectKey,
          sizeBytes: object.data.length,
          contentType: null,
          etag: null,
          lastModifiedAt: null,
          metadata: object.metadata,
        } : null
      },
      listObjects: async () => [],
      readObject: async (objectKey) => objects.get(objectKey)?.data ?? null,
      writeObject: async ({ objectKey, data, metadata = {} }) => {
        writeCount += 1
        objects.set(objectKey, { data, metadata })
      },
      deleteObjects: async () => {},
    },
    getWriteCount: () => writeCount,
  }
}

function createSourcePdf(pageTexts) {
  const pageCount = pageTexts.length
  const pageObjectIds = Array.from({ length: pageCount }, (_, index) => index + 3)
  const contentObjectIds = Array.from({ length: pageCount }, (_, index) => index + 3 + pageCount)
  const fontObjectId = 3 + pageCount * 2
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  ]
  pageObjectIds.forEach((_, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`)
  })
  pageTexts.forEach((text) => {
    const content = text === null ? '' : `BT /F1 12 Tf 24 110 Td (${text}) Tj ET`
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf)
}

test('文字層のあるPDFをページ単位で抽出する', async () => {
  const result = await extractPdfText(createSourcePdf([
    'Family schedule document page one',
    'School supplies document page two',
  ]))

  assert.equal(result.pageCount, 2)
  assert.deepEqual(result.pages.map((page) => page.pageNumber), [1, 2])
  assert.match(result.pages[0].text, /Family schedule/)
  assert.match(result.pages[1].text, /School supplies/)
  assert.deepEqual(result.pages.map((page) => page.requiresOcr), [false, false])
  assert.deepEqual(result.pages.map((page) => page.source), ['pdf_text', 'pdf_text'])
})

test('文字層のないページだけをOCR対象にする', async () => {
  const result = await extractPdfText(createSourcePdf([
    'This page contains enough searchable text',
    null,
  ]))

  assert.equal(result.pages[0].requiresOcr, false)
  assert.equal(result.pages[1].text, '')
  assert.equal(result.pages[1].searchableCharacterCount, 0)
  assert.equal(result.pages[1].requiresOcr, true)
})

test('短い文字層と文字化けの多い文字層をOCR対象にする', () => {
  const shortPage = assessPdfPageText(1, '締切 7/20')
  const invalidPage = assessPdfPageText(
    2,
    `${'読'.repeat(MIN_PDF_TEXT_CHARACTERS)}${'�'.repeat(3)}`
  )

  assert.equal(shortPage.requiresOcr, true)
  assert.ok(invalidPage.invalidCharacterRatio > MAX_INVALID_CHARACTER_RATIO)
  assert.equal(invalidPage.requiresOcr, true)
})

test('改行と空白を正規化して文字数を判定する', () => {
  const page = assessPdfPageText(1, '  family   document\r\n\r\n\r\n  schedule  ')

  assert.equal(page.text, 'family   document\n\nschedule')
  assert.equal(page.searchableCharacterCount, 22)
  assert.equal(page.requiresOcr, false)
})

test('文字層が十分なPDFは外部OCRを呼ばない', async () => {
  let requestCount = 0
  const provider = {
    extractPage: async () => {
      requestCount += 1
      throw new Error('呼ばれない想定です')
    },
  }

  const result = await extractDocumentText(createSourcePdf([
    'This PDF page already contains enough text',
  ]), 'application/pdf', provider)

  assert.equal(requestCount, 0)
  assert.equal(result.provider, 'pdf_text')
  assert.equal(result.externalOcrPageCount, 0)
})

test('文字層がないPDFページだけを画像化して外部OCRへ渡す', async () => {
  const inputs = []
  const provider = {
    extractPage: async (input) => {
      inputs.push(input)
      return {
        pageNumber: input.pageNumber,
        text: 'OCRで取得した2ページ目',
        confidence: 0.98,
        source: 'cloud_vision',
      }
    },
  }

  const result = await extractDocumentText(createSourcePdf([
    'This first page already contains enough text',
    null,
  ]), 'application/pdf', provider)

  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].pageNumber, 2)
  assert.equal(inputs[0].mimeType, 'image/jpeg')
  assert.equal((await sharp(inputs[0].image).metadata()).format, 'jpeg')
  assert.deepEqual(result.pages.map((page) => page.source), ['pdf_text', 'cloud_vision'])
  assert.equal(result.externalOcrPageCount, 1)
  assert.equal(result.provider, 'hybrid')
})

test('写真を向き補正・縮小して外部OCRへ渡す', async () => {
  let receivedInput
  const provider = {
    extractPage: async (input) => {
      receivedInput = input
      return {
        pageNumber: input.pageNumber,
        text: '写真から取得した文字',
        confidence: null,
        source: 'cloud_vision',
      }
    },
  }
  const source = await sharp({
    create: {
      width: 3000,
      height: 1000,
      channels: 3,
      background: '#ffffff',
    },
  }).png().toBuffer()

  const result = await extractDocumentText(source, 'image/png', provider)
  const metadata = await sharp(receivedInput.image).metadata()

  assert.equal(metadata.format, 'jpeg')
  assert.equal(metadata.width, OCR_IMAGE_MAX_EDGE_PIXELS)
  assert.equal(metadata.height, 800)
  assert.equal(result.pageCount, 1)
  assert.equal(result.externalOcrPageCount, 1)
})

test('途中ページの外部OCR失敗に完了済みページを保持する', async () => {
  const provider = {
    extractPage: async (input) => {
      if (input.pageNumber === 2) throw new Error('一時障害')
      return {
        pageNumber: input.pageNumber,
        text: '未使用',
        confidence: null,
        source: 'cloud_vision',
      }
    },
  }

  await assert.rejects(
    () => extractDocumentText(createSourcePdf([
      'This first page already contains enough text',
      null,
    ]), 'application/pdf', provider),
    (error) => {
      assert.ok(error instanceof DocumentTextPipelineError)
      assert.equal(error.failedPageNumber, 2)
      assert.equal(error.completedPages.length, 1)
      assert.equal(error.completedPages[0].source, 'pdf_text')
      return true
    }
  )
})

test('Cloud VisionへEUエンドポイント用の最小リクエストを渡す', async () => {
  let request
  const provider = new CloudVisionOcrProvider(async (input) => {
    request = input
    return {
      responses: [{
        fullTextAnnotation: {
          text: ' 読み取り結果\n',
          pages: [{ confidence: 0.9 }, { confidence: 0.8 }],
        },
      }],
    }
  })

  const result = await provider.extractPage({
    pageNumber: 3,
    mimeType: 'image/jpeg',
    image: Buffer.from('image'),
    languageHints: [],
  })

  assert.equal(CLOUD_VISION_EU_ENDPOINT, 'https://eu-vision.googleapis.com/v1/images:annotate')
  assert.equal(request.requests[0].image.content, Buffer.from('image').toString('base64'))
  assert.deepEqual(request.requests[0].features, [{ type: 'DOCUMENT_TEXT_DETECTION' }])
  assert.equal(request.requests[0].imageContext, undefined)
  assert.equal(result.text, '読み取り結果')
  assert.equal(result.confidence, 0.8500000000000001)
  assert.equal(result.source, 'cloud_vision')
})

test('Cloud Visionのエラー本文を上位へ露出しない', async () => {
  const provider = new CloudVisionOcrProvider(async () => ({
    responses: [{ error: { code: 7, message: '内部情報を含む可能性のある詳細' } }],
  }))

  await assert.rejects(
    () => provider.extractPage({
      pageNumber: 1,
      mimeType: 'image/jpeg',
      image: Buffer.from('image'),
      languageHints: ['ja'],
    }),
    /Cloud Visionの処理に失敗しました（7）/
  )
})

test('PDF文字層を圧縮成果物として保存する', async () => {
  const originalObjectKey = 'spaces/family_1/documents/document_1/original/object_1'
  const memory = createMemoryObjectProvider([[
    originalObjectKey,
    createSourcePdf(['This page contains enough searchable text', null]),
  ]])
  const result = await generatePdfTextArtifact(
    memory.provider,
    'family_1',
    'document_1',
    { mimeType: 'application/pdf', originalObjectKey, analysisVersion: 1 }
  )
  const storedJson = JSON.parse((await gunzipAsync(result.data)).toString('utf8'))

  assert.equal(result.objectKey, 'spaces/family_1/documents/document_1/analysis/v1/ocr.json.gz')
  assert.equal(result.reused, false)
  assert.equal(storedJson.pageCount, 2)
  assert.deepEqual(storedJson.pendingExternalOcrPageNumbers, [2])
  assert.equal(storedJson.pages[0].text.includes('searchable text'), true)
  assert.equal(memory.getWriteCount(), 1)
})

test('原本hashと解析versionが同じPDF成果物を再利用する', async () => {
  const originalObjectKey = 'spaces/family_1/documents/document_1/original/object_1'
  const memory = createMemoryObjectProvider([[
    originalObjectKey,
    createSourcePdf(['This page contains enough searchable text']),
  ]])
  const document = { mimeType: 'application/pdf', originalObjectKey, analysisVersion: 1 }

  const first = await generatePdfTextArtifact(
    memory.provider,
    'family_1',
    'document_1',
    document
  )
  const second = await generatePdfTextArtifact(
    memory.provider,
    'family_1',
    'document_1',
    document
  )

  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(memory.getWriteCount(), 1)
})
