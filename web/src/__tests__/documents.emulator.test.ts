import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/services/firebase'
import { validateCurrentUserAccessApi } from '@/services/cloudFunctionsService'
import {
  getDocumentAccessUrlApi,
  uploadDocument,
} from '@/services/documentService'

const describeWithEmulators = import.meta.env.VITE_USE_EMULATOR === 'true'
  && !!process.env.FIRESTORE_EMULATOR_HOST
  && !!process.env.FIREBASE_AUTH_EMULATOR_HOST
  ? describe
  : describe.skip

describeWithEmulators('家族書類ボックス Emulator結合', () => {
  let userId = ''
  let spaceId = ''

  beforeAll(async () => {
    const uniqueId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const credential = await createUserWithEmailAndPassword(
      auth,
      `documents-${uniqueId}@example.com`,
      'local-test-password'
    )
    userId = credential.user.uid
    spaceId = `personal_${userId}`
    await validateCurrentUserAccessApi()
  })

  afterAll(async () => {
    await signOut(auth)
  })

  it('PDFを追加してメタデータと原本を取得できる', async () => {
    const originalContent = '%PDF-1.4\nTodoBridge local test\n%%EOF'
    const file = new File([originalContent], '確認用.pdf', {
      type: 'application/pdf',
    })

    const documentId = await uploadDocument(spaceId, file, 'file')
    const snapshot = await getDoc(doc(db, 'spaces', spaceId, 'documents', documentId))

    expect(snapshot.exists()).toBe(true)
    expect(snapshot.data()).toEqual(expect.objectContaining({
      id: documentId,
      spaceId,
      name: '確認用.pdf',
      status: 'uploaded',
      mimeType: 'application/pdf',
      sizeBytes: file.size,
      uploadedBy: userId,
    }))

    const access = await getDocumentAccessUrlApi(spaceId, documentId)
    const response = await fetch(access.url)
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toContain('application/pdf')
    expect(await response.text()).toBe(originalContent)
  })
})
