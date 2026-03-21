/**
 * 既存ユーザーデータを personal space へ複製するマイグレーション。
 *
 * 使い方: firebase functions:shell で実行
 * > migrateTaskCounts({ userId: 'YOUR_USER_ID' })
 * > migrateUserToPersonalSpace({ userId: 'YOUR_USER_ID' })
 * > checkPersonalSpaceMigration({ userId: 'YOUR_USER_ID' })
 */
import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'

const db = admin.firestore()
const MAX_BATCH_WRITES = 400
const PERSONAL_SPACE_PREFIX = 'personal'

type FirestoreTimestamp = admin.firestore.Timestamp
type FirestoreData = Record<string, unknown>

interface PersonalSpaceSeedData {
  spaceId: string
  spaceMeta: FirestoreData
  member: FirestoreData
  membership: FirestoreData
}

interface CollectionMigrationSummary {
  sourceCount: number
  targetCount: number
}

interface PersonalSpaceMigrationDecision {
  shouldMigrate: boolean
  lists: CollectionMigrationSummary
  tasks: CollectionMigrationSummary
  tags: CollectionMigrationSummary
}

function assertUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new functions.https.HttpsError('invalid-argument', 'userId is required')
  }
}

function resolveScopedCollectionPath(
  userId: string,
  collectionName: 'lists' | 'tasks',
  options: { spaceId?: unknown; useLegacyPath?: unknown } = {}
): string {
  const useLegacyPath = options.useLegacyPath === true
  const spaceId = typeof options.spaceId === 'string' && options.spaceId.trim() !== '' ? options.spaceId : null

  if (!useLegacyPath && spaceId) {
    return `spaces/${spaceId}/${collectionName}`
  }

  return `users/${userId}/${collectionName}`
}

export function buildPersonalSpaceId(userId: string): string {
  return `${PERSONAL_SPACE_PREFIX}_${userId}`
}

export function applyPersonalVisibility(
  data: FirestoreData,
  userId: string,
  spaceId: string
): FirestoreData {
  return {
    ...data,
    spaceId,
    visibleToMemberIds: [userId],
    editableByMemberIds: [userId],
  }
}

export function createPersonalSpaceSeedData(
  userId: string,
  now: FirestoreTimestamp,
  userData: FirestoreData = {}
): PersonalSpaceSeedData {
  const spaceId = buildPersonalSpaceId(userId)
  const displayName = typeof userData.displayName === 'string' ? userData.displayName : null
  const email = typeof userData.email === 'string' ? userData.email : null

  return {
    spaceId,
    spaceMeta: {
      name: 'Personal',
      type: 'personal',
      ownerUid: userId,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    member: {
      uid: userId,
      displayName,
      email,
      role: 'owner',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    membership: {
      spaceId,
      role: 'owner',
      status: 'active',
      displayName: 'Personal',
      joinedAt: now,
    },
  }
}

async function commitInChunks(
  operations: Array<{ ref: FirebaseFirestore.DocumentReference; data: FirestoreData }>
): Promise<void> {
  for (let index = 0; index < operations.length; index += MAX_BATCH_WRITES) {
    const batch = db.batch()
    const chunk = operations.slice(index, index + MAX_BATCH_WRITES)
    for (const operation of chunk) {
      batch.set(operation.ref, operation.data, { merge: true })
    }
    await batch.commit()
  }
}

async function copyCollectionToPersonalSpace(
  userId: string,
  spaceId: string,
  collectionName: 'lists' | 'tasks' | 'tags'
): Promise<CollectionMigrationSummary> {
  const sourceSnapshot = await db.collection(`users/${userId}/${collectionName}`).get()
  const operations = sourceSnapshot.docs.map((documentSnapshot) => ({
    ref: db.doc(`spaces/${spaceId}/${collectionName}/${documentSnapshot.id}`),
    data: applyPersonalVisibility(documentSnapshot.data() as FirestoreData, userId, spaceId),
  }))

  await commitInChunks(operations)

  const targetSnapshot = await db.collection(`spaces/${spaceId}/${collectionName}`).get()
  return {
    sourceCount: sourceSnapshot.size,
    targetCount: targetSnapshot.size,
  }
}

async function checkPersonalSpaceMigrationNeeded(
  userId: string,
  spaceId: string
): Promise<PersonalSpaceMigrationDecision> {
  const [oldLists, oldTasks, oldTags, newLists, newTasks, newTags] = await Promise.all([
    db.collection(`users/${userId}/lists`).count().get(),
    db.collection(`users/${userId}/tasks`).count().get(),
    db.collection(`users/${userId}/tags`).count().get(),
    db.collection(`spaces/${spaceId}/lists`).count().get(),
    db.collection(`spaces/${spaceId}/tasks`).count().get(),
    db.collection(`spaces/${spaceId}/tags`).count().get(),
  ])

  const lists = {
    sourceCount: oldLists.data().count,
    targetCount: newLists.data().count,
  }
  const tasks = {
    sourceCount: oldTasks.data().count,
    targetCount: newTasks.data().count,
  }
  const tags = {
    sourceCount: oldTags.data().count,
    targetCount: newTags.data().count,
  }

  return {
    shouldMigrate:
      lists.sourceCount > lists.targetCount
      || tasks.sourceCount > tasks.targetCount
      || tags.sourceCount > tags.targetCount,
    lists,
    tasks,
    tags,
  }
}

async function seedPersonalSpace(userId: string): Promise<PersonalSpaceSeedData> {
  const now = admin.firestore.Timestamp.now()
  const userSnapshot = await db.doc(`users/${userId}`).get()
  const seedData = createPersonalSpaceSeedData(userId, now, (userSnapshot.data() ?? {}) as FirestoreData)

  await db.doc(`spaces/${seedData.spaceId}`).set(seedData.spaceMeta, { merge: true })
  await db.doc(`spaces/${seedData.spaceId}/members/${userId}`).set(seedData.member, { merge: true })
  await db.doc(`users/${userId}/memberships/${seedData.spaceId}`).set(seedData.membership, { merge: true })

  return seedData
}

// 既存リストの incompleteTaskCount を初期化するマイグレーションスクリプト
export const migrateTaskCounts = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const userId = data.userId
    assertUserId(userId)

    const listsRef = db.collection(resolveScopedCollectionPath(userId, 'lists', data))
    const tasksRef = db.collection(resolveScopedCollectionPath(userId, 'tasks', data))

    const listsSnapshot = await listsRef.get()
    const updates: Promise<FirebaseFirestore.WriteResult>[] = []

    for (const listDoc of listsSnapshot.docs) {
      const listId = listDoc.id
      const tasksSnapshot = await tasksRef
        .where('listId', '==', listId)
        .where('completed', '==', false)
        .where('parentId', '==', null)
        .get()

      updates.push(
        listsRef.doc(listId).update({
          incompleteTaskCount: tasksSnapshot.size,
        })
      )
    }

    await Promise.all(updates)

    return {
      success: true,
      listsUpdated: listsSnapshot.size,
    }
  })

export const migrateUserToPersonalSpace = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const userId = data.userId
    assertUserId(userId)

    const seedData = await seedPersonalSpace(userId)
    const [lists, tasks, tags] = await Promise.all([
      copyCollectionToPersonalSpace(userId, seedData.spaceId, 'lists'),
      copyCollectionToPersonalSpace(userId, seedData.spaceId, 'tasks'),
      copyCollectionToPersonalSpace(userId, seedData.spaceId, 'tags'),
    ])

    return {
      success: true,
      spaceId: seedData.spaceId,
      lists,
      tasks,
      tags,
    }
  })

export const migrateCurrentUserToPersonalSpace = functions
  .region('asia-northeast1')
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const userId = context.auth.uid
    const seedData = await seedPersonalSpace(userId)
    const decision = await checkPersonalSpaceMigrationNeeded(userId, seedData.spaceId)

    if (!decision.shouldMigrate) {
      return {
        success: true,
        migrated: false,
        spaceId: seedData.spaceId,
        lists: decision.lists,
        tasks: decision.tasks,
        tags: decision.tags,
      }
    }

    const [lists, tasks, tags] = await Promise.all([
      copyCollectionToPersonalSpace(userId, seedData.spaceId, 'lists'),
      copyCollectionToPersonalSpace(userId, seedData.spaceId, 'tasks'),
      copyCollectionToPersonalSpace(userId, seedData.spaceId, 'tags'),
    ])

    return {
      success: true,
      migrated: true,
      spaceId: seedData.spaceId,
      lists,
      tasks,
      tags,
    }
  })

export const checkPersonalSpaceMigration = functions
  .region('asia-northeast1')
  .https.onCall(async (data) => {
    const userId = data.userId
    assertUserId(userId)

    const spaceId = buildPersonalSpaceId(userId)
    const [oldLists, oldTasks, oldTags, newLists, newTasks, newTags, membership, member] = await Promise.all([
      db.collection(`users/${userId}/lists`).count().get(),
      db.collection(`users/${userId}/tasks`).count().get(),
      db.collection(`users/${userId}/tags`).count().get(),
      db.collection(`spaces/${spaceId}/lists`).count().get(),
      db.collection(`spaces/${spaceId}/tasks`).count().get(),
      db.collection(`spaces/${spaceId}/tags`).count().get(),
      db.doc(`users/${userId}/memberships/${spaceId}`).get(),
      db.doc(`spaces/${spaceId}/members/${userId}`).get(),
    ])

    return {
      success: true,
      spaceId,
      counts: {
        lists: {
          source: oldLists.data().count,
          target: newLists.data().count,
        },
        tasks: {
          source: oldTasks.data().count,
          target: newTasks.data().count,
        },
        tags: {
          source: oldTags.data().count,
          target: newTags.data().count,
        },
      },
      membershipExists: membership.exists,
      memberExists: member.exists,
    }
  })
