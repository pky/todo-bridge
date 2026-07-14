import { getAuth, GoogleAuthProvider, connectAuthEmulator } from 'firebase/auth'
import app, { emulatorHost, isEmulator } from './firebaseApp'

export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({
  prompt: 'select_account',
})

if (isEmulator) {
  connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true })
}
