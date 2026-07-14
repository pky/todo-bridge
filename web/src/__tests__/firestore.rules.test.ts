import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore'

const projectId = 'demo-rertm'
const currentDir = dirname(fileURLToPath(import.meta.url))
const rules = readFileSync(resolve(currentDir, '../../firestore.rules'), 'utf8')
const describeWithEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip

let testEnv: RulesTestEnvironment

async function seedSpace(spaceId: string, ownerUid: string): Promise<void> {
  await seedDoc(`spaces/${spaceId}`, {
    name: 'テスト用家族スペース',
    type: 'family',
    ownerUid,
    memberCount: 1,
    createdAt: Timestamp.fromMillis(1),
    updatedAt: Timestamp.fromMillis(1),
  })
}

async function seedSpaceMember(
  spaceId: string,
  uid: string,
  email: string,
  role: 'owner' | 'member' = 'member'
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, `spaces/${spaceId}/members/${uid}`), {
      uid,
      email,
      displayName: uid,
      role,
      status: 'active',
    })
  })
}

async function seedDoc(path: string, data: Record<string, unknown>): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, path), data)
  })
}

function createFamilyDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Timestamp.fromMillis(1)
  return {
    id: 'document-1',
    spaceId: 'documents-space',
    name: '学校のお知らせ.pdf',
    category: 'school_childcare',
    status: 'ready',
    source: 'file',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    pageCount: 1,
    originalObjectKey: 'spaces/documents-space/documents/document-1/original/object-1',
    thumbnailObjectKey: null,
    sha256: 'a'.repeat(64),
    uploadedBy: 'alice',
    documentDate: now,
    ocrStatus: 'completed',
    analysisVersion: 1,
    searchIndexVersion: 1,
    calendarEventIds: [],
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    trashedBy: null,
    ...overrides,
  }
}

function createDocumentSuggestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Timestamp.fromMillis(1)
  return {
    id: 'suggestion-1',
    type: 'task',
    status: 'pending',
    title: '提出物を準備する',
    value: { dueDate: '2026-07-20' },
    pageNumber: 1,
    sourceExcerpt: '7月20日までに提出',
    confidence: 0.95,
    generatedByVersion: 1,
    acceptedBy: null,
    acceptedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function createDocumentTaskLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'link-1',
    spaceId: 'links-space',
    documentId: 'document-1',
    taskId: 'task-1',
    relation: 'attachment',
    pageNumber: null,
    suggestionId: null,
    sourceExcerpt: null,
    createdBy: 'alice',
    createdAt: Timestamp.fromMillis(1),
    ...overrides,
  }
}

describeWithEmulator('firestore rules', () => {
  beforeAll(async () => {
    const host = process.env.FIRESTORE_EMULATOR_HOST
    if (!host) {
      throw new Error('FIRESTORE_EMULATOR_HOST is not set')
    }

    const [emulatorHost, emulatorPort] = host.split(':')
    testEnv = await initializeTestEnvironment({
      projectId,
      firestore: {
        host: emulatorHost,
        port: Number(emulatorPort),
        rules,
      },
    })
  })

  afterAll(async () => {
    await testEnv.cleanup()
  })

  it('可視メンバーは共有リストを読める', async () => {
    await seedSpaceMember('space-1', 'alice', 'alice@example.com')
    await seedDoc('spaces/space-1/lists/list-1', {
      name: '家族の買い物',
      visibleToMemberIds: ['alice'],
      editableByMemberIds: ['alice'],
    })

    const db = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    await assertSucceeds(getDoc(doc(db, 'spaces/space-1/lists/list-1')))
  })

  it('非可視メンバーは共有リストを読めない', async () => {
    await seedSpaceMember('space-1', 'bob', 'bob@example.com')
    await seedDoc('spaces/space-1/lists/list-2', {
      name: 'Aだけ見えるリスト',
      visibleToMemberIds: ['alice'],
      editableByMemberIds: ['alice'],
    })

    const db = testEnv.authenticatedContext('bob', { email: 'bob@example.com' }).firestore()
    await assertFails(getDoc(doc(db, 'spaces/space-1/lists/list-2')))
  })

  it('編集可能メンバーは共有タスクを作成できる', async () => {
    await seedSpaceMember('space-2', 'alice', 'alice@example.com')

    const db = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    await assertSucceeds(setDoc(doc(db, 'spaces/space-2/tasks/task-1'), {
      name: '牛乳を買う',
      listId: 'list-1',
      visibleToMemberIds: ['alice'],
      editableByMemberIds: ['alice'],
    }))
  })

  it('非メンバーは共有タスクを作成できない', async () => {
    const db = testEnv.authenticatedContext('mallory', { email: 'mallory@example.com' }).firestore()
    await assertFails(setDoc(doc(db, 'spaces/space-3/tasks/task-1'), {
      name: '侵入テスト',
      listId: 'list-1',
      visibleToMemberIds: ['mallory'],
      editableByMemberIds: ['mallory'],
    }))
  })

  it('家族メンバーは書類情報を読めるが非メンバーは読めない', async () => {
    await seedSpace('documents-space', 'alice')
    await seedSpaceMember('documents-space', 'alice', 'alice@example.com', 'owner')
    await seedDoc(
      'spaces/documents-space/documents/document-1',
      createFamilyDocument()
    )
    await seedDoc(
      'spaces/documents-space/documents/document-1/suggestions/suggestion-1',
      createDocumentSuggestion()
    )
    await seedDoc('spaces/documents-space/usage/documents', {
      originalBytes: 1024,
      derivedBytes: 256,
      documentCount: 1,
      processingPageCountThisMonth: 1,
      limitBytes: 5 * 1024 * 1024 * 1024,
      warningBytes: 4 * 1024 * 1024 * 1024,
      updatedAt: Timestamp.fromMillis(1),
    })

    const aliceDb = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    const malloryDb = testEnv.authenticatedContext('mallory', { email: 'mallory@example.com' }).firestore()
    const paths = [
      'spaces/documents-space/documents/document-1',
      'spaces/documents-space/documents/document-1/suggestions/suggestion-1',
      'spaces/documents-space/usage/documents',
    ]

    for (const path of paths) {
      await assertSucceeds(getDoc(doc(aliceDb, path)))
      await assertFails(getDoc(doc(malloryDb, path)))
    }

    await assertSucceeds(getDocs(collection(aliceDb, 'spaces/documents-space/documents')))
    await assertFails(getDocs(collection(malloryDb, 'spaces/documents-space/documents')))
  })

  it('家族メンバーは書類の利用者編集項目だけを更新できる', async () => {
    await seedSpace('documents-edit-space', 'alice')
    await seedSpaceMember('documents-edit-space', 'alice', 'alice@example.com', 'owner')
    await seedDoc(
      'spaces/documents-edit-space/documents/document-1',
      createFamilyDocument({ spaceId: 'documents-edit-space' })
    )

    const db = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    const documentRef = doc(db, 'spaces/documents-edit-space/documents/document-1')

    await assertSucceeds(updateDoc(documentRef, {
      name: '更新したお知らせ.pdf',
      category: 'other',
      documentDate: null,
      updatedAt: Timestamp.fromMillis(2),
    }))
    await assertFails(updateDoc(documentRef, {
      status: 'trashed',
      updatedAt: Timestamp.fromMillis(3),
    }))
    await assertFails(updateDoc(documentRef, {
      originalObjectKey: 'spaces/attacker/object',
      updatedAt: Timestamp.fromMillis(3),
    }))
    await assertFails(deleteDoc(documentRef))
  })

  it('書類の作成、容量更新、監査記録はクライアントから実行できない', async () => {
    await seedSpace('documents-write-space', 'alice')
    await seedSpaceMember('documents-write-space', 'alice', 'alice@example.com', 'owner')
    await seedDoc('spaces/documents-write-space/usage/documents', {
      originalBytes: 1024,
      derivedBytes: 256,
      documentCount: 1,
      processingPageCountThisMonth: 1,
      limitBytes: 5 * 1024 * 1024 * 1024,
      warningBytes: 4 * 1024 * 1024 * 1024,
      updatedAt: Timestamp.fromMillis(1),
    })

    const db = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    await assertFails(setDoc(
      doc(db, 'spaces/documents-write-space/documents/document-1'),
      createFamilyDocument({ spaceId: 'documents-write-space' })
    ))
    await assertFails(updateDoc(doc(db, 'spaces/documents-write-space/usage/documents'), {
      originalBytes: 0,
      limitBytes: 0,
      updatedAt: Timestamp.fromMillis(2),
    }))
    await assertFails(setDoc(doc(db, 'spaces/documents-write-space/documentActivity/activity-1'), {
      type: 'upload_completed',
      createdAt: Timestamp.fromMillis(1),
    }))
  })

  it('抽出候補は採否と修正値だけを更新できる', async () => {
    await seedSpace('suggestions-space', 'alice')
    await seedSpaceMember('suggestions-space', 'alice', 'alice@example.com', 'owner')
    await seedDoc(
      'spaces/suggestions-space/documents/document-1',
      createFamilyDocument({ spaceId: 'suggestions-space' })
    )
    await seedDoc(
      'spaces/suggestions-space/documents/document-1/suggestions/suggestion-1',
      createDocumentSuggestion()
    )

    const db = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    const suggestionRef = doc(
      db,
      'spaces/suggestions-space/documents/document-1/suggestions/suggestion-1'
    )

    await assertSucceeds(updateDoc(suggestionRef, {
      status: 'accepted',
      title: '修正した提出物を準備する',
      value: { dueDate: '2026-07-21' },
      acceptedBy: 'alice',
      acceptedAt: Timestamp.fromMillis(2),
      updatedAt: Timestamp.fromMillis(2),
    }))
    await assertFails(updateDoc(suggestionRef, {
      generatedByVersion: 999,
      updatedAt: Timestamp.fromMillis(3),
    }))
    await assertFails(setDoc(
      doc(db, 'spaces/suggestions-space/documents/document-1/suggestions/suggestion-2'),
      createDocumentSuggestion({ id: 'suggestion-2' })
    ))
    await assertFails(deleteDoc(suggestionRef))
  })

  it('Taskを編集できる家族メンバーだけが書類との関連を変更できる', async () => {
    await seedSpace('links-space', 'alice')
    await seedSpaceMember('links-space', 'alice', 'alice@example.com', 'owner')
    await seedSpaceMember('links-space', 'bob', 'bob@example.com')
    await seedDoc(
      'spaces/links-space/documents/document-1',
      createFamilyDocument({ spaceId: 'links-space' })
    )
    await seedDoc('spaces/links-space/tasks/task-1', {
      name: '提出物を準備する',
      listId: 'list-1',
      visibleToMemberIds: ['alice', 'bob'],
      editableByMemberIds: ['alice'],
    })

    const aliceDb = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    const bobDb = testEnv.authenticatedContext('bob', { email: 'bob@example.com' }).firestore()
    const malloryDb = testEnv.authenticatedContext('mallory', { email: 'mallory@example.com' }).firestore()
    const linkPath = 'spaces/links-space/documentTaskLinks/link-1'

    await assertSucceeds(setDoc(doc(aliceDb, linkPath), createDocumentTaskLink()))
    await assertSucceeds(getDoc(doc(bobDb, linkPath)))
    await assertFails(getDoc(doc(malloryDb, linkPath)))
    const bobTaskLinksQuery = query(
      collection(bobDb, 'spaces/links-space/documentTaskLinks'),
      where('taskId', '==', 'task-1')
    )
    const malloryTaskLinksQuery = query(
      collection(malloryDb, 'spaces/links-space/documentTaskLinks'),
      where('taskId', '==', 'task-1')
    )
    await assertSucceeds(getDocs(bobTaskLinksQuery))
    await assertFails(getDocs(malloryTaskLinksQuery))
    await assertFails(setDoc(
      doc(aliceDb, 'spaces/links-space/documentTaskLinks/link-mismatch'),
      createDocumentTaskLink({ id: 'different-id' })
    ))
    await assertFails(setDoc(
      doc(bobDb, 'spaces/links-space/documentTaskLinks/link-2'),
      createDocumentTaskLink({ id: 'link-2', createdBy: 'bob' })
    ))
    await assertSucceeds(updateDoc(doc(aliceDb, linkPath), {
      relation: 'reference',
      pageNumber: 1,
      suggestionId: 'suggestion-1',
      sourceExcerpt: '提出期限の記載',
    }))
    await assertFails(updateDoc(doc(bobDb, linkPath), { relation: 'source' }))
    await assertSucceeds(deleteDoc(doc(aliceDb, linkPath)))
  })

  it('公開連携設定は家族が読めるが直接更新できず秘密情報はownerにも見せない', async () => {
    await seedSpace('integrations-space', 'alice')
    await seedSpaceMember('integrations-space', 'alice', 'alice@example.com', 'owner')
    await seedSpaceMember('integrations-space', 'bob', 'bob@example.com')
    await seedDoc('spaces/integrations-space/settings/documentIntegrations', {
      r2Enabled: true,
      ocrEnabled: false,
      driveConnected: false,
      calendarConnected: false,
    })
    await seedDoc('privateIntegrations/integrations-space/providers/google', {
      encryptedRefreshToken: '暗号化済みデータ',
    })

    const aliceDb = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    const bobDb = testEnv.authenticatedContext('bob', { email: 'bob@example.com' }).firestore()
    const publicPath = 'spaces/integrations-space/settings/documentIntegrations'
    const privatePath = 'privateIntegrations/integrations-space/providers/google'

    await assertSucceeds(getDoc(doc(aliceDb, publicPath)))
    await assertSucceeds(getDoc(doc(bobDb, publicPath)))
    await assertFails(updateDoc(doc(aliceDb, publicPath), { r2Enabled: false }))
    await assertFails(updateDoc(doc(bobDb, publicPath), { r2Enabled: false }))
    await assertFails(getDoc(doc(aliceDb, privatePath)))
    await assertFails(getDoc(doc(bobDb, privatePath)))
  })

  it('既存のスペース設定はownerだけが直接更新できる', async () => {
    await seedSpace('settings-space', 'alice')
    await seedSpaceMember('settings-space', 'alice', 'alice@example.com', 'owner')
    await seedSpaceMember('settings-space', 'bob', 'bob@example.com')
    await seedDoc('spaces/settings-space/settings/integrations', {
      calendarId: 'primary',
    })

    const aliceDb = testEnv.authenticatedContext('alice', { email: 'alice@example.com' }).firestore()
    const bobDb = testEnv.authenticatedContext('bob', { email: 'bob@example.com' }).firestore()
    const settingsPath = 'spaces/settings-space/settings/integrations'

    await assertSucceeds(updateDoc(doc(aliceDb, settingsPath), { calendarId: 'family-calendar' }))
    await assertFails(updateDoc(doc(bobDb, settingsPath), { calendarId: 'attacker-calendar' }))
  })
})
