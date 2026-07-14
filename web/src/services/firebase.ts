import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth'
import {
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
} from 'firebase/firestore'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import app, { emulatorHost, isEmulator } from './firebaseApp'

export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

// エミュレータ使用時はメモリキャッシュ、本番環境は永続化キャッシュ（IndexedDB）を使用
// 永続化キャッシュにより2回目以降のアクセスで読み取り数が大幅に削減される
export const db = initializeFirestore(app, {
  localCache: isEmulator
    ? memoryLocalCache()
    : persistentLocalCache({
        tabManager: persistentMultipleTabManager()
      })
})

export const functions = getFunctions(app, 'asia-northeast1')

// エミュレータ接続（開発・テスト環境用）
if (isEmulator) {
  connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true })
  connectFirestoreEmulator(db, emulatorHost, 8080)
  connectFunctionsEmulator(functions, emulatorHost, 5001)
}

export default app
