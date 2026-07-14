import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import app, { emulatorHost, isEmulator } from './firebaseApp'

export const functions = getFunctions(app, 'asia-northeast1')

if (isEmulator) {
  connectFunctionsEmulator(functions, emulatorHost, 5001)
}
