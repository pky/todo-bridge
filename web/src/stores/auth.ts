import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth, googleProvider } from '@/services/firebaseAuth'
import type { AppUser } from '@/types'
import { mapFirebaseUser } from '@/types'
import { validateCurrentUserAccessApi } from '@/services/cloudFunctionsService'

export const useAuthStore = defineStore('auth', () => {
  const ACCESS_VALIDATION_TIMEOUT_MS = 5000
  const user = ref<AppUser | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)
  const accessValidatedUid = ref<string | null>(null)
  let validatingUid: string | null = null
  let accessValidationPromise: Promise<void> | null = null

  const isAuthenticated = computed(() => !!user.value)

  function formatAccessError(error: unknown): Error {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : ''
    if (errorCode === 'functions/permission-denied') {
      return new Error('このアカウントは利用を許可されていません')
    }
    return error instanceof Error ? error : new Error('ログインに失敗しました')
  }

  function shouldUseRedirectAuth(): boolean {
    if (typeof navigator === 'undefined') return false
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  }

  async function validateAuthorizedUser(firebaseUser: User | null) {
    if (!firebaseUser) {
      user.value = null
      accessValidatedUid.value = null
      return
    }

    if (accessValidatedUid.value === firebaseUser.uid) {
      user.value = mapFirebaseUser(firebaseUser)
      return
    }

    if (accessValidationPromise && validatingUid === firebaseUser.uid) {
      await accessValidationPromise
      return
    }

    validatingUid = firebaseUser.uid
    accessValidationPromise = (async () => {
      try {
        await validateCurrentUserAccessApi()
        user.value = mapFirebaseUser(firebaseUser)
        accessValidatedUid.value = firebaseUser.uid
      } catch (error) {
        user.value = null
        accessValidatedUid.value = null
        await signOut(auth)
        throw formatAccessError(error)
      }
    })()

    try {
      await accessValidationPromise
    } finally {
      if (validatingUid === firebaseUser.uid) {
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

    // 初期表示は先に進めつつ、権限チェックは裏で継続する
    user.value = mapFirebaseUser(firebaseUser)

    const validationPromise = validateAuthorizedUser(firebaseUser).catch((validationError) => {
      error.value = validationError instanceof Error ? validationError.message : 'ログインに失敗しました'
      throw validationError
    })

    const timeoutPromise = new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), ACCESS_VALIDATION_TIMEOUT_MS)
    })

    await Promise.race([validationPromise, timeoutPromise])
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

      void getRedirectResult(auth)
        .then(async (redirectResult) => {
          if (redirectResult?.user) {
            await validateAuthorizedUser(redirectResult.user)
          }
        })
        .catch((redirectError) => {
          error.value = formatAccessError(redirectError).message
        })
    })
  }

  async function loginWithGoogle() {
    loading.value = true
    error.value = null
    try {
      if (shouldUseRedirectAuth()) {
        await signInWithRedirect(auth, googleProvider)
        return
      }
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

  async function logout() {
    loading.value = true
    error.value = null
    try {
      await signOut(auth)
      user.value = null
      accessValidatedUid.value = null
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
    initAuth,
    loginWithGoogle,
    logout,
  }
})
