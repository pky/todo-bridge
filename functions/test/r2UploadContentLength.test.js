const test = require('node:test')
const assert = require('node:assert/strict')
const { R2ObjectStorageProvider } = require('../lib/documents/providers/r2Provider')

test('R2アップロードURLは宣言サイズのcontent-lengthを署名対象に含める', async () => {
  const provider = new R2ObjectStorageProvider({
    accountId: 'dummy-account', bucket: 'dummy-bucket',
    accessKeyId: 'dummy-access', secretAccessKey: 'dummy-secret',
  })
  const signed = await provider.createUploadUrl({
    objectKey: 'spaces/space_1/documents/document_1/original/object_1',
    contentType: 'image/jpeg', contentLength: 4, expiresInSeconds: 600,
  })
  const headers = new URL(signed.url).searchParams.get('X-Amz-SignedHeaders')
  assert.ok(headers?.split(';').includes('content-length'), 'content-lengthが署名対象に必要')
})
