const test = require('node:test')
const assert = require('node:assert/strict')
const { gunzip } = require('node:zlib')
const { promisify } = require('node:util')
const { writeDocumentTextArtifact } = require('../lib/documents/ocr/artifact')
const {
  buildDocumentSearchIndex,
  normalizeDocumentSearchText,
} = require('../lib/documents/searchIndex')

const gunzipAsync = promisify(gunzip)

function createMemoryProvider() {
  const objects = new Map()
  return {
    createUploadUrl: async () => { throw new Error('未使用') },
    createDownloadUrl: async () => { throw new Error('未使用') },
    stat: async () => null,
    listObjects: async () => [],
    readObject: async (objectKey) => objects.get(objectKey) ?? null,
    writeObject: async ({ objectKey, data }) => objects.set(objectKey, data),
    deleteObjects: async () => {},
  }
}

test('書類名とページ本文を正規化した圧縮検索インデックスを生成する', async () => {
  const provider = createMemoryProvider()
  const generatedText = await writeDocumentTextArtifact(
    provider,
    'space-1',
    'document-1',
    1,
    Buffer.from('original'),
    {
      provider: 'pdf_text',
      pageCount: 1,
      pages: [{
        pageNumber: 1,
        text: '提出期限は ７月２０日 です',
        confidence: null,
        source: 'pdf_text',
      }],
    }
  )
  const result = await buildDocumentSearchIndex(provider, 'space-1', [{
    id: 'document-1',
    name: '学校の お知らせ.PDF',
    category: 'school_childcare',
    status: 'uploaded',
    documentDate: null,
    analysisVersion: 1,
    ocrObjectKey: generatedText.objectKey,
  }], new Date('2026-07-14T00:00:00.000Z'))
  const artifact = JSON.parse((await gunzipAsync(result.data)).toString('utf8'))

  assert.match(result.objectKey, /^spaces\/space-1\/search\/index-[a-f0-9]{24}\.json\.gz$/)
  assert.equal(artifact.entries[0].normalizedName, '学校の お知らせ.pdf')
  assert.equal(artifact.entries[0].pages[0].normalizedText, '提出期限は 7月20日 です')
  assert.equal(artifact.generatedAt, '2026-07-14T00:00:00.000Z')
})

test('検索文字列の全角英数字と空白を正規化する', () => {
  assert.equal(normalizeDocumentSearchText('  ＡＢＣ　１２３  '), 'abc 123')
})
