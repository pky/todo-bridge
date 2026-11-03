import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { signInAnonymously, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth, googleProvider } from '@/services/firebaseAuth'
import type { AppUser } from '@/types'
import { mapFirebaseUser } from '@/types'
import { validateCurrentUserAccessApi } from '@/services/cloudFunctionsService'
import { clearDocumentSearchCache } from '@/services/documentSearchCache'

const isEmulator = import.meta.env.VITE_USE_EMULATOR === 'true'

export const useAuthStore = defineStore('auth', () => {
  const ACCESS_VALIDATION_TIMEOUT_MS = 5000
  const INITIAL_CLAIMS_TIMEOUT_MS = 10000
  const user = ref<AppUser | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  const accessValidatedUid = ref<string | null>(null)
  const accessMode = ref<'full' | 'newsViewer' | null>(null)
  let validationGeneration = 0
  let validatingUid: string | null = null
  let accessValidationPromise: Promise<void> | null = null
  let initialClaimsPromise: Promise<void> | null = null

  const isAuthenticated = computed(() => !!user.value)

  async function clearSearchCacheSafely(): Promise<void> {
    try {
      await clearDocumentSearchCache()
    } catch {
      // IndexedDBを利用できない環境でも認証処理は継続する
    }
  }

  function formatAccessError(error: unknown): Error {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : ''
    if (errorCode === 'functions/permission-denied') {
      return new Error('このアカウントは利用を許可されていません')
    }
    return error instanceof Error ? error : new Error('ログインに失敗しました')
  }

  async function validateAuthorizedUser(
    firebaseUser: User | null,
    allowInitialDisplay = false,
    onInitialClaimsResolved?: () => void,
  ) {
    if (!firebaseUser) {
      validationGeneration += 1
      validatingUid = null
      accessValidationPromise = null
      user.value = null
      accessValidatedUid.value = null
      accessMode.value = null
      await clearSearchCacheSafely()
      return
    }

    if (accessValidatedUid.value === firebaseUser.uid) {
      user.value = mapFirebaseUser(firebaseUser)
      return
    }

    if (accessValidationPromise && validatingUid === firebaseUser.uid) {
      const validationPromise = accessValidationPromise
      await initialClaimsPromise
      onInitialClaimsResolved?.()
      await validationPromise
      return
    }

    if (user.value?.uid !== firebaseUser.uid) {
      user.value = null
      accessValidatedUid.value = null
      accessMode.value = null
    }

    const generation = ++validationGeneration
    validatingUid = firebaseUser.uid
    let resolveInitialClaims!: () => void
    initialClaimsPromise = new Promise<void>((resolve) => { resolveInitialClaims = resolve })
    accessValidationPromise = (async () => {
      try {
        let isNewsViewer = false
        try {
          const token = await firebaseUser.getIdTokenResult()
          isNewsViewer = token.claims.newsRole === 'viewer'
        } catch {
          // claimを確認できない場合は従来の利用許可検証へ進む。
        } finally {
          resolveInitialClaims()
          onInitialClaimsResolved?.()
        }
        // ログアウト・UID切替前のclaimや利用許可の応答を破棄する。
        if (generation !== validationGeneration) return
        accessMode.value = isNewsViewer ? 'newsViewer' : 'full'
        if (!isNewsViewer) {
          // claim確認後に限り、従来の初期表示と利用許可検証を並行する。
          if (allowInitialDisplay) user.value = mapFirebaseUser(firebaseUser)
          await validateCurrentUserAccessApi()
        }
        if (generation !== validationGeneration) return
        user.value = mapFirebaseUser(firebaseUser)
        accessValidatedUid.value = firebaseUser.uid
      } catch (error) {
        if (generation !== validationGeneration) return
        user.value = null
        accessValidatedUid.value = null
        accessMode.value = null
        await signOut(auth)
        throw formatAccessError(error)
      }
    })()

    try {
      await accessValidationPromise
    } finally {
      if (generation === validationGeneration) {
        validatingUid = null
        accessValidationPromise = null
      }
    }
  }

  async function waitForInitialValidation(firebaseUser: User | null): Promise<void> {
    if (!firebaseUser) {
      await validateAuthorizedUser(firebaseUser)
      return
    }

    let resolveClaims!: () => void
    const claimsResolved = new Promise<void>((resolve) => { resolveClaims = resolve })
    const validationPromise = validateAuthorizedUser(firebaseUser, true, resolveClaims).catch((validationError) => {
      error.value = validationError instanceof Error ? validationError.message : 'ログインに失敗しました'
      throw validationError
    })

    let claimsTimeout: number | undefined
    try {
      // 初期化だけを10秒で解放し、同じclaim取得と利用許可判定は継続する。
      const claimsReady = await Promise.race([
        Promise.race([claimsResolved, validationPromise]).then(() => true),
        new Promise<boolean>((resolve) => {
          claimsTimeout = window.setTimeout(() => resolve(false), INITIAL_CLAIMS_TIMEOUT_MS)
        }),
      ])
      if (!claimsReady) return
    } finally {
      window.clearTimeout(claimsTimeout)
    }

    // claim待機を終えてから、従来の利用許可検証に5秒の猶予を与える。
    let validationTimeout: number | undefined
    try {
      const timeoutPromise = new Promise<void>((resolve) => {
        validationTimeout = window.setTimeout(() => resolve(), ACCESS_VALIDATION_TIMEOUT_MS)
      })
      await Promise.race([validationPromise, timeoutPromise])
    } finally {
      window.clearTimeout(validationTimeout)
    }
  }

  function initAuth() {
    return new Promise<void>((resolve) => {
      // E2Eテスト用のモック認証チェック
      const mockAuthState = localStorage.getItem('mock-auth-state')
      if (mockAuthState) {
        try {
          const parsed = JSON.parse(mockAuthState)
          if (parsed.user) {
            user.value = parsed.user
            loading.value = false
            resolve()
            return
          }
        } catch {
          // モック状態のパースに失敗した場合は通常の認証フローへ
        }
      }
      let resolved = false
      const resolveOnce = () => {
        if (resolved) return
        resolved = true
        resolve()
      }

      onAuthStateChanged(auth, async (firebaseUser) => {
        try {
          error.value = null
          await waitForInitialValidation(firebaseUser)
        } catch (validationError) {
          error.value = validationError instanceof Error ? validationError.message : 'ログインに失敗しました'
        } finally {
          loading.value = false
          resolveOnce()
        }
      })
    })
  }

  async function loginWithGoogle() {
    loading.value = true
    error.value = null
    try {
      const result = await signInWithPopup(auth, googleProvider)
      await validateAuthorizedUser(result.user)
    } catch (e) {
      const formattedError = formatAccessError(e)
      error.value = formattedError.message
      throw formattedError
    } finally {
      loading.value = false
    }
  }

  async function loginForLocalDevelopment() {
    if (!isEmulator) {
      throw new Error('ローカル開発ログインはEmulatorでのみ利用できます')
    }
    loading.value = true
    error.value = null
    try {
      const result = await signInAnonymously(auth)
      await validateAuthorizedUser(result.user)
    } catch (e) {
      const formattedError = formatAccessError(e)
      error.value = formattedError.message
      throw formattedError
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    validationGeneration += 1
    validatingUid = null
    accessValidationPromise = null
    loading.value = true
    error.value = null
    try {
      await clearSearchCacheSafely()
      await signOut(auth)
      user.value = null
      accessValidatedUid.value = null
      accessMode.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'ログアウトに失敗しました'
      throw e
    } finally {
      loading.value = false
    }
  }

  return {
    user,
    loading,
    error,
    isAuthenticated,
    accessMode,
    initAuth,
    loginWithGoogle,
    loginForLocalDevelopment,
    logout,
  }
})
