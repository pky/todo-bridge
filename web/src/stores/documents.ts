import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore'
import { db } from '@/services/firebase'
import {
  createDocumentCalendarEventApi,
  getDocumentAccessUrlApi,
  getDocumentTextApi,
  getDocumentThumbnailAccessUrlApi,
  retryDocumentTextApi,
  reanalyzeDocumentSuggestionsApi,
  retryDocumentThumbnailApi,
  permanentlyDeleteDocumentApi,
  restoreDocumentApi,
  trashDocumentApi,
  uploadDocument,
  type DocumentAccessResult,
  type DocumentTextResult,
} from '@/services/documentService'
import { useSpaceStore } from './space'
import { useAuthStore } from './auth'
import type {
  DocumentSuggestion,
  DocumentSuggestionStatus,
  DocumentUsage,
  FamilyDocument,
  FamilyDocumentSource,
} from '@/types'

export interface UpdateDocumentSuggestionInput {
  title: string
  value: Record<string, unknown>
  status: DocumentSuggestionStatus
}

export const useDocumentsStore = defineStore('documents', () => {
  const documents = ref<FamilyDocument[]>([])
  const selectedDocumentId = ref<string | null>(null)
  const loading = ref(false)
  const uploading = ref(false)
  const uploadFileName = ref<string | null>(null)
  const thumbnailUrls = ref<Record<string, string>>({})
  const thumbnailLoadingIds = ref<string[]>([])
  const error = ref<string | null>(null)
  const usage = ref<DocumentUsage | null>(null)
  const suggestions = ref<DocumentSuggestion[]>([])
  const suggestionsLoading = ref(false)
  const suggestionsError = ref<string | null>(null)
  const suggestionSavingIds = ref<string[]>([])
  let unsubscribeSnapshot: Unsubscribe | null = null
  let unsubscribeUsage: Unsubscribe | null = null
  let unsubscribeSuggestionSnapshot: Unsubscribe | null = null
  let subscribedSpaceId: string | null = null
  let subscribedSuggestionDocumentId: string | null = null

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
    unsubscribeUsage = onSnapshot(
      doc(db, 'spaces', spaceId, 'usage', 'documents'),
      (snapshot) => {
        if (subscribedSpaceId !== spaceId) return
        usage.value = snapshot.exists() ? snapshot.data() as DocumentUsage : null
      },
      () => {
        // 容量表示の失敗は書類一覧全体のエラーにしない
      }
    )
  }

  function unsubscribe(): void {
    unsubscribeSnapshot?.()
    unsubscribeUsage?.()
    unsubscribeSuggestions()
    unsubscribeSnapshot = null
    unsubscribeUsage = null
    subscribedSpaceId = null
    documents.value = []
    selectedDocumentId.value = null
    thumbnailUrls.value = {}
    thumbnailLoadingIds.value = []
    usage.value = null
    loading.value = false
  }

  function unsubscribeSuggestions(): void {
    unsubscribeSuggestionSnapshot?.()
    unsubscribeSuggestionSnapshot = null
    subscribedSuggestionDocumentId = null
    suggestions.value = []
    suggestionsLoading.value = false
    suggestionsError.value = null
    suggestionSavingIds.value = []
  }

  function subscribeSuggestions(documentId: string | null): void {
    if (!documentId) {
      unsubscribeSuggestions()
      return
    }
    const spaceId = requireCurrentSpaceId()
    if (unsubscribeSuggestionSnapshot
      && subscribedSuggestionDocumentId === documentId
      && subscribedSpaceId === spaceId) return
    unsubscribeSuggestions()
    suggestionsLoading.value = true
    subscribedSuggestionDocumentId = documentId
    const suggestionQuery = query(
      collection(db, 'spaces', spaceId, 'documents', documentId, 'suggestions'),
      orderBy('createdAt', 'asc')
    )
    unsubscribeSuggestionSnapshot = onSnapshot(
      suggestionQuery,
      (snapshot) => {
        if (subscribedSuggestionDocumentId !== documentId) return
        suggestions.value = snapshot.docs.map((suggestionSnapshot) => ({
          ...(suggestionSnapshot.data() as Omit<DocumentSuggestion, 'id'>),
          id: suggestionSnapshot.id,
        }))
        suggestionsLoading.value = false
      },
      (snapshotError) => {
        if (subscribedSuggestionDocumentId !== documentId) return
        suggestionsError.value = snapshotError.message
        suggestionsLoading.value = false
      }
    )
  }

  async function updateSuggestion(
    documentId: string,
    suggestionId: string,
    input: UpdateDocumentSuggestionInput
  ): Promise<void> {
    const title = input.title.trim()
    const rejectUpdate = (message: string): never => {
      suggestionsError.value = message
      throw new Error(message)
    }
    if (!title) rejectUpdate('候補のタイトルを入力してください')
    if (title.length > 500) rejectUpdate('候補のタイトルは500文字以内にしてください')
    const current = suggestions.value.find((suggestion) => suggestion.id === suggestionId)
    if (!current) rejectUpdate('更新する候補が見つかりません')
    const userId = useAuthStore().user?.uid
    if (!userId) rejectUpdate('候補を更新するにはログインが必要です')
    if (suggestionSavingIds.value.includes(suggestionId)) return

    suggestionSavingIds.value = [...suggestionSavingIds.value, suggestionId]
    suggestionsError.value = null
    try {
      await updateDoc(
        doc(db, 'spaces', requireCurrentSpaceId(), 'documents', documentId, 'suggestions', suggestionId),
        {
          title,
          value: input.value,
          status: input.status,
          acceptedBy: input.status === 'accepted' ? userId : null,
          acceptedAt: input.status === 'accepted' ? serverTimestamp() : null,
          updatedAt: serverTimestamp(),
        }
      )
    } catch (updateError) {
      suggestionsError.value = updateError instanceof Error
        ? updateError.message
        : '候補を更新できませんでした'
      throw updateError
    } finally {
      suggestionSavingIds.value = suggestionSavingIds.value.filter((id) => id !== suggestionId)
    }
  }

  async function registerCalendarEvent(
    documentId: string,
    suggestionId: string,
    input: Omit<UpdateDocumentSuggestionInput, 'status'>
  ): Promise<void> {
    await updateSuggestion(documentId, suggestionId, { ...input, status: 'pending' })
    if (suggestionSavingIds.value.includes(suggestionId)) return
    suggestionSavingIds.value = [...suggestionSavingIds.value, suggestionId]
    suggestionsError.value = null
    try {
      await createDocumentCalendarEventApi(
        requireCurrentSpaceId(),
        documentId,
        suggestionId
      )
    } catch (registrationError) {
      suggestionsError.value = registrationError instanceof Error
        ? registrationError.message
        : 'Google Calendarへ登録できませんでした'
      throw registrationError
    } finally {
      suggestionSavingIds.value = suggestionSavingIds.value.filter((id) => id !== suggestionId)
    }
  }

  async function reanalyzeSuggestions(documentId: string): Promise<number> {
    suggestionsError.value = null
    try {
      const result = await reanalyzeDocumentSuggestionsApi(requireCurrentSpaceId(), documentId)
      return result.suggestionCount
    } catch (reanalyzeError) {
      suggestionsError.value = reanalyzeError instanceof Error
        ? reanalyzeError.message
        : '候補を再抽出できませんでした'
      throw reanalyzeError
    }
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

  async function getText(documentId: string): Promise<DocumentTextResult> {
    return getDocumentTextApi(requireCurrentSpaceId(), documentId)
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

  async function retryText(documentId: string): Promise<void> {
    error.value = null
    try {
      await retryDocumentTextApi(requireCurrentSpaceId(), documentId)
    } catch (retryError) {
      error.value = retryError instanceof Error
        ? retryError.message
        : '文字を再読み取りできませんでした'
      throw retryError
    }
  }

  async function moveToTrash(documentId: string): Promise<void> {
    error.value = null
    try {
      await trashDocumentApi(requireCurrentSpaceId(), documentId)
      if (selectedDocumentId.value === documentId) selectedDocumentId.value = null
    } catch (mutationError) {
      error.value = mutationError instanceof Error
        ? mutationError.message
        : '書類をごみ箱へ移動できませんでした'
      throw mutationError
    }
  }

  async function restoreFromTrash(documentId: string): Promise<void> {
    error.value = null
    try {
      await restoreDocumentApi(requireCurrentSpaceId(), documentId)
      if (selectedDocumentId.value === documentId) selectedDocumentId.value = null
    } catch (mutationError) {
      error.value = mutationError instanceof Error
        ? mutationError.message
        : '書類を復元できませんでした'
      throw mutationError
    }
  }

  async function permanentlyDelete(documentId: string): Promise<void> {
    error.value = null
    try {
      await permanentlyDeleteDocumentApi(requireCurrentSpaceId(), documentId)
      if (selectedDocumentId.value === documentId) selectedDocumentId.value = null
    } catch (mutationError) {
      error.value = mutationError instanceof Error
        ? mutationError.message
        : '書類を完全削除できませんでした'
      throw mutationError
    }
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
    usage,
    suggestions,
    suggestionsLoading,
    suggestionsError,
    suggestionSavingIds,
    subscribe,
    unsubscribe,
    selectDocument,
    addDocument,
    getAccessUrl,
    getText,
    reloadThumbnail,
    retryThumbnail,
    retryText,
    subscribeSuggestions,
    updateSuggestion,
    registerCalendarEvent,
    reanalyzeSuggestions,
    moveToTrash,
    restoreFromTrash,
    permanentlyDelete,
  }
})
