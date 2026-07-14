import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
import * as functions from 'firebase-functions/v1'
import { createObjectStorageProvider, isFunctionsEmulator } from './providers/providerFactory'
import { FamilyDocument } from './types'
import { buildDocumentSearchIndexObjectKey } from './objectKeys'
import {
  DEFAULT_DOCUMENT_LIMIT_BYTES,
  DEFAULT_DOCUMENT_WARNING_BYTES,
} from './lifecycle'
import {
  buildDocumentSearchIndex,
  DOCUMENT_SEARCH_INDEX_SCHEMA_VERSION,
  getDocumentSearchIndexVersion,
} from './searchIndex'

const db = admin.firestore()
const DOWNLOAD_URL_EXPIRY_SECONDS = 5 * 60
const R2_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]

const searchRuntime = functions.runWith(
  isFunctionsEmulator() ? {} : { secrets: R2_SECRETS }
)

async function requireActiveMember(
  context: functions.https.CallableContext,
  spaceId: string
): Promise<void> {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
  }
  const member = await db.doc(`spaces/${spaceId}/members/${context.auth.uid}`).get()
  if (!member.exists || member.data()?.status !== 'active') {
    throw new functions.https.HttpsError('permission-denied', '家族スペースへのアクセス権がありません')
  }
}

export const getDocumentSearchIndex = searchRuntime
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    const spaceId = typeof data?.spaceId === 'string' ? data.spaceId.trim() : ''
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(spaceId)) {
      throw new functions.https.HttpsError('invalid-argument', 'spaceIdが不正です')
    }
    await requireActiveMember(context, spaceId)

    const snapshot = await db.collection(`spaces/${spaceId}/documents`).get()
    const documents = snapshot.docs.map((item) => item.data() as FamilyDocument)
    const provider = createObjectStorageProvider()
    const version = getDocumentSearchIndexVersion(documents)
    const objectKey = buildDocumentSearchIndexObjectKey(spaceId, version)
    if (!await provider.stat(objectKey)) {
      const generated = await buildDocumentSearchIndex(provider, spaceId, documents)
      await provider.writeObject({
        objectKey,
        contentType: 'application/gzip',
        data: generated.data,
        metadata: {
          schemaversion: String(DOCUMENT_SEARCH_INDEX_SCHEMA_VERSION),
          version: generated.artifact.version,
          entrycount: String(generated.artifact.entries.length),
        },
      })
      await db.runTransaction(async (transaction) => {
        const settingsRef = db.doc(`spaces/${spaceId}/settings/documentSearch`)
        const usageRef = db.doc(`spaces/${spaceId}/usage/documents`)
        const [settingsSnapshot, usageSnapshot] = await Promise.all([
          transaction.get(settingsRef),
          transaction.get(usageRef),
        ])
        if (settingsSnapshot.data()?.version === version) return
        const previousSizeBytes = typeof settingsSnapshot.data()?.sizeBytes === 'number'
          ? settingsSnapshot.data()!.sizeBytes
          : 0
        transaction.set(settingsRef, {
          version,
          objectKey,
          sizeBytes: generated.data.length,
          updatedAt: Timestamp.now(),
        })
        const usage = usageSnapshot.data()
        transaction.set(usageRef, {
          originalBytes: usage?.originalBytes ?? 0,
          derivedBytes: Math.max(
            0,
            (usage?.derivedBytes ?? 0) + generated.data.length - previousSizeBytes
          ),
          documentCount: usage?.documentCount ?? 0,
          processingPageCountThisMonth: usage?.processingPageCountThisMonth ?? 0,
          processingPageMonth: usage?.processingPageMonth ?? null,
          limitBytes: usage?.limitBytes ?? DEFAULT_DOCUMENT_LIMIT_BYTES,
          warningBytes: usage?.warningBytes ?? DEFAULT_DOCUMENT_WARNING_BYTES,
          updatedAt: Timestamp.now(),
        }, { merge: true })
      })
      try {
        const existingIndexes = await provider.listObjects(`spaces/${spaceId}/search/`)
        await provider.deleteObjects(existingIndexes
          .map((item) => item.objectKey)
          .filter((existingObjectKey) => existingObjectKey !== objectKey))
      } catch {
        // 古いindexの削除失敗は現在の検索を妨げず、整合性確認で再処理する
      }
    }
    const download = await provider.createDownloadUrl({
      objectKey,
      expiresInSeconds: DOWNLOAD_URL_EXPIRY_SECONDS,
    })
    return {
      version,
      url: download.url,
      expiresAt: download.expiresAt.toISOString(),
    }
  })
