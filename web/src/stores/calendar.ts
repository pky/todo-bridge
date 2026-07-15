import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { httpsCallable } from 'firebase/functions'
import { doc, onSnapshot } from 'firebase/firestore'
import { db, functions } from '@/services/firebase'
import { useAuthStore } from './auth'
import { useSpaceStore } from './space'

export const useCalendarStore = defineStore('calendar', () => {
  const serviceAccountEmail = ref('')
  const calendarId = ref('')
  const calendarName = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  let _unsubscribe: (() => void) | null = null

  const configured = computed(() => calendarId.value !== '')

  function getCalendarSettingsDocRef() {
    const authStore = useAuthStore()
    const spaceStore = useSpaceStore()
    if (!authStore.user) {
      throw new Error('認証が必要です')
    }

    if (spaceStore.useLegacyPath || !spaceStore.currentSpaceId) {
      return doc(db, 'users', authStore.user.uid)
    }

    return doc(db, 'spaces', spaceStore.currentSpaceId, 'settings', 'integrations')
  }

  function calendarScopeInput() {
    const spaceStore = useSpaceStore()
    return {
      spaceId: spaceStore.currentSpaceId,
      useLegacyPath: spaceStore.useLegacyPath,
    }
  }

  function subscribe(): void {
    if (_unsubscribe) _unsubscribe()
    calendarId.value = ''
    calendarName.value = ''
    const settingsRef = getCalendarSettingsDocRef()
    _unsubscribe = onSnapshot(settingsRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data()
        calendarId.value = data.calendarId ?? ''
        calendarName.value = data.calendarName ?? ''
      } else {
        calendarId.value = ''
        calendarName.value = ''
      }
    })
    void loadServiceConfig()
  }

  async function loadServiceConfig(): Promise<void> {
    try {
      const getConfig = httpsCallable<Record<string, never>, { serviceAccountEmail: string }>(
        functions,
        'getGoogleCalendarServiceConfig'
      )
      const result = await getConfig({})
      serviceAccountEmail.value = result.data.serviceAccountEmail
    } catch (e) {
      serviceAccountEmail.value = ''
      error.value = e instanceof Error ? e.message : 'サービスアカウントを確認できませんでした'
    }
  }

  async function saveConfig(nextCalendarId: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const saveConfigFn = httpsCallable<
        { spaceId?: string | null; useLegacyPath: boolean; calendarId: string },
        { success: boolean; calendarId: string; calendarName: string }
      >(functions, 'saveGoogleCalendarConfig')
      const result = await saveConfigFn({
        ...calendarScopeInput(),
        calendarId: nextCalendarId,
      })
      calendarId.value = result.data.calendarId
      calendarName.value = result.data.calendarName
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Google Calendar設定を保存できませんでした'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function clearConfig(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const clearConfigFn = httpsCallable<
        { spaceId?: string | null; useLegacyPath: boolean },
        void
      >(functions, 'clearGoogleCalendarConfig')
      await clearConfigFn(calendarScopeInput())
      calendarId.value = ''
      calendarName.value = ''
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Google Calendar設定を解除できませんでした'
      throw e
    } finally {
      loading.value = false
    }
  }

  function unsubscribe(): void {
    _unsubscribe?.()
    _unsubscribe = null
    calendarId.value = ''
    calendarName.value = ''
  }

  return {
    serviceAccountEmail,
    calendarId,
    calendarName,
    loading,
    error,
    configured,
    subscribe,
    unsubscribe,
    loadServiceConfig,
    saveConfig,
    clearConfig,
  }
})
