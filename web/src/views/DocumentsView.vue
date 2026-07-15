<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useDocumentsStore } from '@/stores/documents'
import { useSpaceStore } from '@/stores/space'
import type { FamilyDocument } from '@/types'
import type { DocumentTextResult } from '@/services/documentService'
import DocumentSearch from '@/components/documents/DocumentSearch.vue'
import DocumentSuggestions from '@/components/documents/DocumentSuggestions.vue'
import type { DocumentSearchResult } from '@/stores/documentSearch'
import type { UpdateDocumentSuggestionInput } from '@/stores/documents'

const documentsStore = useDocumentsStore()
const spaceStore = useSpaceStore()
const router = useRouter()
const documentInput = ref<HTMLInputElement | null>(null)
const uploadDestinationOpen = ref(false)
const uploadTargetSpaceId = ref('')
const viewMode = ref<'documents' | 'trash'>('documents')
const mutatingDocumentId = ref<string | null>(null)
const accessUrl = ref<string | null>(null)
const accessLoading = ref(false)
const accessError = ref<string | null>(null)
const textResult = ref<DocumentTextResult | null>(null)
const textLoading = ref(false)
const textRetrying = ref(false)
const suggestionsReanalyzing = ref(false)
const textError = ref<string | null>(null)
let accessSequence = 0
let textSequence = 0
let pendingSearchPage: number | null = null

const selectedDocument = computed(() => documentsStore.selectedDocument)
const visibleDocuments = computed(() => documentsStore.documents.filter((document) => (
  viewMode.value === 'trash' ? document.status === 'trashed' : document.status !== 'trashed'
)))
const trashedDocumentCount = computed(() => documentsStore.documents.filter(
  (document) => document.status === 'trashed'
).length)
const currentMembership = computed(() => spaceStore.memberships.find(
  (membership) => membership.spaceId === spaceStore.currentSpaceId
))
const isCurrentSpaceOwner = computed(() => currentMembership.value?.role === 'owner')
const currentSpaceLabel = computed(() => formatSpaceLabel(spaceStore.currentSpaceId))
const usageTotalBytes = computed(() => (
  (documentsStore.usage?.originalBytes ?? 0) + (documentsStore.usage?.derivedBytes ?? 0)
))
const usagePercent = computed(() => {
  const limitBytes = documentsStore.usage?.limitBytes ?? 0
  if (limitBytes <= 0) return 0
  return Math.min(100, usageTotalBytes.value / limitBytes * 100)
})
const isAtCapacity = computed(() => {
  const usage = documentsStore.usage
  return !!usage && usageTotalBytes.value >= usage.limitBytes
})
const isAtWarning = computed(() => {
  const usage = documentsStore.usage
  return !!usage && usageTotalBytes.value >= usage.warningBytes
})
const canPreviewSelectedDocument = computed(() => (
  !!selectedDocument.value
  && selectedDocument.value.integrityStatus !== 'missing_original'
  && ['uploaded', 'processing', 'ready', 'trashed'].includes(selectedDocument.value.status)
))
const selectedPreviewType = computed<'image' | 'pdf' | 'other'>(() => {
  const mimeType = selectedDocument.value?.mimeType ?? ''
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'pdf'
  return 'other'
})

const categoryLabels: Record<FamilyDocument['category'], string> = {
  school_childcare: '学校・保育',
  medical: '医療',
  insurance_tax: '保険・税',
  home_warranty: '住居・保証',
  billing_receipt: '請求・領収',
  contact: '連絡先',
  other: '未分類',
}

const statusLabels: Record<FamilyDocument['status'], string> = {
  uploading: 'アップロード中',
  uploaded: '保存済み',
  processing: '解析中',
  ready: '準備完了',
  failed: '処理失敗',
  trashed: 'ごみ箱',
}

const ocrStatusLabels: Record<FamilyDocument['ocrStatus'], string> = {
  pending: '読み取り待ち',
  processing: '読み取り中',
  completed: '読み取り完了',
  failed: '読み取り失敗',
  skipped: '外部OCR未実行',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatDate(document: FamilyDocument): string {
  const date = document.createdAt?.toDate?.()
  return date ? date.toLocaleString('ja-JP') : ''
}

function openInput(input: HTMLInputElement | null): void {
  input?.click()
}

function formatSpaceLabel(spaceId: string | null): string {
  if (!spaceId) return '未選択'
  if (spaceId.startsWith('personal_')) return '個人'
  const membership = spaceStore.memberships.find((item) => item.spaceId === spaceId)
  return membership?.displayName ? `${membership.displayName}（家族）` : '家族'
}

function openUploadDestination(): void {
  uploadTargetSpaceId.value = spaceStore.currentSpaceId ?? spaceStore.memberships[0]?.spaceId ?? ''
  uploadDestinationOpen.value = true
}

function openUploadFilePicker(): void {
  const spaceId = uploadTargetSpaceId.value
  if (!spaceId) return
  if (spaceId !== spaceStore.currentSpaceId) {
    spaceStore.selectSpace(spaceId)
  }
  uploadDestinationOpen.value = false
  openInput(documentInput.value)
}

function handleSpaceSelection(event: Event): void {
  const spaceId = (event.target as HTMLSelectElement).value
  if (spaceId && spaceId !== spaceStore.currentSpaceId) {
    spaceStore.selectSpace(spaceId)
  }
}

async function handleFileSelection(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    input.value = ''
    return
  }

  try {
    await documentsStore.addDocument(file, 'file')
  } catch {
    // Storeのエラーを画面に表示する
  } finally {
    input.value = ''
  }
}

async function loadSelectedAccessUrl(document: FamilyDocument | null): Promise<void> {
  const sequence = ++accessSequence
  accessUrl.value = null
  accessError.value = null
  if (!document
    || document.integrityStatus === 'missing_original'
    || !['uploaded', 'processing', 'ready', 'trashed'].includes(document.status)) return

  accessLoading.value = true
  try {
    const result = await documentsStore.getAccessUrl(document.id)
    if (sequence !== accessSequence) return
    accessUrl.value = result.url
  } catch (error) {
    if (sequence !== accessSequence) return
    accessError.value = error instanceof Error ? error.message : '原本を開けませんでした'
  } finally {
    if (sequence === accessSequence) accessLoading.value = false
  }
}

async function loadSelectedText(document: FamilyDocument | null): Promise<void> {
  const sequence = ++textSequence
  textResult.value = null
  textError.value = null
  if (!document?.ocrObjectKey) return

  textLoading.value = true
  try {
    const result = await documentsStore.getText(document.id)
    if (sequence !== textSequence) return
    textResult.value = result
  } catch (error) {
    if (sequence !== textSequence) return
    textError.value = error instanceof Error ? error.message : '読み取った文字を取得できませんでした'
  } finally {
    if (sequence === textSequence) textLoading.value = false
  }
}

async function retrySelectedText(): Promise<void> {
  const document = selectedDocument.value
  if (!document || textRetrying.value) return
  textRetrying.value = true
  textError.value = null
  try {
    await documentsStore.retryText(document.id)
  } catch (error) {
    textError.value = error instanceof Error ? error.message : '文字を再読み取りできませんでした'
  } finally {
    textRetrying.value = false
  }
}

function selectDocument(documentId: string): void {
  documentsStore.selectDocument(documentId)
}

async function scrollToSearchPage(pageNumber: number): Promise<void> {
  await nextTick()
  globalThis.document.getElementById(`document-text-page-${pageNumber}`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  })
}

function selectSearchResult(result: DocumentSearchResult): void {
  pendingSearchPage = result.pageNumber
  if (selectedDocument.value?.id === result.documentId && textResult.value && result.pageNumber) {
    pendingSearchPage = null
    void scrollToSearchPage(result.pageNumber)
    return
  }
  documentsStore.selectDocument(result.documentId)
}

function openSuggestionPage(pageNumber: number): void {
  if (accessUrl.value) {
    const url = selectedPreviewType.value === 'pdf'
      ? `${accessUrl.value}#page=${pageNumber}`
      : accessUrl.value
    window.open(url, '_blank', 'noopener')
    return
  }
  void scrollToSearchPage(pageNumber)
}

async function saveSuggestion(
  suggestionId: string,
  input: UpdateDocumentSuggestionInput
): Promise<void> {
  const document = selectedDocument.value
  if (!document) return
  try {
    await documentsStore.updateSuggestion(document.id, suggestionId, input)
  } catch {
    // Storeのエラーを候補欄に表示する
  }
}

async function registerSuggestionCalendar(
  suggestionId: string,
  input: Omit<UpdateDocumentSuggestionInput, 'status'>
): Promise<void> {
  const document = selectedDocument.value
  if (!document) return
  try {
    await documentsStore.registerCalendarEvent(document.id, suggestionId, input)
  } catch {
    // Storeのエラーを候補欄に表示する
  }
}

async function reanalyzeSelectedSuggestions(): Promise<void> {
  const document = selectedDocument.value
  if (!document || suggestionsReanalyzing.value) return
  suggestionsReanalyzing.value = true
  try {
    await documentsStore.reanalyzeSuggestions(document.id)
  } catch {
    // Storeのエラーを候補欄に表示する
  } finally {
    suggestionsReanalyzing.value = false
  }
}

function closeDetail(): void {
  documentsStore.selectDocument(null)
}

async function createTaskFromSelectedDocument(): Promise<void> {
  const document = selectedDocument.value
  if (!document || document.status === 'trashed') return
  await router.push({
    name: 'home',
    query: {
      attachDocument: document.id,
      createFromDocument: '1',
    },
  })
}

function switchView(nextView: 'documents' | 'trash'): void {
  viewMode.value = nextView
  documentsStore.selectDocument(null)
}

async function moveSelectedToTrash(): Promise<void> {
  const document = selectedDocument.value
  if (!document) return
  mutatingDocumentId.value = document.id
  try {
    await documentsStore.moveToTrash(document.id)
  } catch {
    // Storeのエラーを画面に表示する
  } finally {
    mutatingDocumentId.value = null
  }
}

async function restoreSelectedDocument(): Promise<void> {
  const document = selectedDocument.value
  if (!document) return
  mutatingDocumentId.value = document.id
  try {
    await documentsStore.restoreFromTrash(document.id)
  } catch {
    // Storeのエラーを画面に表示する
  } finally {
    mutatingDocumentId.value = null
  }
}

async function permanentlyDeleteSelectedDocument(): Promise<void> {
  const document = selectedDocument.value
  if (!document || !isCurrentSpaceOwner.value) return
  if (!window.confirm(`「${document.name}」を完全に削除します。元に戻せません。`)) return
  mutatingDocumentId.value = document.id
  try {
    await documentsStore.permanentlyDelete(document.id)
  } catch {
    // Storeのエラーを画面に表示する
  } finally {
    mutatingDocumentId.value = null
  }
}

onMounted(async () => {
  await spaceStore.initSpace()
  documentsStore.subscribe()
})

onUnmounted(() => {
  accessSequence++
  textSequence++
  documentsStore.unsubscribe()
})

watch(
  () => spaceStore.currentSpaceId,
  (spaceId, previousSpaceId) => {
    if (!spaceId || spaceId === previousSpaceId) return
    documentsStore.subscribe()
  }
)

watch(selectedDocument, (document) => {
  void loadSelectedAccessUrl(document)
  void loadSelectedText(document)
  documentsStore.subscribeSuggestions(
    document && document.status !== 'trashed' ? document.id : null
  )
}, { immediate: true })

watch(textResult, async () => {
  if (!pendingSearchPage) return
  const pageNumber = pendingSearchPage
  pendingSearchPage = null
  await scrollToSearchPage(pageNumber)
})
</script>

<template>
  <div class="min-h-screen bg-slate-100 text-slate-800">
    <header class="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div class="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
        <div class="flex min-w-0 items-center gap-3">
          <button
            class="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
            @click="router.push({ name: 'home' })"
          >
            ← Todo
          </button>
          <div class="min-w-0">
            <h1 class="truncate text-lg font-semibold">書類ボックス</h1>
            <label class="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
              表示中
              <select
                :value="spaceStore.currentSpaceId ?? ''"
                aria-label="書類を表示するスペース"
                class="max-w-52 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-600"
                @change="handleSpaceSelection"
              >
                <option
                  v-for="membership in spaceStore.memberships"
                  :key="membership.spaceId"
                  :value="membership.spaceId"
                >{{ formatSpaceLabel(membership.spaceId) }}</option>
              </select>
            </label>
          </div>
        </div>
        <div class="hidden items-center gap-2 sm:flex">
          <button
            class="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            :disabled="isAtCapacity || viewMode === 'trash'"
            @click="openUploadDestination"
          >書類・写真を追加</button>
        </div>
      </div>
    </header>

    <input ref="documentInput" data-testid="document-input" class="hidden" type="file" accept="image/*,application/pdf,.pdf" @change="handleFileSelection" />

    <div
      v-if="uploadDestinationOpen"
      data-testid="upload-destination-dialog"
      class="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      @click.self="uploadDestinationOpen = false"
    >
      <div class="w-full max-w-sm rounded-2xl bg-white p-4 shadow-xl">
        <h2 class="font-semibold text-slate-800">書類の保存先</h2>
        <p class="mt-1 text-sm text-slate-500">個人と家族では別の書類として保存されます。</p>
        <label class="mt-4 block text-sm font-medium text-slate-700">
          保存先
          <select
            v-model="uploadTargetSpaceId"
            data-testid="upload-destination-select"
            class="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option
              v-for="membership in spaceStore.memberships"
              :key="membership.spaceId"
              :value="membership.spaceId"
            >{{ formatSpaceLabel(membership.spaceId) }}</option>
          </select>
        </label>
        <p class="mt-2 text-xs text-slate-500">
          個人は自分だけ、家族は家族スペースのメンバーが利用できます。
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" class="px-3 py-2 text-sm text-slate-600" @click="uploadDestinationOpen = false">キャンセル</button>
          <button
            type="button"
            data-testid="choose-upload-file"
            :disabled="!uploadTargetSpaceId"
            class="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
            @click="openUploadFilePicker"
          >ファイルを選ぶ</button>
        </div>
      </div>
    </div>

    <main class="mx-auto grid max-w-7xl gap-4 p-3 sm:p-4 md:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.6fr)]">
      <section class="min-h-[60vh] rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div class="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 class="font-medium">{{ viewMode === 'trash' ? 'ごみ箱' : '書類' }}</h2>
            <p class="text-xs text-slate-500">{{ visibleDocuments.length }}件</p>
          </div>
          <div v-if="documentsStore.uploading" class="text-right text-xs text-blue-600">
            <div>保存中...</div>
            <div class="max-w-36 truncate text-slate-500">{{ documentsStore.uploadFileName }}</div>
          </div>
        </div>

        <div class="border-b border-slate-100 px-3 pt-3">
          <div class="grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm">
            <button class="rounded-md px-3 py-2" :class="viewMode === 'documents' ? 'bg-white font-medium shadow-sm' : 'text-slate-500'" @click="switchView('documents')">書類</button>
            <button class="rounded-md px-3 py-2" :class="viewMode === 'trash' ? 'bg-white font-medium shadow-sm' : 'text-slate-500'" @click="switchView('trash')">ごみ箱<span v-if="trashedDocumentCount">（{{ trashedDocumentCount }}）</span></button>
          </div>
          <div v-if="documentsStore.usage" class="py-3">
            <div class="flex justify-between text-xs text-slate-500">
              <span>使用量 {{ formatBytes(usageTotalBytes) }}</span>
              <span>上限 {{ formatBytes(documentsStore.usage.limitBytes) }}</span>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div class="h-full rounded-full" :class="isAtWarning ? 'bg-amber-500' : 'bg-blue-500'" :style="{ width: `${usagePercent}%` }" />
            </div>
            <p v-if="isAtWarning && !isAtCapacity" class="mt-2 text-xs text-amber-700">容量が警告値に達しています。不要な書類はごみ箱から完全削除してください。</p>
          </div>
        </div>

        <div v-if="viewMode === 'documents'" class="border-b border-slate-100 p-3 sm:hidden">
          <button class="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300" :disabled="isAtCapacity" @click="openUploadDestination">書類・写真を追加</button>
          <p class="mt-1 text-center text-xs text-slate-500">追加時に個人／家族を選べます</p>
        </div>

        <DocumentSearch v-if="viewMode === 'documents'" @select="selectSearchResult" />

        <p v-if="isAtCapacity" class="m-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">容量上限に達したため、新しい書類を追加できません。ごみ箱の書類を完全削除すると空き容量が増えます。</p>

        <p v-if="documentsStore.error" class="m-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ documentsStore.error }}
        </p>
        <div v-if="documentsStore.loading" class="p-8 text-center text-sm text-slate-500">読み込み中...</div>
        <div v-else-if="visibleDocuments.length === 0" class="flex flex-col items-center px-6 py-16 text-center">
          <div class="mb-3 text-4xl">📄</div>
          <h3 class="font-medium">{{ viewMode === 'trash' ? 'ごみ箱は空です' : 'まだ書類がありません' }}</h3>
          <p v-if="viewMode === 'documents'" class="mt-1 text-sm text-slate-500">撮影、フォトライブラリ、ファイル、Google Driveから追加できます。</p>
        </div>
        <ul v-else class="divide-y divide-slate-100">
          <li v-for="document in visibleDocuments" :key="document.id">
            <div
              role="button"
              tabindex="0"
              class="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
              :class="document.id === documentsStore.selectedDocumentId ? 'bg-blue-50' : ''"
              @click="selectDocument(document.id)"
              @keydown.enter="selectDocument(document.id)"
            >
              <div class="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-xl">
                <img
                  v-if="documentsStore.thumbnailUrls[document.id]"
                  :src="documentsStore.thumbnailUrls[document.id]"
                  :alt="`${document.name}のサムネイル`"
                  class="h-full w-full object-cover"
                  @error="documentsStore.reloadThumbnail(document.id)"
                />
                <span v-else>{{ document.mimeType.startsWith('image/') ? '🖼️' : document.mimeType === 'application/pdf' ? '📕' : '📄' }}</span>
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">{{ document.name }}</div>
                <div class="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-slate-500">
                  <span>{{ currentSpaceLabel }}</span>
                  <span>{{ categoryLabels[document.category] }}</span>
                  <span>{{ formatBytes(document.sizeBytes) }}</span>
                  <span :class="document.status === 'failed' || document.integrityStatus === 'missing_original' ? 'text-red-600' : ''">{{ document.integrityStatus === 'missing_original' ? '原本を確認できません' : statusLabels[document.status] }}</span>
                </div>
                <button
                  v-if="document.previewStatus === 'failed' && (document.mimeType.startsWith('image/') || document.mimeType === 'application/pdf')"
                  class="mt-1 text-xs font-medium text-blue-600 hover:underline"
                  @click.stop="documentsStore.retryThumbnail(document.id)"
                >
                  サムネイルを再作成
                </button>
                <div class="mt-1 text-[11px] text-slate-400">{{ formatDate(document) }}</div>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section
        class="rounded-2xl border border-slate-200 bg-white shadow-sm"
        :class="selectedDocument ? 'fixed inset-0 z-30 overflow-y-auto md:static md:min-h-[60vh]' : 'hidden md:block md:min-h-[60vh]'"
      >
        <div v-if="selectedDocument" class="flex min-h-full flex-col">
          <div class="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div class="min-w-0">
              <h2 class="truncate font-medium">{{ selectedDocument.name }}</h2>
              <p class="mt-1 text-xs text-slate-500">{{ categoryLabels[selectedDocument.category] }}・{{ formatBytes(selectedDocument.sizeBytes) }}</p>
            </div>
            <button class="rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100 md:hidden" @click="closeDetail">閉じる</button>
          </div>

          <div class="flex-1 p-3 sm:p-4">
            <div v-if="selectedDocument.integrityStatus === 'missing_original'" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">
              保存先で原本を確認できませんでした。ごみ箱から完全削除するか、原本をもう一度追加してください。
            </div>
            <div v-else-if="!canPreviewSelectedDocument" class="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">
              {{ statusLabels[selectedDocument.status] }}です。保存完了後に原本を表示できます。
            </div>
            <div v-else-if="selectedPreviewType === 'pdf'">
              <div v-if="accessLoading" class="flex min-h-80 items-center justify-center text-sm text-slate-500">PDFを開く準備中...</div>
              <div v-else-if="accessError" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">{{ accessError }}</div>
              <div v-else-if="accessUrl" class="flex min-h-80 flex-col items-center justify-center text-center">
                <img
                  v-if="documentsStore.thumbnailUrls[selectedDocument.id]"
                  :src="documentsStore.thumbnailUrls[selectedDocument.id]"
                  :alt="`${selectedDocument.name}の表紙`"
                  class="max-h-64 max-w-full rounded-lg border border-slate-200 object-contain"
                />
                <div v-else class="text-6xl">📕</div>
                <p class="mt-4 text-sm text-slate-600">端末のPDFビューアで全ページを表示します。</p>
                <p v-if="selectedDocument.pageCount" class="mt-1 text-xs text-slate-500">{{ selectedDocument.pageCount }}ページ</p>
                <a
                  :href="accessUrl"
                  target="_blank"
                  rel="noopener"
                  class="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white"
                >PDFを開く</a>
              </div>
            </div>
            <div v-else>
              <div v-if="accessLoading" class="flex min-h-80 items-center justify-center text-sm text-slate-500">原本を読み込み中...</div>
              <div v-else-if="accessError" class="rounded-lg bg-red-50 p-4 text-sm text-red-700">{{ accessError }}</div>
              <img v-else-if="accessUrl && selectedPreviewType === 'image'" :src="accessUrl" :alt="selectedDocument.name" class="mx-auto max-h-[72vh] max-w-full rounded-lg object-contain" />
              <div v-else-if="accessUrl" class="flex min-h-80 flex-col items-center justify-center text-center">
                <div class="text-5xl">📎</div>
                <p class="mt-3 text-sm text-slate-600">この形式はブラウザ内プレビューに対応していません。</p>
                <a :href="accessUrl" target="_blank" rel="noopener" class="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">原本を開く</a>
              </div>
            </div>

            <section data-testid="document-text-section" class="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
              <div class="flex items-center justify-between gap-3">
                <h3 class="text-sm font-medium text-slate-800">読み取った文字</h3>
                <span
                  class="rounded-full px-2 py-1 text-[11px]"
                  :class="selectedDocument.ocrStatus === 'completed'
                    ? 'bg-green-100 text-green-700'
                    : selectedDocument.ocrStatus === 'failed'
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'"
                >{{ ocrStatusLabels[selectedDocument.ocrStatus] }}</span>
              </div>

              <p v-if="selectedDocument.ocrStatus === 'pending' || selectedDocument.ocrStatus === 'processing'" class="mt-3 text-sm text-slate-600">
                書類から文字を読み取っています。
              </p>
              <p v-else-if="textLoading" class="mt-3 text-sm text-slate-500">読み取った文字を取得中...</p>
              <p v-else-if="textError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ textError }}</p>

              <div v-else-if="textResult?.pages.length" class="mt-3 space-y-3">
                <p
                  v-if="textResult.pendingExternalOcrPageNumbers.length"
                  class="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"
                >
                  {{ textResult.pendingExternalOcrPageNumbers.join('、') }}ページ目は外部OCRが未実行です。
                </p>
                <article
                  v-for="page in textResult.pages"
                  :id="`document-text-page-${page.pageNumber}`"
                  :key="page.pageNumber"
                  class="rounded-lg border border-slate-200 bg-white px-3 py-3"
                >
                  <div class="mb-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{{ page.pageNumber }}ページ</span>
                    <span>{{ page.source === 'pdf_text' ? 'PDF内の文字' : '画像OCR' }}</span>
                  </div>
                  <p v-if="page.text" class="whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{{ page.text }}</p>
                  <p v-else class="text-sm text-slate-400">文字を取得できませんでした。</p>
                </article>
              </div>
              <p v-else-if="selectedDocument.ocrStatus === 'skipped'" class="mt-3 text-sm text-slate-600">
                写真またはスキャン書類の外部OCRは実行されていません。設定で文字読み取りを有効にすると再実行できます。
              </p>
              <p v-else-if="selectedDocument.ocrStatus === 'failed'" class="mt-3 text-sm text-red-700">
                {{ selectedDocument.ocrError || '文字読み取りに失敗しました。' }}
              </p>
              <p v-else class="mt-3 text-sm text-slate-500">読み取れる文字はありませんでした。</p>

              <button
                v-if="selectedDocument.status !== 'trashed' && ['failed', 'skipped'].includes(selectedDocument.ocrStatus)"
                type="button"
                :disabled="textRetrying"
                class="mt-3 w-full rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm font-medium text-blue-700 disabled:opacity-50"
                @click="retrySelectedText"
              >{{ textRetrying ? '再読み取り中...' : '文字を再読み取り' }}</button>
            </section>

            <DocumentSuggestions
              v-if="selectedDocument.status !== 'trashed' && selectedDocument.classificationVersion != null"
              :suggestions="documentsStore.suggestions"
              :loading="documentsStore.suggestionsLoading"
              :error="documentsStore.suggestionsError"
              :saving-ids="documentsStore.suggestionSavingIds"
              :reanalyzing="suggestionsReanalyzing"
              @save="saveSuggestion"
              @register-calendar="registerSuggestionCalendar"
              @reanalyze="reanalyzeSelectedSuggestions"
              @open-page="openSuggestionPage"
            />
          </div>
          <div class="border-t border-slate-100 p-4">
            <div v-if="selectedDocument.status !== 'trashed'" class="space-y-2">
              <button
                class="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                :disabled="mutatingDocumentId === selectedDocument.id"
                @click="createTaskFromSelectedDocument"
              >この書類からタスクを作成</button>
              <button
                class="w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
                :disabled="mutatingDocumentId === selectedDocument.id"
                @click="moveSelectedToTrash"
              >ごみ箱へ移動</button>
            </div>
            <div v-else class="space-y-2">
              <button
                class="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                :disabled="mutatingDocumentId === selectedDocument.id || selectedDocument.deletionStatus === 'processing'"
                @click="restoreSelectedDocument"
              >復元する</button>
              <button
                v-if="isCurrentSpaceOwner"
                class="w-full rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
                :disabled="mutatingDocumentId === selectedDocument.id || selectedDocument.deletionStatus === 'processing'"
                @click="permanentlyDeleteSelectedDocument"
              >完全に削除</button>
              <p v-if="selectedDocument.deletionStatus === 'failed'" class="text-xs text-red-600">{{ selectedDocument.deletionError || '完全削除に失敗しました。もう一度実行できます。' }}</p>
              <p v-else-if="!isCurrentSpaceOwner" class="text-center text-xs text-slate-500">完全削除は家族スペースの所有者だけが実行できます。</p>
            </div>
          </div>
        </div>
        <div v-else class="flex min-h-[60vh] flex-col items-center justify-center p-8 text-center text-slate-400">
          <div class="text-4xl">🔍</div>
          <p class="mt-3 text-sm">左の一覧から書類を選択してください</p>
        </div>
      </section>
    </main>
  </div>
</template>
