import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { httpsCallable } from 'firebase/functions'
import { doc, onSnapshot, setDoc, getDoc } from 'firebase/firestore'
import { db, functions } from '@/services/firebase'
import { useAuthStore } from './auth'
import { useSpaceStore } from './space'

// Google Identity Services の型
interface GoogleCodeClient {
  requestCode: () => void
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initCodeClient: (config: {
            client_id: string
            scope: string
            ux_mode: 'popup' | 'redirect'
            callback: (response: { code?: string; error?: string }) => void
          }) => GoogleCodeClient
        }
      }
    }
  }
}

// Google Identity Services スクリプトを動的ロード
function loadGsiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google Identity Servicesのロードに失敗しました'))
    document.head.appendChild(script)
  })
}

// authorization code を取得する（ポップアップ）
function getGoogleAuthCode(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/calendar.events',
      ux_mode: 'popup',
      callback: (response) => {
        if (response.code) {
          resolve(response.code)
        } else {
          reject(new Error(response.error || 'カレンダー連携がキャンセルされました'))
        }
      },
    })
    client.requestCode()
  })
}

export const useCalendarStore = defineStore('calendar', () => {
  const connectedEmail = ref<string | null>(null)
  const calendarId = ref<string>('primary')
  const loading = ref(false)
  const error = ref<string | null>(null)
  // APIキー設定
  const clientId = ref<string>('')
  const apiConfigSaving = ref(false)
  const apiConfigSaved = ref(false)

  let _unsubscribe: (() => void) | null = null

  const connected = computed(() => connectedEmail.value !== null)
  const apiConfigured = computed(() => clientId.value !== '')

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

  // Firestoreのユーザードキュメントを監視して連携状態を同期
  function subscribe(): void {
    if (_unsubscribe) _unsubscribe()
    const settingsRef = getCalendarSettingsDocRef()
    _unsubscribe = onSnapshot(settingsRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data()
        connectedEmail.value = data.calendarEmail ?? null
        calendarId.value = data.calendarId ?? 'primary'
      } else {
        connectedEmail.value = null
        calendarId.value = 'primary'
      }
    })
    // APIキー設定を読み込む
    void loadApiConfig()
  }

  // appConfig/googleCalendar からAPIキー設定を読み込む
  async function loadApiConfig(): Promise<void> {
    const configRef = doc(db, 'appConfig', 'googleCalendar')
    const snap = await getDoc(configRef)
    if (snap.exists()) {
      clientId.value = snap.data().clientId ?? ''
    }
  }

  // APIキー設定を保存する（Client IDのみフロントエンドで管理。Client SecretはCloud Functionsが使用）
  async function saveApiConfig(newClientId: string, newClientSecret: string): Promise<void> {
    apiConfigSaving.value = true
    apiConfigSaved.value = false
    try {
      const configRef = doc(db, 'appConfig', 'googleCalendar')
      await setDoc(configRef, {
        clientId: newClientId,
        clientSecret: newClientSecret,
      })
      clientId.value = newClientId
      apiConfigSaved.value = true
      setTimeout(() => { apiConfigSaved.value = false }, 3000)
    } finally {
      apiConfigSaving.value = false
    }
  }

  function unsubscribe(): void {
    _unsubscribe?.()
    _unsubscribe = null
    connectedEmail.value = null
    calendarId.value = 'primary'
  }

  // Google Identity Services でOAuth codeを取得し、Cloud Functionに渡す
  async function connect(): Promise<void> {
    const spaceStore = useSpaceStore()
    if (!clientId.value) {
      error.value = '先にAPIキーを設定してください'
      return
    }
    loading.value = true
    error.value = null
    try {
      await loadGsiScript()
      const code = await getGoogleAuthCode(clientId.value)
      const connectFn = httpsCallable<
        { code: string; spaceId?: string | null; useLegacyPath: boolean },
        { email: string }
      >(
        functions, 'connectGoogleCalendar'
      )
      const result = await connectFn({
        code,
        spaceId: spaceStore.currentSpaceId,
        useLegacyPath: spaceStore.useLegacyPath,
      })
      connectedEmail.value = result.data.email
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'カレンダー連携に失敗しました'
      throw e
    } finally {
      loading.value = false
    }
  }

  // 連携解除
  async function disconnect(): Promise<void> {
    const spaceStore = useSpaceStore()
    loading.value = true
    error.value = null
    try {
      const disconnectFn = httpsCallable<
        { spaceId?: string | null; useLegacyPath: boolean },
        void
      >(functions, 'disconnectGoogleCalendar')
      await disconnectFn({
        spaceId: spaceStore.currentSpaceId,
        useLegacyPath: spaceStore.useLegacyPath,
      })
      connectedEmail.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'カレンダー連携解除に失敗しました'
      throw e
    } finally {
      loading.value = false
    }
  }

  return {
    connectedEmail,
    calendarId,
    loading,
    error,
    connected,
    clientId,
    apiConfigured,
    apiConfigSaving,
    apiConfigSaved,
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    saveApiConfig,
    loadApiConfig,
  }
})
