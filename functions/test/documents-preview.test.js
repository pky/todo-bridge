const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')

const {
  createImageThumbnail,
  createPdfThumbnail,
  generateDocumentThumbnail,
  supportsDocumentThumbnail,
} = require('../lib/documents/preview')

async function createSourceImage() {
  return sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 40, g: 120, b: 200 },
    },
  }).png().toBuffer()
}

function createSourcePdf(pageCount = 1) {
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
  contentObjectIds.forEach((_, index) => {
    const content = `BT /F1 20 Tf 48 110 Td (TodoBridge page ${index + 1}) Tj ET`
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

function createMemoryProvider(initialObjects) {
  const objects = new Map(initialObjects)
  let writeCount = 0
  return {
    provider: {
      createUploadUrl: async () => { throw new Error('未使用') },
      createDownloadUrl: async () => { throw new Error('未使用') },
      stat: async (objectKey) => {
        const data = objects.get(objectKey)
        return data ? {
          objectKey,
          sizeBytes: data.length,
          contentType: null,
          etag: null,
          lastModifiedAt: null,
          metadata: {},
        } : null
      },
      readObject: async (objectKey) => objects.get(objectKey) ?? null,
      writeObject: async ({ objectKey, data }) => {
        writeCount += 1
        objects.set(objectKey, data)
      },
      deleteObjects: async () => {},
    },
    getWriteCount: () => writeCount,
  }
}

test('画像を長辺320px以下のWebPサムネイルへ変換する', async () => {
  const thumbnail = await createImageThumbnail(
    await createSourceImage(),
    'family_1',
    'document_1'
  )
  const metadata = await sharp(thumbnail.data).metadata()

  assert.equal(thumbnail.objectKey, 'spaces/family_1/documents/document_1/thumbnail/v1.webp')
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 320)
  assert.equal(metadata.height, 240)
})

test('同じversionのサムネイルを再生成しても派生物を重複作成しない', async () => {
  const originalObjectKey = 'spaces/family_1/documents/document_1/original/object_1'
  const memory = createMemoryProvider([[originalObjectKey, await createSourceImage()]])
  const document = {
    mimeType: 'image/png',
    originalObjectKey,
  }

  const first = await generateDocumentThumbnail(
    memory.provider,
    'family_1',
    'document_1',
    document
  )
  const second = await generateDocumentThumbnail(
    memory.provider,
    'family_1',
    'document_1',
    document
  )

  assert.equal(first.objectKey, second.objectKey)
  assert.equal(memory.getWriteCount(), 1)
})

test('PDFの先頭ページをWebPサムネイルへ変換する', async () => {
  const thumbnail = await createPdfThumbnail(
    createSourcePdf(2),
    'family_1',
    'document_1'
  )
  const metadata = await sharp(thumbnail.data).metadata()

  assert.equal(metadata.format, 'webp')
  assert.ok((metadata.width ?? 0) <= 320)
  assert.ok((metadata.height ?? 0) <= 320)
  assert.equal(thumbnail.pageCount, 2)
})

test('複数ページPDFでも一覧サムネイルだけを一度保存する', async () => {
  const originalObjectKey = 'spaces/family_1/documents/document_1/original/object_1'
  const memory = createMemoryProvider([[originalObjectKey, createSourcePdf(2)]])
  const document = {
    mimeType: 'application/pdf',
    originalObjectKey,
    pageCount: null,
  }

  const first = await generateDocumentThumbnail(
    memory.provider,
    'family_1',
    'document_1',
    document
  )
  const second = await generateDocumentThumbnail(
    memory.provider,
    'family_1',
    'document_1',
    document
  )

  assert.equal(first.pageCount, 2)
  assert.equal(second.objectKey, first.objectKey)
  assert.equal(memory.getWriteCount(), 1)
})

test('画像とPDFだけをサムネイル生成の対象にする', () => {
  assert.equal(supportsDocumentThumbnail('image/jpeg'), true)
  assert.equal(supportsDocumentThumbnail('application/pdf'), true)
  assert.equal(supportsDocumentThumbnail('text/plain'), false)
})
