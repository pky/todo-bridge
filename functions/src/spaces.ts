import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'

const db = admin.firestore()

type FirestoreTimestamp = admin.firestore.Timestamp
type FirestoreData = admin.firestore.DocumentData

export function buildFamilySpaceRecord(
  ownerUid: string,
  name: string,
  now: FirestoreTimestamp
): Record<string, unknown> {
  return {
    name,
    type: 'family',
    ownerUid,
    memberCount: 1,
    createdAt: now,
    updatedAt: now,
  }
}

export function buildPersonalSpaceRecord(
  ownerUid: string,
  now: FirestoreTimestamp
): Record<string, unknown> {
  return {
    name: '個人スペース',
    type: 'personal',
    ownerUid,
    memberCount: 1,
    createdAt: now,
    updatedAt: now,
  }
}

export function buildSpaceMemberRecord(
  uid: string,
  email: string | null,
  displayName: string | null,
  now: FirestoreTimestamp,
  role: 'owner' | 'member' = 'member',
  status: 'active' = 'active'
): Record<string, unknown> {
  return {
    uid,
    email,
    displayName,
    role,
    status,
    createdAt: now,
    updatedAt: now,
  }
}

export function buildMembershipRecord(
  spaceId: string,
  displayName: string,
  now: FirestoreTimestamp,
  role: 'owner' | 'member' = 'member',
  status: 'active' = 'active'
): Record<string, unknown> {
  return {
    spaceId,
    role,
    status,
    displayName,
    joinedAt: status === 'active' ? now : null,
  }
}

export function buildSpaceNameUpdate(
  name: string,
  now: FirestoreTimestamp
): Record<string, unknown> {
  return {
    name,
    updatedAt: now,
  }
}

function buildPersonalSpaceId(uid: string): string {
  return `personal_${uid}`
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null
  const normalized = email.trim().toLowerCase()
  return normalized || null
}

export function isAllowedEmail(
  allowedEmails: string[],
  email: string | null | undefined
): boolean {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail) return false
  return allowedEmails.map((value) => value.trim().toLowerCase()).includes(normalizedEmail)
}

async function getAllowedEmails(): Promise<string[]> {
  const authAccessSnapshot = await db.doc('appConfig/authAccess').get()
  const allowedEmails = authAccessSnapshot.data()?.allowedEmails
  return Array.isArray(allowedEmails)
    ? allowedEmails.filter((value): value is string => typeof value === 'string')
    : []
}

async function ensureFamilySpaceMemberships(
  userId: string,
  email: string | null,
  displayName: string | null,
  now: FirestoreTimestamp
): Promise<string[]> {
  const familySpacesSnapshot = await db.collection('spaces').where('type', '==', 'family').get()
  const familySpaceDocs = familySpacesSnapshot.docs
  if (familySpaceDocs.length === 0) return []

  const memberSnapshots = await Promise.all(
    familySpaceDocs.map((spaceDoc) => db.doc(`spaces/${spaceDoc.id}/members/${userId}`).get())
  )
  const membershipSnapshots = await Promise.all(
    familySpaceDocs.map((spaceDoc) => db.doc(`users/${userId}/memberships/${spaceDoc.id}`).get())
  )

  const batch = db.batch()
  const joinedFamilySpaceIds: string[] = []
  const spacesNeedingVisibilitySync = new Set<string>()

  familySpaceDocs.forEach((spaceDoc, index) => {
    const spaceData = spaceDoc.data()
    const memberSnapshot = memberSnapshots[index]
    const membershipSnapshot = membershipSnapshots[index]
    const role = spaceData.ownerUid === userId ? 'owner' : 'member'

    if (!memberSnapshot?.exists) {
      batch.set(
        db.doc(`spaces/${spaceDoc.id}/members/${userId}`),
        buildSpaceMemberRecord(userId, email, displayName, now, role, 'active')
      )
      batch.set(spaceDoc.ref, { memberCount: admin.firestore.FieldValue.increment(1) }, { merge: true })
      joinedFamilySpaceIds.push(spaceDoc.id)
    }

    if (!membershipSnapshot?.exists) {
      batch.set(
        db.doc(`users/${userId}/memberships/${spaceDoc.id}`),
        buildMembershipRecord(spaceDoc.id, String(spaceData.name ?? '家族スペース'), now, role, 'active')
      )
    }

    spacesNeedingVisibilitySync.add(spaceDoc.id)
  })

  await batch.commit()

  await Promise.all(Array.from(spacesNeedingVisibilitySync).map((spaceId) => syncFamilySpaceVisibility(spaceId, userId)))
  return joinedFamilySpaceIds
}

export function appendMemberToVisibility(
  data: FirestoreData,
  userId: string
): FirestoreData | null {
  const nextVisibleToMemberIds = Array.isArray(data.visibleToMemberIds)
    ? Array.from(new Set([...data.visibleToMemberIds.filter((value): value is string => typeof value === 'string'), userId]))
    : null
  const nextEditableByMemberIds = Array.isArray(data.editableByMemberIds)
    ? Array.from(new Set([...data.editableByMemberIds.filter((value): value is string => typeof value === 'string'), userId]))
    : null

  if (!nextVisibleToMemberIds && !nextEditableByMemberIds) {
    return null
  }

  const shouldUpdateVisible = nextVisibleToMemberIds
    ? nextVisibleToMemberIds.length !== (data.visibleToMemberIds?.length ?? 0)
    : false
  const shouldUpdateEditable = nextEditableByMemberIds
    ? nextEditableByMemberIds.length !== (data.editableByMemberIds?.length ?? 0)
    : false

  if (!shouldUpdateVisible && !shouldUpdateEditable) {
    return null
  }

  return {
    ...(shouldUpdateVisible ? { visibleToMemberIds: nextVisibleToMemberIds } : {}),
    ...(shouldUpdateEditable ? { editableByMemberIds: nextEditableByMemberIds } : {}),
  }
}

async function syncFamilySpaceVisibility(spaceId: string, userId: string): Promise<void> {
  const [listsSnapshot, tasksSnapshot, tagsSnapshot] = await Promise.all([
    db.collection(`spaces/${spaceId}/lists`).get(),
    db.collection(`spaces/${spaceId}/tasks`).get(),
    db.collection(`spaces/${spaceId}/tags`).get(),
  ])

  const updates: Array<{
    ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
    data: FirestoreData
  }> = []

  const maybeQueueUpdate = (
    documentSnapshot: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
  ) => {
    const updateData = appendMemberToVisibility(documentSnapshot.data(), userId)
    if (!updateData) return

    updates.push({ ref: documentSnapshot.ref, data: updateData })
  }

  listsSnapshot.docs.forEach(maybeQueueUpdate)
  tasksSnapshot.docs.forEach(maybeQueueUpdate)
  tagsSnapshot.docs.forEach(maybeQueueUpdate)

  for (let index = 0; index < updates.length; index += 400) {
    const batch = db.batch()
    updates.slice(index, index + 400).forEach((update) => {
      batch.set(update.ref, update.data, { merge: true })
    })
    await batch.commit()
  }
}

export const createFamilySpace = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const name = typeof data?.name === 'string' ? data.name.trim() : ''
    if (!name) {
      throw new functions.https.HttpsError('invalid-argument', 'スペース名が必要です')
    }

    const now = admin.firestore.Timestamp.now()
    const userId = context.auth.uid
    const email = context.auth.token.email ?? null
    const displayName = typeof data?.displayName === 'string'
      ? data.displayName
      : (context.auth.token.name as string | undefined) ?? null

    const spaceRef = db.collection('spaces').doc()
    const batch = db.batch()

    batch.set(spaceRef, buildFamilySpaceRecord(userId, name, now))
    batch.set(
      db.doc(`spaces/${spaceRef.id}/members/${userId}`),
      buildSpaceMemberRecord(userId, email, displayName, now, 'owner', 'active')
    )
    batch.set(
      db.doc(`users/${userId}/memberships/${spaceRef.id}`),
      buildMembershipRecord(spaceRef.id, name, now, 'owner', 'active')
    )

    await batch.commit()

    return {
      success: true,
      spaceId: spaceRef.id,
      name,
    }
  })

export const updateFamilySpaceName = functions
  .region('asia-northeast1')
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const spaceId = typeof data?.spaceId === 'string' ? data.spaceId.trim() : ''
    const name = typeof data?.name === 'string' ? data.name.trim() : ''
    if (!spaceId || !name) {
      throw new functions.https.HttpsError('invalid-argument', 'spaceId と name が必要です')
    }

    const requesterMemberSnapshot = await db.doc(`spaces/${spaceId}/members/${context.auth.uid}`).get()
    if (!requesterMemberSnapshot.exists || requesterMemberSnapshot.data()?.role !== 'owner') {
      throw new functions.https.HttpsError('permission-denied', 'スペース名を変更する権限がありません')
    }

    const now = admin.firestore.Timestamp.now()
    const membersSnapshot = await db.collection(`spaces/${spaceId}/members`)
      .where('status', '==', 'active')
      .get()

    const batch = db.batch()
    batch.set(db.doc(`spaces/${spaceId}`), buildSpaceNameUpdate(name, now), { merge: true })

    membersSnapshot.docs.forEach((memberDoc) => {
      batch.set(
        db.doc(`users/${memberDoc.id}/memberships/${spaceId}`),
        { displayName: name },
        { merge: true }
      )
    })

    await batch.commit()

    return {
      success: true,
      spaceId,
      name,
    }
  })

export const ensureCurrentUserSpaceAccess = functions
  .region('asia-northeast1')
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const now = admin.firestore.Timestamp.now()
    const userId = context.auth.uid
    const email = context.auth.token.email ?? null
    const displayName = (context.auth.token.name as string | undefined) ?? null
    const personalSpaceId = buildPersonalSpaceId(userId)
    const personalSpaceRef = db.doc(`spaces/${personalSpaceId}`)
    const personalMemberRef = db.doc(`spaces/${personalSpaceId}/members/${userId}`)
    const personalMembershipRef = db.doc(`users/${userId}/memberships/${personalSpaceId}`)

    const [personalSpaceSnapshot, personalMemberSnapshot, personalMembershipSnapshot] = await Promise.all([
      personalSpaceRef.get(),
      personalMemberRef.get(),
      personalMembershipRef.get(),
    ])

    const batch = db.batch()

    if (!personalSpaceSnapshot.exists) {
      batch.set(personalSpaceRef, buildPersonalSpaceRecord(userId, now))
    }

    if (!personalMemberSnapshot.exists) {
      batch.set(personalMemberRef, buildSpaceMemberRecord(userId, email, displayName, now, 'owner', 'active'))
    }

    if (!personalMembershipSnapshot.exists) {
      batch.set(
        personalMembershipRef,
        buildMembershipRecord(personalSpaceId, '個人スペース', now, 'owner', 'active')
      )
    }

    await batch.commit()

    return {
      success: true,
      personalSpaceId,
      joinedFamilySpaceIds: [],
      familySpaceCount: 0,
    }
  })

export const validateCurrentUserAccess = functions
  .region('asia-northeast1')
  .https.onCall(async (_data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', '認証が必要です')
    }

    const now = admin.firestore.Timestamp.now()
    const userId = context.auth.uid
    const email = normalizeEmail(context.auth.token.email ?? null)
    const displayName = (context.auth.token.name as string | undefined) ?? null
    const picture = (context.auth.token.picture as string | undefined) ?? null
    const allowedEmails = await getAllowedEmails()

    if (!isAllowedEmail(allowedEmails, email)) {
      throw new functions.https.HttpsError('permission-denied', 'このアカウントは利用を許可されていません')
    }

    const personalSpaceId = buildPersonalSpaceId(userId)
    const personalSpaceRef = db.doc(`spaces/${personalSpaceId}`)
    const personalMemberRef = db.doc(`spaces/${personalSpaceId}/members/${userId}`)
    const personalMembershipRef = db.doc(`users/${userId}/memberships/${personalSpaceId}`)
    const userRef = db.doc(`users/${userId}`)

    const [personalSpaceSnapshot, personalMemberSnapshot, personalMembershipSnapshot] = await Promise.all([
      personalSpaceRef.get(),
      personalMemberRef.get(),
      personalMembershipRef.get(),
    ])

    const batch = db.batch()
    batch.set(userRef, {
      email,
      displayName,
      photoURL: picture,
      lastLoginAt: now,
      updatedAt: now,
    }, { merge: true })

    if (!personalSpaceSnapshot.exists) {
      batch.set(personalSpaceRef, buildPersonalSpaceRecord(userId, now))
    }

    if (!personalMemberSnapshot.exists) {
      batch.set(personalMemberRef, buildSpaceMemberRecord(userId, email, displayName, now, 'owner', 'active'))
    }

    if (!personalMembershipSnapshot.exists) {
      batch.set(
        personalMembershipRef,
        buildMembershipRecord(personalSpaceId, '個人スペース', now, 'owner', 'active')
      )
    }

    await batch.commit()
    const joinedFamilySpaceIds = await ensureFamilySpaceMemberships(userId, email, displayName, now)

    return {
      success: true,
      allowed: true,
      personalSpaceId,
      joinedFamilySpaceIds,
    }
  })
