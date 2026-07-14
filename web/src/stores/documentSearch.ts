import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  downloadDocumentSearchIndex,
  getDocumentSearchIndexApi,
  type DocumentSearchIndexArtifact,
  type DocumentSearchIndexEntry,
} from '@/services/documentService'
import {
  deleteCachedDocumentSearchIndex,
  getCachedDocumentSearchIndex,
  putCachedDocumentSearchIndex,
} from '@/services/documentSearchCache'
import { useSpaceStore } from './space'

export interface DocumentSearchResult {
  documentId: string
  name: string
  pageNumber: number | null
  excerpt: string
}

const categoryLabels: Record<DocumentSearchIndexEntry['category'], string> = {
  school_childcare: '学校 保育',
  medical: '医療',
  insurance_tax: '保険 税',
  home_warranty: '住居 保証',
  billing_receipt: '請求 領収',
  contact: '連絡先',
  other: '未分類',
}

export function normalizeDocumentSearchQuery(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/\s+/g, ' ').trim()
}

function createExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= 100) return compact
  return `${compact.slice(0, 100)}…`
}

function searchArtifact(
  artifact: DocumentSearchIndexArtifact,
  query: string
): DocumentSearchResult[] {
  const terms = normalizeDocumentSearchQuery(query).split(' ').filter(Boolean)
  if (terms.length === 0) return []
  const results: DocumentSearchResult[] = []
  artifact.entries.forEach((entry) => {
    const metadataText = `${entry.normalizedName} ${categoryLabels[entry.category]}`
    if (terms.every((term) => metadataText.includes(term))) {
      results.push({
        documentId: entry.documentId,
        name: entry.name,
        pageNumber: null,
        excerpt: categoryLabels[entry.category].replace(' ', '・'),
      })
      return
    }
    entry.pages.forEach((page) => {
      const searchableText = `${metadataText} ${page.normalizedText}`
      if (!terms.every((term) => searchableText.includes(term))) return
      results.push({
        documentId: entry.documentId,
        name: entry.name,
        pageNumber: page.pageNumber,
        excerpt: createExcerpt(page.text),
      })
    })
  })
  return results.slice(0, 100)
}

export const useDocumentSearchStore = defineStore('documentSearch', () => {
  const query = ref('')
  const results = ref<DocumentSearchResult[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  let loadSequence = 0

  async function loadCurrentIndex(): Promise<DocumentSearchIndexArtifact> {
    const spaceId = useSpaceStore().currentSpaceId
    if (!spaceId) throw new Error('書類を検索するスペースが選択されていません')
    const sequence = ++loadSequence
    try {
      const access = await getDocumentSearchIndexApi(spaceId)
      let artifact: DocumentSearchIndexArtifact | null = null
      try {
        artifact = await getCachedDocumentSearchIndex(spaceId)
      } catch {
        // IndexedDBを利用できない環境でも、その場で取得して検索を継続する
      }
      if (!artifact || artifact.version !== access.version) {
        artifact = await downloadDocumentSearchIndex(access.url)
        if (artifact.spaceId !== spaceId || artifact.version !== access.version) {
          throw new Error('書類検索データが選択中のスペースと一致しません')
        }
        try {
          await putCachedDocumentSearchIndex(artifact)
        } catch {
          // キャッシュ保存失敗は検索自体の失敗にしない
        }
      }
      if (sequence !== loadSequence || useSpaceStore().currentSpaceId !== spaceId) {
        throw new Error('検索中に家族スペースが切り替わりました')
      }
      return artifact
    } catch (loadError) {
      try {
        await deleteCachedDocumentSearchIndex(spaceId)
      } catch {
        // 失効キャッシュを削除できない場合も、メモリ上では利用しない
      }
      throw loadError
    }
  }

  async function search(value: string): Promise<void> {
    query.value = value
    error.value = null
    if (!normalizeDocumentSearchQuery(value)) {
      results.value = []
      return
    }
    loading.value = true
    try {
      const artifact = await loadCurrentIndex()
      if (query.value !== value) return
      results.value = searchArtifact(artifact, value)
    } catch (searchError) {
      if (query.value !== value) return
      results.value = []
      error.value = searchError instanceof Error
        ? searchError.message
        : '書類を検索できませんでした'
    } finally {
      if (query.value === value) loading.value = false
    }
  }

  function reset(): void {
    loadSequence++
    query.value = ''
    results.value = []
    loading.value = false
    error.value = null
  }

  return { query, results, loading, error, search, reset }
})
