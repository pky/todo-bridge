import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Unsubscribe } from 'firebase/firestore'
import type { DocumentTaskLink } from '@/types'
import {
  linkDocumentToTaskApi,
  subscribeTaskDocumentLinks,
  unlinkDocumentFromTaskApi,
} from '@/services/documentService'
import { useAuthStore } from './auth'
import { useSpaceStore } from './space'

export const useDocumentTaskLinksStore = defineStore('documentTaskLinks', () => {
  const links = ref<DocumentTaskLink[]>([])
  const subscribedTaskId = ref<string | null>(null)
  const loading = ref(false)
  const mutatingDocumentIds = ref<string[]>([])
  const error = ref<string | null>(null)
  let unsubscribeSnapshot: Unsubscribe | null = null
  let subscribedSpaceId: string | null = null

  const documentIds = computed(() => links.value.map((link) => link.documentId))

  function requireContext(): { spaceId: string; userId: string } {
    const spaceId = useSpaceStore().currentSpaceId
    const userId = useAuthStore().user?.uid
    if (!spaceId) throw new Error('家族スペースが選択されていません')
    if (!userId) throw new Error('認証が必要です')
    return { spaceId, userId }
  }

  function subscribe(taskId: string | null): void {
    const spaceId = useSpaceStore().currentSpaceId
    if (!taskId || !spaceId) {
      unsubscribe()
      return
    }
    if (unsubscribeSnapshot
      && subscribedTaskId.value === taskId
      && subscribedSpaceId === spaceId) return
    unsubscribe()
    loading.value = true
    error.value = null
    subscribedTaskId.value = taskId
    subscribedSpaceId = spaceId
    unsubscribeSnapshot = subscribeTaskDocumentLinks(
      spaceId,
      taskId,
      (nextLinks) => {
        if (subscribedTaskId.value !== taskId || subscribedSpaceId !== spaceId) return
        links.value = nextLinks
        loading.value = false
      },
      (snapshotError) => {
        if (subscribedTaskId.value !== taskId || subscribedSpaceId !== spaceId) return
        error.value = snapshotError.message
        loading.value = false
      }
    )
  }

  function unsubscribe(): void {
    unsubscribeSnapshot?.()
    unsubscribeSnapshot = null
    subscribedTaskId.value = null
    subscribedSpaceId = null
    links.value = []
    loading.value = false
    mutatingDocumentIds.value = []
    error.value = null
  }

  async function linkDocuments(taskId: string, nextDocumentIds: string[]): Promise<void> {
    const { spaceId } = requireContext()
    const existingDocumentIds = subscribedTaskId.value === taskId ? documentIds.value : []
    const uniqueDocumentIds = [...new Set(nextDocumentIds)]
      .filter((documentId) => !existingDocumentIds.includes(documentId))
    if (uniqueDocumentIds.length === 0) return
    mutatingDocumentIds.value = [...new Set([
      ...mutatingDocumentIds.value,
      ...uniqueDocumentIds,
    ])]
    error.value = null
    try {
      await Promise.all(uniqueDocumentIds.map((documentId) => (
        linkDocumentToTaskApi(spaceId, taskId, documentId)
      )))
    } catch (linkError) {
      error.value = linkError instanceof Error ? linkError.message : '書類を紐づけられませんでした'
      throw linkError
    } finally {
      mutatingDocumentIds.value = mutatingDocumentIds.value.filter(
        (documentId) => !uniqueDocumentIds.includes(documentId)
      )
    }
  }

  async function unlinkDocument(taskId: string, documentId: string): Promise<void> {
    const { spaceId } = requireContext()
    if (mutatingDocumentIds.value.includes(documentId)) return
    mutatingDocumentIds.value = [...mutatingDocumentIds.value, documentId]
    error.value = null
    try {
      await unlinkDocumentFromTaskApi(spaceId, taskId, documentId)
    } catch (unlinkError) {
      error.value = unlinkError instanceof Error ? unlinkError.message : '書類の紐づけを解除できませんでした'
      throw unlinkError
    } finally {
      mutatingDocumentIds.value = mutatingDocumentIds.value.filter((id) => id !== documentId)
    }
  }

  return {
    links,
    documentIds,
    subscribedTaskId,
    loading,
    mutatingDocumentIds,
    error,
    subscribe,
    unsubscribe,
    linkDocuments,
    unlinkDocument,
  }
})
