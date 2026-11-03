import { describe, expect, it, vi } from 'vitest'

const storageApi = vi.hoisted(() => {
  const instance: { maxOperationRetryTime?: number } = {}
  return {
    instance,
    getStorage: vi.fn(() => instance),
    connectStorageEmulator: vi.fn(),
  }
})

vi.mock('firebase/app', () => ({ initializeApp: vi.fn(() => ({ name: 'demo-app' })) }))
vi.mock('firebase/storage', () => storageApi)
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({})),
  GoogleAuthProvider: class {},
  connectAuthEmulator: vi.fn(),
}))
vi.mock('firebase/firestore', () => ({
  initializeFirestore: vi.fn(() => ({})),
  connectFirestoreEmulator: vi.fn(),
  persistentLocalCache: vi.fn(),
  persistentMultipleTabManager: vi.fn(),
  memoryLocalCache: vi.fn(),
}))
vi.mock('firebase/functions', () => ({ getFunctions: vi.fn(() => ({})), connectFunctionsEmulator: vi.fn() }))

describe('Storage SDKの再試行時間', () => {
  it('1回の取得が60秒のleaseを超えないよう maxOperationRetryTime を30000msにする', async () => {
    const { storage } = await import('@/services/firebase')
    expect((storage as unknown as { maxOperationRetryTime?: number }).maxOperationRetryTime).toBe(30000)
  })
})
