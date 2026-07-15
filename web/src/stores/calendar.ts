import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { httpsCallable } from 'firebase/functions'
import { doc, onSnapshot } from 'firebase/firestore'
import { db, functions } from '@/services/firebase'
import { useAuthStore } from './auth'
import { useSpaceStore } from './space'

export const CALENDAR_AUTO_CATEGORIES = [
  'school_childcare',
  'medical',
  'insurance_tax',
  'home_warranty',
  'billing_receipt',
] as const

export type CalendarAutoCategory = typeof CALENDAR_AUTO_CATEGORIES[number]

export const useCalendarStore = defineStore('calendar', () => {
  const serviceAccountEmail = ref('')
  const calendarId = ref('')
  const calendarName = ref('')
  const autoRegistrationEnabled = ref(false)
  const autoRegistrationCategories = ref<CalendarAutoCategory[]>(['school_childcare'])
  const autoRegistrationMinConfidence = ref(0.9)
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
    autoRegistrationEnabled.value = false
    autoRegistrationCategories.value = ['school_childcare']
    autoRegistrationMinConfidence.value = 0.9
    const settingsRef = getCalendarSettingsDocRef()
    _unsubscribe = onSnapshot(settingsRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data()
        calendarId.value = data.calendarId ?? ''
        calendarName.value = data.calendarName ?? ''
        autoRegistrationEnabled.value = data.calendarAutoRegistrationEnabled === true
        autoRegistrationCategories.value = Array.isArray(data.calendarAutoRegistrationCategories)
          ? data.calendarAutoRegistrationCategories.filter(
            (value: unknown): value is CalendarAutoCategory => (
              typeof value === 'string'
                && CALENDAR_AUTO_CATEGORIES.includes(value as CalendarAutoCategory)
            )
          )
          : ['school_childcare']
        autoRegistrationMinConfidence.value =
          typeof data.calendarAutoRegistrationMinConfidence === 'number'
            ? data.calendarAutoRegistrationMinConfidence
            : 0.9
      } else {
        calendarId.value = ''
        calendarName.value = ''
        autoRegistrationEnabled.value = false
        autoRegistrationCategories.value = ['school_childcare']
        autoRegistrationMinConfidence.value = 0.9
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
      autoRegistrationEnabled.value = false
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Google Calendar設定を解除できませんでした'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function saveAutomationConfig(): Promise<void> {
    const spaceStore = useSpaceStore()
    if (!spaceStore.currentSpaceId || spaceStore.useLegacyPath) {
      throw new Error('自動登録は家族スペースで設定してください')
    }
    loading.value = true
    error.value = null
    try {
      const saveAutomationConfigFn = httpsCallable<
        {
          spaceId: string
          useLegacyPath: false
          enabled: boolean
          categories: CalendarAutoCategory[]
          minConfidence: number
        },
        {
          success: boolean
          enabled: boolean
          categories: CalendarAutoCategory[]
          minConfidence: number
        }
      >(functions, 'saveGoogleCalendarAutomationConfig')
      const result = await saveAutomationConfigFn({
        spaceId: spaceStore.currentSpaceId,
        useLegacyPath: false,
        enabled: autoRegistrationEnabled.value,
        categories: autoRegistrationCategories.value,
        minConfidence: autoRegistrationMinConfidence.value,
      })
      autoRegistrationEnabled.value = result.data.enabled
      autoRegistrationCategories.value = result.data.categories
      autoRegistrationMinConfidence.value = result.data.minConfidence
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Google Calendar自動登録設定を保存できませんでした'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function registerTask(taskId: string): Promise<{ eventId: string; alreadyRegistered: boolean }> {
    const spaceId = useSpaceStore().currentSpaceId
    if (!spaceId) throw new Error('家族スペースが選択されていません')
    if (spaceId.startsWith('personal_')) {
      throw new Error('個人タスクは家族のGoogle Calendarへ登録できません')
    }
    loading.value = true
    error.value = null
    try {
      const registerTaskFn = httpsCallable<
        { spaceId: string; taskId: string },
        { success: boolean; eventId: string; alreadyRegistered: boolean }
      >(functions, 'createTaskCalendarEvent')
      const result = await registerTaskFn({ spaceId, taskId })
      return {
        eventId: result.data.eventId,
        alreadyRegistered: result.data.alreadyRegistered,
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Google Calendarへ登録できませんでした'
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
    autoRegistrationEnabled.value = false
  }

  return {
    serviceAccountEmail,
    calendarId,
    calendarName,
    autoRegistrationEnabled,
    autoRegistrationCategories,
    autoRegistrationMinConfidence,
    loading,
    error,
    configured,
    subscribe,
    unsubscribe,
    loadServiceConfig,
    saveConfig,
    clearConfig,
    saveAutomationConfig,
    registerTask,
  }
})
