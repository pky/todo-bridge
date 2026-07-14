import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserWithEmailAndPassword, signOut } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '@/services/firebase'
import { validateCurrentUserAccessApi } from '@/services/cloudFunctionsService'
import {
  getDocumentAccessUrlApi,
  getDocumentThumbnailAccessUrlApi,
  uploadDocument,
} from '@/services/documentService'

const describeWithEmulators = import.meta.env.VITE_USE_EMULATOR === 'true'
  && !!process.env.FIRESTORE_EMULATOR_HOST
  && !!process.env.FIREBASE_AUTH_EMULATOR_HOST
  ? describe
  : describe.skip

function createTestPdf(pageCount = 2): Uint8Array {
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
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(pdf)
}

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

  async function waitForPreview(documentId: string) {
    const documentRef = doc(db, 'spaces', spaceId, 'documents', documentId)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await getDoc(documentRef)
      if (snapshot.data()?.previewStatus === 'completed') return snapshot
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('サムネイル生成が時間内に完了しませんでした')
  }

  it('複数ページPDFを追加して原本と一覧サムネイルを取得できる', async () => {
    const originalContent = createTestPdf()
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
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(originalContent)

    const previewSnapshot = await waitForPreview(documentId)
    expect(previewSnapshot.data()).toEqual(expect.objectContaining({
      previewStatus: 'completed',
      pageCount: 2,
      thumbnailObjectKey: expect.stringContaining('/thumbnail/v1.webp'),
    }))
    const thumbnailAccess = await getDocumentThumbnailAccessUrlApi(spaceId, documentId)
    const thumbnailResponse = await fetch(thumbnailAccess.url)
    expect(thumbnailResponse.ok).toBe(true)
    expect(thumbnailResponse.headers.get('content-type')).toContain('image/webp')
  }, 20_000)

  it('画像を追加するとWebPサムネイルを取得できる', async () => {
    const png = Uint8Array.from(atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWPQqDihUXGCAUIBACTuBaFpkxOkAAAAAElFTkSuQmCC'
    ), (character) => character.charCodeAt(0))
    const file = new File([png], '確認用.png', { type: 'image/png' })

    const documentId = await uploadDocument(spaceId, file, 'file')
    const snapshot = await waitForPreview(documentId)
    expect(snapshot.data()).toEqual(expect.objectContaining({
      previewStatus: 'completed',
      previewVersion: 1,
      thumbnailSizeBytes: expect.any(Number),
      thumbnailObjectKey: expect.stringContaining('/thumbnail/v1.webp'),
    }))

    const access = await getDocumentThumbnailAccessUrlApi(spaceId, documentId)
    const response = await fetch(access.url)
    expect(response.ok).toBe(true)
    expect(response.headers.get('content-type')).toContain('image/webp')
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)
  }, 20_000)
})
