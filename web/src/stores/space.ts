import { defineStore } from 'pinia'
import { ref } from 'vue'
import { collection, doc, getDocs, getDocsFromServer } from 'firebase/firestore'
import { db } from '@/services/firebase'
import { useAuthStore } from './auth'
import type { UserMembership } from '@/types'
import {
  migrateCurrentUserToPersonalSpaceApi,
} from '@/services/cloudFunctionsService'

const CURRENT_SPACE_KEY = 'rertm-current-space-id'
const PERSONAL_SPACE_MIGRATION_KEY_PREFIX = 'rertm-personal-space-migrated'
type ScopedCollectionName = 'lists' | 'tasks' | 'tags'
type ScopedCollectionPath<T extends ScopedCollectionName> =
  ['users', string, T] | ['spaces', string, T]
type SmartListCountsDocPath =
  ['users', string] | ['spaces', string]

export function buildPersonalSpaceId(uid: string): string {
  return `personal_${uid}`
}

export const useSpaceStore = defineStore('space', () => {
  const currentSpaceId = ref<string | null>(null)
  const memberships = ref<UserMembership[]>([])
  const initialized = ref(false)
  const useLegacyPath = ref(true)
  const personalSpaceMigrationChecked = ref(false)
  const initializedUserId = ref<string | null>(null)

  async function getServerFirstSnapshot(collectionRef: ReturnType<typeof collection>) {
    try {
      return await getDocsFromServer(collectionRef)
    } catch (error) {
      console.warn('[spaceStore] Server fetch failed, falling back to cached snapshot:', error)
      return await getDocs(collectionRef)
    }
  }

  async function initSpace(force = false) {
    const authStore = useAuthStore()
    if (!authStore.user) {
      clear()
      return
    }

    if (initializedUserId.value && initializedUserId.value !== authStore.user.uid) {
      clear()
    }

    if (initialized.value && !force) {
      return
    }

    const membershipCollection = collection(db, 'users', authStore.user.uid, 'memberships')
    const snapshot = await getServerFirstSnapshot(membershipCollection)

    if (snapshot.empty) {
      memberships.value = []
      currentSpaceId.value = buildPersonalSpaceId(authStore.user.uid)
      useLegacyPath.value = true
      initialized.value = true
      initializedUserId.value = authStore.user.uid
      return
    }

    memberships.value = snapshot.docs.map((documentSnapshot) => ({
      ...(documentSnapshot.data() as UserMembership),
      spaceId: documentSnapshot.id,
    }))

    try {
      await maybeMigratePersonalSpace(force)
    } catch (error) {
      console.warn('[spaceStore] Failed to migrate personal space:', error)
    }

    const savedSpaceId = localStorage.getItem(CURRENT_SPACE_KEY)
    const defaultSpaceId =
      memberships.value.find((membership) => membership.spaceId === savedSpaceId)?.spaceId
      ?? memberships.value.find((membership) => membership.spaceId === buildPersonalSpaceId(authStore.user!.uid))?.spaceId
      ?? memberships.value[0]?.spaceId
      ?? buildPersonalSpaceId(authStore.user.uid)

    currentSpaceId.value = defaultSpaceId
    useLegacyPath.value = false
    initialized.value = true
    initializedUserId.value = authStore.user.uid
    localStorage.setItem(CURRENT_SPACE_KEY, defaultSpaceId)
  }

  function selectSpace(spaceId: string) {
    currentSpaceId.value = spaceId
    useLegacyPath.value = false
    initialized.value = true
    localStorage.setItem(CURRENT_SPACE_KEY, spaceId)
  }

  function clear() {
    currentSpaceId.value = null
    memberships.value = []
    initialized.value = false
    useLegacyPath.value = true
    personalSpaceMigrationChecked.value = false
    initializedUserId.value = null
    localStorage.removeItem(CURRENT_SPACE_KEY)
  }

  async function maybeMigratePersonalSpace(force = false) {
    const authStore = useAuthStore()
    if (!authStore.user) return

    const migrationKey = `${PERSONAL_SPACE_MIGRATION_KEY_PREFIX}-${authStore.user.uid}`
    const alreadyMigrated = localStorage.getItem(migrationKey) === 'true'

    if ((personalSpaceMigrationChecked.value || alreadyMigrated) && !force) {
      return
    }

    await migrateCurrentUserToPersonalSpaceApi()

    personalSpaceMigrationChecked.value = true
    localStorage.setItem(migrationKey, 'true')
  }

  function getCollectionPath<T extends ScopedCollectionName>(name: T): ScopedCollectionPath<T> {
    const authStore = useAuthStore()
    if (!authStore.user) throw new Error('認証が必要です')

    if (useLegacyPath.value || !currentSpaceId.value) {
      return ['users', authStore.user.uid, name]
    }

    return ['spaces', currentSpaceId.value, name]
  }

  function getCollectionPathForSpace<T extends ScopedCollectionName>(
    name: T,
    spaceId?: string | null
  ): ScopedCollectionPath<T> {
    const authStore = useAuthStore()
    if (!authStore.user) throw new Error('認証が必要です')

    const personalSpaceId = buildPersonalSpaceId(authStore.user.uid)

    if ((useLegacyPath.value || !currentSpaceId.value) && (!spaceId || spaceId === personalSpaceId)) {
      return ['users', authStore.user.uid, name]
    }

    if (!spaceId) {
      return getCollectionPath(name)
    }

    return ['spaces', spaceId, name]
  }

  function getSmartListCountsDocPath(): SmartListCountsDocPath {
    const authStore = useAuthStore()
    if (!authStore.user) throw new Error('認証が必要です')

    if (useLegacyPath.value || !currentSpaceId.value) {
      return ['users', authStore.user.uid]
    }

    return ['spaces', currentSpaceId.value]
  }

  function getCollectionRef<T extends ScopedCollectionName>(name: T) {
    const path = getCollectionPath(name)
    return collection(db, path[0], path[1], path[2])
  }

  function getCollectionRefForSpace<T extends ScopedCollectionName>(name: T, spaceId?: string | null) {
    const path = getCollectionPathForSpace(name, spaceId)
    return collection(db, path[0], path[1], path[2])
  }

  function getSmartListCountsDocRef() {
    const path = getSmartListCountsDocPath()
    return doc(db, path[0], path[1])
  }

  function getScopedStorageKey(baseKey: string): string {
    const authStore = useAuthStore()
    const uid = authStore.user?.uid ?? 'guest'
    const scope = useLegacyPath.value || !currentSpaceId.value
      ? `legacy-${uid}`
      : currentSpaceId.value
    return `${baseKey}-${scope}`
  }

  return {
    currentSpaceId,
    memberships,
    initialized,
    useLegacyPath,
    initSpace,
    selectSpace,
    clear,
    getCollectionPath,
    getCollectionPathForSpace,
    getSmartListCountsDocPath,
    getCollectionRef,
    getCollectionRefForSpace,
    getSmartListCountsDocRef,
    getScopedStorageKey,
  }
})
