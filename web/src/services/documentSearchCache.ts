import type { DocumentSearchIndexArtifact } from './documentService'

const DATABASE_NAME = 'rertm-document-search'
const DATABASE_VERSION = 1
const STORE_NAME = 'indexes'

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function runRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  const database = await openDatabase()
  if (!database) return null
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = operation(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

export async function getCachedDocumentSearchIndex(
  spaceId: string
): Promise<DocumentSearchIndexArtifact | null> {
  return await runRequest<DocumentSearchIndexArtifact>('readonly', (store) => store.get(spaceId))
    ?? null
}

export async function putCachedDocumentSearchIndex(
  artifact: DocumentSearchIndexArtifact
): Promise<void> {
  await runRequest('readwrite', (store) => store.put(artifact, artifact.spaceId))
}

export async function deleteCachedDocumentSearchIndex(spaceId: string): Promise<void> {
  await runRequest('readwrite', (store) => store.delete(spaceId))
}

export async function clearDocumentSearchCache(): Promise<void> {
  await runRequest('readwrite', (store) => store.clear())
}
