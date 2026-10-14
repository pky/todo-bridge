const test = require('node:test')
const assert = require('node:assert/strict')
const { gunzip } = require('node:zlib')
const { promisify } = require('node:util')

const { decodeTextDocument } = require('../lib/documents/ocr/plainText')
const {
  decodeDocumentTextArtifact,
  generatePlainTextArtifact,
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

const originalObjectKey = 'spaces/family_1/documents/document_1/original/object_1'

test('UTF-8テキストのBOMを除き改行をLFに揃える', () => {
  const original = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# 持ち物\r\n- 水筒\r\n- 帽子', 'utf8'),
  ])

  assert.equal(decodeTextDocument(original), '# 持ち物\n- 水筒\n- 帽子')
})

test('UTF-8として読めないテキストはShift_JISとして読む', () => {
  // 「あい」の Shift_JIS 表現
  const original = Buffer.from([0x82, 0xa0, 0x82, 0xa2])

  assert.equal(decodeTextDocument(original), 'あい')
})

test('テキスト書類の本文を1ページの文字成果物として保存する', async () => {
  const memory = createMemoryObjectProvider([[
    originalObjectKey,
    Buffer.from('提出期限は7月20日です\n持ち物: 水筒', 'utf8'),
  ]])

  const result = await generatePlainTextArtifact(
    memory.provider,
    'family_1',
    'document_1',
    { mimeType: 'text/markdown', originalObjectKey, analysisVersion: 1 }
  )
  const storedJson = JSON.parse((await gunzipAsync(result.data)).toString('utf8'))

  assert.equal(result.objectKey, 'spaces/family_1/documents/document_1/analysis/v1/ocr.json.gz')
  assert.equal(result.reused, false)
  assert.equal(storedJson.provider, 'plain_text')
  assert.equal(storedJson.pageCount, 1)
  assert.deepEqual(storedJson.pendingExternalOcrPageNumbers, [])
  assert.equal(storedJson.pages.length, 1)
  assert.equal(storedJson.pages[0].pageNumber, 1)
  assert.equal(storedJson.pages[0].source, 'plain_text')
  assert.equal(storedJson.pages[0].confidence, null)
  assert.equal(storedJson.pages[0].text, '提出期限は7月20日です\n持ち物: 水筒')
  assert.equal(memory.getWriteCount(), 1)
})

test('テキスト成果物はsourceがplain_textでも復号できる', async () => {
  const memory = createMemoryObjectProvider([[
    originalObjectKey,
    Buffer.from('名前,金額\n給食費,4500', 'utf8'),
  ]])

  const result = await generatePlainTextArtifact(
    memory.provider,
    'family_1',
    'document_1',
    { mimeType: 'text/csv', originalObjectKey, analysisVersion: 1 }
  )
  const decoded = await decodeDocumentTextArtifact(result.data)

  assert.equal(decoded.pages[0].source, 'plain_text')
  assert.equal(decoded.pages[0].text.includes('給食費'), true)
})

test('原本hashと解析versionが同じテキスト成果物を再利用する', async () => {
  const memory = createMemoryObjectProvider([[
    originalObjectKey,
    Buffer.from('同じ内容', 'utf8'),
  ]])
  const document = { mimeType: 'text/plain', originalObjectKey, analysisVersion: 1 }

  const first = await generatePlainTextArtifact(memory.provider, 'family_1', 'document_1', document)
  const second = await generatePlainTextArtifact(memory.provider, 'family_1', 'document_1', document)

  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(memory.getWriteCount(), 1)
})

test('テキスト以外の書類ではテキスト成果物を生成しない', async () => {
  const memory = createMemoryObjectProvider([[originalObjectKey, Buffer.from('x')]])

  await assert.rejects(
    () => generatePlainTextArtifact(
      memory.provider,
      'family_1',
      'document_1',
      { mimeType: 'application/pdf', originalObjectKey, analysisVersion: 1 }
    ),
    /テキスト文字抽出対象の書類ではありません/
  )
  assert.equal(memory.getWriteCount(), 0)
})
