import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/services/firebase'
import {
  getDocumentAccessUrlApi,
  getDocumentThumbnailAccessUrlApi,
  retryDocumentThumbnailApi,
  uploadDocument,
  type DocumentAccessResult,
} from '@/services/documentService'
import { useSpaceStore } from './space'
import type { FamilyDocument, FamilyDocumentSource } from '@/types'

export const useDocumentsStore = defineStore('documents', () => {
  const documents = ref<FamilyDocument[]>([])
  const selectedDocumentId = ref<string | null>(null)
  const loading = ref(false)
  const uploading = ref(false)
  const uploadFileName = ref<string | null>(null)
  const thumbnailUrls = ref<Record<string, string>>({})
  const thumbnailLoadingIds = ref<string[]>([])
  const error = ref<string | null>(null)
  let unsubscribeSnapshot: Unsubscribe | null = null
  let subscribedSpaceId: string | null = null

  async function loadThumbnailUrl(
    spaceId: string,
    documentId: string,
    force: boolean = false
  ): Promise<void> {
    if (!force && thumbnailUrls.value[documentId]) return
    if (thumbnailLoadingIds.value.includes(documentId)) return
    thumbnailLoadingIds.value = [...thumbnailLoadingIds.value, documentId]
    try {
      const result = await getDocumentThumbnailAccessUrlApi(spaceId, documentId)
      if (subscribedSpaceId !== spaceId) return
      thumbnailUrls.value = { ...thumbnailUrls.value, [documentId]: result.url }
    } catch {
      // サムネイル失敗は一覧全体のエラーにしない
    } finally {
      thumbnailLoadingIds.value = thumbnailLoadingIds.value.filter((id) => id !== documentId)
    }
  }

  function syncThumbnailUrls(spaceId: string, nextDocuments: FamilyDocument[]): void {
    const availableIds = new Set(
      nextDocuments
        .filter((document) => document.previewStatus === 'completed' && document.thumbnailObjectKey)
        .map((document) => document.id)
    )
    thumbnailUrls.value = Object.fromEntries(
      Object.entries(thumbnailUrls.value).filter(([documentId]) => availableIds.has(documentId))
    )
    availableIds.forEach((documentId) => {
      void loadThumbnailUrl(spaceId, documentId)
    })
  }

  const selectedDocument = computed(() => (
    documents.value.find((document) => document.id === selectedDocumentId.value) ?? null
  ))

  function requireCurrentSpaceId(): string {
    const spaceId = useSpaceStore().currentSpaceId
    if (!spaceId) throw new Error('書類を保存するスペースが選択されていません')
    return spaceId
  }

  function subscribe(): void {
    const spaceId = requireCurrentSpaceId()
    if (unsubscribeSnapshot && subscribedSpaceId === spaceId) return
    unsubscribe()
    loading.value = true
    error.value = null
    subscribedSpaceId = spaceId
    const documentQuery = query(
      collection(db, 'spaces', spaceId, 'documents'),
      orderBy('createdAt', 'desc')
    )
    unsubscribeSnapshot = onSnapshot(
      documentQuery,
      (snapshot) => {
        if (subscribedSpaceId !== spaceId) return
        const nextDocuments = snapshot.docs.map((documentSnapshot) => ({
          ...(documentSnapshot.data() as Omit<FamilyDocument, 'id'>),
          id: documentSnapshot.id,
        }))
        documents.value = nextDocuments
        syncThumbnailUrls(spaceId, nextDocuments)
        if (selectedDocumentId.value
          && !documents.value.some((document) => document.id === selectedDocumentId.value)) {
          selectedDocumentId.value = null
        }
        loading.value = false
      },
      (snapshotError) => {
        if (subscribedSpaceId !== spaceId) return
        error.value = snapshotError.message
        loading.value = false
      }
    )
  }

  function unsubscribe(): void {
    unsubscribeSnapshot?.()
    unsubscribeSnapshot = null
    subscribedSpaceId = null
    documents.value = []
    selectedDocumentId.value = null
    thumbnailUrls.value = {}
    thumbnailLoadingIds.value = []
    loading.value = false
  }

  function selectDocument(documentId: string | null): void {
    selectedDocumentId.value = documentId
  }

  async function addDocument(file: File, source: FamilyDocumentSource): Promise<string> {
    const spaceId = requireCurrentSpaceId()
    uploading.value = true
    uploadFileName.value = file.name
    error.value = null
    try {
      const documentId = await uploadDocument(spaceId, file, source)
      selectedDocumentId.value = documentId
      return documentId
    } catch (uploadError) {
      error.value = uploadError instanceof Error ? uploadError.message : '書類の追加に失敗しました'
      throw uploadError
    } finally {
      uploading.value = false
      uploadFileName.value = null
    }
  }

  async function getAccessUrl(documentId: string): Promise<DocumentAccessResult> {
    return getDocumentAccessUrlApi(requireCurrentSpaceId(), documentId)
  }

  async function reloadThumbnail(documentId: string): Promise<void> {
    const spaceId = requireCurrentSpaceId()
    const nextUrls = { ...thumbnailUrls.value }
    delete nextUrls[documentId]
    thumbnailUrls.value = nextUrls
    await loadThumbnailUrl(spaceId, documentId, true)
  }

  async function retryThumbnail(documentId: string): Promise<void> {
    const spaceId = requireCurrentSpaceId()
    await retryDocumentThumbnailApi(spaceId, documentId)
    await reloadThumbnail(documentId)
  }

  return {
    documents,
    selectedDocumentId,
    selectedDocument,
    loading,
    uploading,
    uploadFileName,
    thumbnailUrls,
    thumbnailLoadingIds,
    error,
    subscribe,
    unsubscribe,
    selectDocument,
    addDocument,
    getAccessUrl,
    reloadThumbnail,
    retryThumbnail,
  }
})
