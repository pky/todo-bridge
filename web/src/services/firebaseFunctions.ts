import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import app, { isEmulator } from './firebaseApp'

export const functions = getFunctions(app, 'asia-northeast1')

if (isEmulator) {
  connectFunctionsEmulator(functions, 'localhost', 5001)
}
