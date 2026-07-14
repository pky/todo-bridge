import { LocalObjectStorageProvider } from './localProvider'
import { createR2ObjectStorageProvider } from './r2Provider'
import { ObjectStorageProvider } from './types'

export function isFunctionsEmulator(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return environment.FUNCTIONS_EMULATOR === 'true'
}

export function createObjectStorageProvider(
  environment: NodeJS.ProcessEnv = process.env
): ObjectStorageProvider {
  if (isFunctionsEmulator(environment)) {
    return new LocalObjectStorageProvider()
  }
  return createR2ObjectStorageProvider(environment)
}
