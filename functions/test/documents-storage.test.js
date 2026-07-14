const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildOriginalObjectKey,
  buildOcrResultObjectKey,
  buildThumbnailObjectKey,
  isObjectKeyInDocument,
} = require('../lib/documents/objectKeys')
const {
  LocalObjectStorageProvider,
  getLocalRequestParameters,
  isValidLocalSignature,
  readLocalObject,
  writeLocalObject,
} = require('../lib/documents/providers/localProvider')
const {
  assertDeleteObjectsSucceeded,
  readR2ProviderConfig,
} = require('../lib/documents/providers/r2Provider')
const {
  createObjectStorageProvider,
} = require('../lib/documents/providers/providerFactory')

test('推測可能なファイル名を含まない原本キーを生成する', () => {
  const key = buildOriginalObjectKey('family_1', 'document_1', 'object_1')
  assert.equal(key, 'spaces/family_1/documents/document_1/original/object_1')
  assert.equal(isObjectKeyInDocument(key, 'family_1', 'document_1'), true)
  assert.equal(isObjectKeyInDocument(key, 'family_2', 'document_1'), false)
})

test('パス区切りを含む識別子を拒否する', () => {
  assert.throws(
    () => buildOriginalObjectKey('../family', 'document_1', 'object_1'),
    /spaceId/
  )
})

test('version固定のサムネイルキーを生成する', () => {
  assert.equal(
    buildThumbnailObjectKey('family_1', 'document_1', 1),
    'spaces/family_1/documents/document_1/thumbnail/v1.webp'
  )
  assert.throws(() => buildThumbnailObjectKey('family_1', 'document_1', 0), /version/)
})

test('解析version固定のOCR成果物キーを生成する', () => {
  assert.equal(
    buildOcrResultObjectKey('family_1', 'document_1', 2),
    'spaces/family_1/documents/document_1/analysis/v2/ocr.json.gz'
  )
  assert.throws(() => buildOcrResultObjectKey('family_1', 'document_1', 0), /version/)
})

test('R2設定の不足項目を秘密値なしで報告する', () => {
  assert.throws(
    () => readR2ProviderConfig({ R2_ACCOUNT_ID: 'account' }),
    /R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/
  )
})

test('R2設定を環境変数から読み込む', () => {
  assert.deepEqual(readR2ProviderConfig({
    R2_ACCOUNT_ID: 'account',
    R2_BUCKET: 'bucket',
    R2_ACCESS_KEY_ID: 'access',
    R2_SECRET_ACCESS_KEY: 'secret',
  }), {
    accountId: 'account',
    bucket: 'bucket',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
  })
})

test('R2の一括削除で部分失敗を検出する', () => {
  assert.doesNotThrow(() => assertDeleteObjectsSucceeded({ Deleted: [{ Key: 'key' }] }))
  assert.throws(
    () => assertDeleteObjectsSucceeded({ Errors: [{ Code: 'AccessDenied' }] }),
    /一部を削除できませんでした（1件）: AccessDenied/
  )
})

test('Emulatorではローカルproviderへ切り替える', () => {
  assert.equal(
    createObjectStorageProvider({ FUNCTIONS_EMULATOR: 'true' }) instanceof LocalObjectStorageProvider,
    true
  )
})

test('ローカルproviderが改ざん検知可能なアップロードURLを作る', async () => {
  const provider = new LocalObjectStorageProvider()
  const signed = await provider.createUploadUrl({
    objectKey: 'spaces/family_1/documents/document_1/original/object_1',
    contentType: 'application/pdf',
    contentLength: 4,
    expiresInSeconds: 600,
    metadata: { sha256: 'a'.repeat(64) },
  })
  const parameters = getLocalRequestParameters(signed.url)

  assert.equal(isValidLocalSignature(parameters), true)
  parameters.set('objectKey', 'spaces/family_2/documents/document_1/original/object_1')
  assert.equal(isValidLocalSignature(parameters), false)
})

test('スマホ確認時はLAN上のFunctions URLを発行する', async () => {
  const previousHost = process.env.DOCUMENT_EMULATOR_HOST
  process.env.DOCUMENT_EMULATOR_HOST = '192.168.0.25'
  try {
    const provider = new LocalObjectStorageProvider()
    const signed = await provider.createDownloadUrl({
      objectKey: 'spaces/family_1/documents/document_1/original/object_1',
      expiresInSeconds: 600,
    })

    assert.equal(signed.url.startsWith('http://192.168.0.25:5001/'), true)
  } finally {
    if (previousHost === undefined) delete process.env.DOCUMENT_EMULATOR_HOST
    else process.env.DOCUMENT_EMULATOR_HOST = previousHost
  }
})

test('ローカルproviderが保存状態と削除を管理する', async () => {
  const provider = new LocalObjectStorageProvider()
  const objectKey = `spaces/test/documents/test/original/${Date.now()}`
  await writeLocalObject(objectKey, 'text/plain', { sha256: 'hash' }, Buffer.from('test'))

  const content = await readLocalObject(objectKey)
  assert.equal(content?.toString(), 'test')
  const storedObject = await provider.stat(objectKey)
  assert.equal(storedObject?.objectKey, objectKey)
  assert.equal(storedObject?.sizeBytes, 4)
  assert.equal(storedObject?.contentType, 'text/plain')
  assert.equal(typeof storedObject?.etag, 'string')
  assert.equal(storedObject?.lastModifiedAt instanceof Date, true)
  assert.deepEqual(storedObject?.metadata, { sha256: 'hash' })
  assert.equal(
    (await provider.listObjects('spaces/test/documents/')).some(
      (object) => object.objectKey === objectKey && object.sizeBytes === 4
    ),
    true
  )

  await provider.deleteObjects([objectKey])
  assert.equal(await provider.stat(objectKey), null)
})
